//! Rebase: PDFium (EmbedPDF) saves by rewriting the whole file. To keep the user's original
//! bytes and any signatures intact we load both files, compare objects *by object number*,
//! and append only the objects PDFium changed or added as one incremental update on top
//! of the ORIGINAL bytes.
//!
//! Assumptions (see ADR 0003):
//! * PDFium's non-incremental save keeps the object numbers it parsed and gives new objects
//!   numbers above the old maximum. We verify this: if the catalog number differs, or a page
//!   of the edited file has a number that in the original belongs to a non-page object, the
//!   numbering is declared unstable and *every* object of the edited file is appended (the
//!   result is still an incremental update over the original bytes, just a larger one).
//! * Objects missing from the edited file are freed only if nothing in the merged document
//!   references them any more; object-stream containers are never freed (earlier xref
//!   sections locate compressed objects through them).
//! * If the original is encrypted and the edited file is not, PDFium dropped the security on
//!   save: appended objects are re-encrypted with the original file key. If the edited file
//!   is encrypted with a *different* key, the user changed the protection in the viewer:
//!   that is a whole rewrite by definition and the edited bytes are returned unchanged.

use crate::compare::objects_equal;
use crate::error::{PdfError, Result};
use crate::pages;
use crate::pdf::for_each_ref;
use crate::Pdf;
use lopdf::{Object, ObjectId};
use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};

/// How the rebased bytes were produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RebaseMode {
    /// An incremental update was appended to the original bytes.
    Incremental,
    /// Nothing changed: the original bytes are returned.
    Unchanged,
    /// The protection changed in the editor: the edited bytes are returned as-is.
    ProtectionChanged,
}

/// Result of [`rebase_pdf`].
#[derive(Debug, Clone)]
pub struct RebaseReport {
    /// Output bytes.
    pub bytes: Vec<u8>,
    /// How they were produced.
    pub mode: RebaseMode,
    /// Objects that existed in the original and were appended with new content.
    pub changed: Vec<ObjectId>,
    /// Objects that are new.
    pub added: Vec<ObjectId>,
    /// Objects freed in the update.
    pub deleted: Vec<ObjectId>,
    /// Whether the editor renumbered objects (fallback: every object appended).
    pub renumbered: bool,
}

fn is_container(o: &Object) -> bool {
    matches!(o, Object::Stream(s) if s.dict.has_type(b"ObjStm") || s.dict.has_type(b"XRef"))
}

/// Rebase unencrypted (or empty-user-password) files. See [`rebase_pdf`].
pub fn rebase(original: &[u8], edited_by_pdfium: &[u8]) -> Result<Vec<u8>> {
    let orig = Pdf::open(original.to_vec(), None)?;
    Ok(rebase_pdf(&orig, edited_by_pdfium)?.bytes)
}

fn renumbered(orig: &Pdf, edited: &Pdf) -> bool {
    if orig.root_id().ok() != edited.root_id().ok() {
        return true;
    }
    let Ok(ed_pages) = pages::flatten(edited) else {
        return true;
    };
    ed_pages.iter().any(|p| match orig.get_dict(p.id) {
        Some(d) => !d.has_type(b"Page"),
        // Page numbers not in the original are new pages: fine.
        None => orig
            .objects()
            .keys()
            .any(|k| k.0 == p.id.0 && k.1 != p.id.1),
    })
}

/// Rebase `edited` (a whole-file save of `orig`, possibly decrypted) onto `orig`'s bytes.
pub fn rebase_pdf(orig: &Pdf, edited: &[u8]) -> Result<RebaseReport> {
    let limits = *orig.limits();
    let ed = match Pdf::open_with_limits(edited.to_vec(), Some(orig.password()), limits) {
        Ok(p) => p,
        Err(PdfError::WrongPassword) | Err(PdfError::PasswordRequired) => {
            return Ok(RebaseReport {
                bytes: edited.to_vec(),
                mode: RebaseMode::ProtectionChanged,
                changed: vec![],
                added: vec![],
                deleted: vec![],
                renumbered: false,
            })
        }
        Err(e) => return Err(e),
    };
    let protection_changed = match (orig.security(), ed.security()) {
        (Some(a), Some(b)) => !a.same_key(b),
        (None, Some(_)) => true,
        _ => false,
    };
    if protection_changed {
        return Ok(RebaseReport {
            bytes: edited.to_vec(),
            mode: RebaseMode::ProtectionChanged,
            changed: vec![],
            added: vec![],
            deleted: vec![],
            renumbered: false,
        });
    }
    let renum = renumbered(orig, &ed);
    let orig_by_num: BTreeMap<u32, (ObjectId, &Object)> = orig
        .objects()
        .iter()
        .map(|(id, o)| (id.0, (*id, o)))
        .collect();

    let mut write: BTreeMap<ObjectId, Object> = BTreeMap::new();
    let mut changed = Vec::new();
    let mut added = Vec::new();
    for (&id, obj) in ed.objects() {
        if is_container(obj) {
            continue;
        }
        match orig_by_num.get(&id.0) {
            Some((oid, oobj)) => {
                if !renum && *oid == id && objects_equal(oobj, obj, &limits) {
                    continue;
                }
                changed.push(id);
            }
            None => added.push(id),
        }
        write.insert(id, obj.clone());
    }

    let root = ed.trailer().get(b"Root").ok().cloned();
    let info = ed.trailer().get(b"Info").ok().cloned();
    let trailer_changed = root != orig.trailer().get(b"Root").ok().cloned()
        || info != orig.trailer().get(b"Info").ok().cloned();

    // Free original objects that the edited file dropped and nothing references any more.
    let ed_nums: HashSet<u32> = ed.objects().keys().map(|k| k.0).collect();
    let mut reachable: HashSet<u32> = HashSet::new();
    let mut queue: VecDeque<ObjectId> = VecDeque::new();
    for o in [&root, &info].into_iter().flatten() {
        if let Object::Reference(r) = o {
            queue.push_back(*r);
        }
    }
    while let Some(id) = queue.pop_front() {
        if !reachable.insert(id.0) {
            continue;
        }
        if reachable.len() > limits.max_objects {
            return Err(PdfError::Limit("too many reachable objects".into()));
        }
        let obj = write.get(&id).or_else(|| orig.get(id));
        if let Some(o) = obj {
            for_each_ref(o, 0, &limits, &mut |r| queue.push_back(r))?;
        }
    }
    let deleted: BTreeSet<ObjectId> = orig
        .objects()
        .iter()
        .filter(|(id, o)| {
            !ed_nums.contains(&id.0) && !reachable.contains(&id.0) && !is_container(o)
        })
        .map(|(id, _)| *id)
        .collect();

    if write.is_empty() && deleted.is_empty() && !trailer_changed {
        return Ok(RebaseReport {
            bytes: orig.bytes().to_vec(),
            mode: RebaseMode::Unchanged,
            changed,
            added,
            deleted: vec![],
            renumbered: renum,
        });
    }
    let bytes = orig.build_update_with_trailer(&write, &deleted, root, info)?;
    Ok(RebaseReport {
        bytes,
        mode: RebaseMode::Incremental,
        changed,
        added,
        deleted: deleted.into_iter().collect(),
        renumbered: renum,
    })
}
