//! `Pdf`: a loaded (and, if needed, decrypted) document plus the exact bytes it came from.
//! Edits are recorded as dirty/deleted object ids and written as incremental updates that
//! append to the original bytes; the full-rewrite path garbage-collects and renumbers.

use crate::crypt::{PermissionFlags, SecurityHandler};
use crate::error::{PdfError, Result};
use crate::limits::Limits;
use crate::serialize::write_indirect;
use crate::writer::{
    new_id_element, write_new_file, write_xref_stream, write_xref_table, XrefKind, XrefRow,
};
use crate::xrefscan;
use lopdf::xref::{XrefEntry, XrefType};
use lopdf::{Dictionary, Document, LoadOptions, Object, ObjectId, ObjectStream};
use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};

/// The name `/Encrypt` is renamed to (same length) so lopdf loads raw ciphertext objects.
const MASKED_ENCRYPT: &[u8] = b"/Wncrypt";
/// Type given to object streams while they are still encrypted.
const HIDDEN_OBJSTM: &[u8] = b"WarraqEncObjStm";

/// What protection a full rewrite writes.
#[derive(Clone)]
pub enum Protection {
    /// Same security handler and file key as the loaded document (or none if it had none).
    Keep,
    /// No encryption.
    Remove,
    /// New protection (e.g. `SecurityHandler::new_aes256`).
    New(SecurityHandler),
}

/// A loaded PDF document.
pub struct Pdf {
    bytes: Vec<u8>,
    doc: Document,
    security: Option<SecurityHandler>,
    encrypt_entry: Option<Object>,
    encrypt_ref: Option<ObjectId>,
    xref_kind: XrefKind,
    prev_xref: Option<usize>,
    size: u32,
    password: String,
    limits: Limits,
    dirty: BTreeSet<ObjectId>,
    deleted: BTreeSet<ObjectId>,
    trailer_dirty: bool,
}

impl std::fmt::Debug for Pdf {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pdf")
            .field("len", &self.bytes.len())
            .field("objects", &self.doc.objects.len())
            .field("encrypted", &self.security.is_some())
            .field("xref_kind", &self.xref_kind)
            .field("repaired", &self.prev_xref.is_none())
            .finish_non_exhaustive()
    }
}

fn is_regular(b: u8) -> bool {
    !(b.is_ascii_whitespace() || b"()<>[]{}/%".contains(&b))
}

/// Byte offset of `%PDF-` within the first KiB.
fn header_offset(bytes: &[u8]) -> Option<usize> {
    let head = bytes.get(..bytes.len().min(1024)).unwrap_or(bytes);
    head.windows(5).position(|w| w == b"%PDF-")
}

/// Positions of the `/Encrypt` name token (not `/EncryptMetadata`).
fn encrypt_token_positions(bytes: &[u8]) -> Vec<usize> {
    let pat = b"/Encrypt";
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(rel) = bytes
        .get(i..)
        .and_then(|s| s.windows(pat.len()).position(|w| w == pat))
    {
        let pos = i + rel;
        let next = bytes.get(pos + pat.len()).copied();
        if next.is_none_or(|b| !is_regular(b)) {
            out.push(pos);
        }
        i = pos + pat.len();
    }
    out
}

/// Load filter used for encrypted files: hides encrypted object streams from lopdf so it
/// keeps them as plain streams instead of failing to inflate ciphertext.
fn hide_objstm(id: ObjectId, obj: &mut Object) -> Option<(ObjectId, Object)> {
    if let Object::Stream(s) = obj {
        if s.dict.has_type(b"ObjStm") {
            s.dict.set("Type", Object::Name(HIDDEN_OBJSTM.to_vec()));
        }
        // The returned value is only used for object-stream members, which are never streams.
        return Some((id, Object::Null));
    }
    Some((id, obj.clone()))
}

fn load_lopdf(bytes: &[u8], masked: bool, limits: &Limits) -> Result<Document> {
    let opts = LoadOptions {
        password: None,
        filter: if masked { Some(hide_objstm) } else { None },
        strict: false,
        max_decompressed_size: Some(limits.max_decode_size),
    };
    Document::load_mem_with_options(bytes, opts).map_err(|e| PdfError::Parse(e.to_string()))
}

/// Walk every reference inside `obj` (bounded depth).
pub(crate) fn for_each_ref(
    obj: &Object,
    depth: usize,
    limits: &Limits,
    f: &mut dyn FnMut(ObjectId),
) -> Result<()> {
    limits.check_depth(depth)?;
    match obj {
        Object::Reference(id) => f(*id),
        Object::Array(a) => {
            for o in a {
                for_each_ref(o, depth + 1, limits, f)?;
            }
        }
        Object::Dictionary(d) => {
            for (_, v) in d.iter() {
                for_each_ref(v, depth + 1, limits, f)?;
            }
        }
        Object::Stream(s) => {
            for (_, v) in s.dict.iter() {
                for_each_ref(v, depth + 1, limits, f)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Replace every reference inside `obj` through `map` (bounded depth).
pub(crate) fn map_refs(
    obj: &mut Object,
    depth: usize,
    limits: &Limits,
    map: &mut dyn FnMut(ObjectId) -> Object,
) -> Result<()> {
    limits.check_depth(depth)?;
    match obj {
        Object::Reference(id) => *obj = map(*id),
        Object::Array(a) => {
            for o in a.iter_mut() {
                map_refs(o, depth + 1, limits, map)?;
            }
        }
        Object::Dictionary(d) => {
            for (_, v) in d.iter_mut() {
                map_refs(v, depth + 1, limits, map)?;
            }
        }
        Object::Stream(s) => {
            for (_, v) in s.dict.iter_mut() {
                map_refs(v, depth + 1, limits, map)?;
            }
        }
        _ => {}
    }
    Ok(())
}

impl Pdf {
    /// Open `bytes` with default limits. `password` may be the user or the owner password;
    /// `None` tries the empty user password.
    pub fn open(bytes: Vec<u8>, password: Option<&str>) -> Result<Pdf> {
        Self::open_with_limits(bytes, password, Limits::default())
    }

    /// Open with explicit limits.
    pub fn open_with_limits(bytes: Vec<u8>, password: Option<&str>, limits: Limits) -> Result<Pdf> {
        limits.check_file_size(bytes.len())?;
        let hdr = header_offset(&bytes).ok_or_else(|| PdfError::Parse("no %PDF- header".into()))?;
        let positions = encrypt_token_positions(&bytes);
        let mut encrypted = false;
        let mut synthetic = false;
        // lopdf reconstructs a broken xref itself, but only when some trailer with /Root
        // survives; for truncated files we add a synthetic one pointing at the catalog.
        let mut load = |input: &[u8], masked: bool| -> Result<Document> {
            match load_lopdf(input, masked, &limits) {
                Ok(d) => Ok(d),
                Err(e) => match xrefscan::with_synthetic_trailer(input) {
                    Some(fixed) => {
                        synthetic = true;
                        load_lopdf(&fixed, masked, &limits).map_err(|_| e)
                    }
                    None => Err(e),
                },
            }
        };
        let mut doc = if positions.is_empty() {
            load(&bytes, false)?
        } else {
            let mut masked = bytes.clone();
            for p in &positions {
                if let Some(slot) = masked.get_mut(*p..*p + MASKED_ENCRYPT.len()) {
                    slot.copy_from_slice(MASKED_ENCRYPT);
                }
            }
            let d = load(&masked, true)?;
            if d.trailer.has(b"Wncrypt") {
                encrypted = true;
                d
            } else {
                // `/Encrypt` appeared somewhere else (e.g. inside a stream): load untouched.
                load(&bytes, false)?
            }
        };
        if doc.objects.len() > limits.max_objects {
            return Err(PdfError::Limit(format!(
                "{} objects, the maximum is {}",
                doc.objects.len(),
                limits.max_objects
            )));
        }

        let mut security = None;
        let mut encrypt_entry = None;
        let mut encrypt_ref = None;
        if encrypted {
            let entry = doc
                .trailer
                .remove(b"Wncrypt")
                .ok_or_else(|| PdfError::Structure("lost /Encrypt".into()))?;
            let dict = match &entry {
                Object::Reference(id) => {
                    encrypt_ref = Some(*id);
                    doc.objects
                        .get(id)
                        .and_then(|o| o.as_dict().ok())
                        .cloned()
                        .ok_or_else(|| {
                            PdfError::Structure("missing encryption dictionary".into())
                        })?
                }
                Object::Dictionary(d) => d.clone(),
                _ => return Err(PdfError::Structure("bad /Encrypt entry".into())),
            };
            let id0 = match doc.trailer.get(b"ID") {
                Ok(Object::Array(a)) => match a.first() {
                    Some(Object::String(s, _)) => s.clone(),
                    _ => Vec::new(),
                },
                _ => Vec::new(),
            };
            let handler = SecurityHandler::open(&dict, &id0, password.unwrap_or(""))?;
            if let Some(r) = encrypt_ref {
                doc.objects.remove(&r);
            }
            let ids: Vec<ObjectId> = doc.objects.keys().copied().collect();
            let mut containers = Vec::new();
            for id in ids {
                if let Some(obj) = doc.objects.get_mut(&id) {
                    if let Object::Stream(s) = obj {
                        if s.dict.has_type(b"XRef") {
                            continue;
                        }
                        if s.dict.has_type(HIDDEN_OBJSTM) {
                            containers.push(id);
                        }
                    }
                    handler.decrypt_object(id, obj, &limits)?;
                }
            }
            for cid in containers {
                let members = match doc.objects.get_mut(&cid) {
                    Some(Object::Stream(s)) => {
                        s.dict.set("Type", Object::Name(b"ObjStm".to_vec()));
                        let cap = limits.decode_cap(s.content.len());
                        ObjectStream::new_with_limit(s, Some(cap))
                            .map(|os| os.objects)
                            .ok()
                    }
                    _ => None,
                };
                for (mid, mobj) in members.into_iter().flatten() {
                    let belongs = match doc.reference_table.get(mid.0) {
                        Some(XrefEntry::Compressed { container, .. }) => *container == cid.0,
                        _ => true,
                    };
                    if belongs {
                        doc.objects.entry(mid).or_insert(mobj);
                    }
                }
            }
            security = Some(handler);
            encrypt_entry = Some(entry);
        }

        let xref_kind = match doc.reference_table.cross_reference_type {
            XrefType::CrossReferenceStream => XrefKind::Stream,
            XrefType::CrossReferenceTable => XrefKind::Table,
        };
        // A usable /Prev needs a real xref section at a known absolute offset.
        let prev_xref = if hdr != 0 || doc.xref_start == 0 || synthetic {
            None
        } else {
            let at = bytes.get(doc.xref_start..).unwrap_or_default();
            let looks_ok = at.starts_with(b"xref") || at.first().is_some_and(u8::is_ascii_digit);
            looks_ok.then_some(doc.xref_start)
        };
        if let Some(start) = prev_xref {
            // lopdf ignores free entries: drop objects a later section freed.
            let freed = xrefscan::freed_numbers(&bytes, start, &doc, &limits);
            if !freed.is_empty() {
                doc.objects.retain(|id, _| !freed.contains(&id.0));
            }
        }
        let max_num = doc.objects.keys().next_back().map(|k| k.0).unwrap_or(0);
        let trailer_size = doc
            .trailer
            .get(b"Size")
            .and_then(Object::as_i64)
            .ok()
            .and_then(|s| u32::try_from(s).ok())
            .unwrap_or(0);
        let size = doc
            .reference_table
            .size
            .max(trailer_size)
            .max(max_num.saturating_add(1))
            .max(encrypt_ref.map(|r| r.0 + 1).unwrap_or(0))
            .max(1);
        Ok(Pdf {
            bytes,
            doc,
            security,
            encrypt_entry,
            encrypt_ref,
            xref_kind,
            prev_xref,
            size,
            password: password.unwrap_or("").to_string(),
            limits,
            dirty: BTreeSet::new(),
            deleted: BTreeSet::new(),
            trailer_dirty: false,
        })
    }

    /// The bytes this document was loaded from (the base of the next incremental update).
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Limits in force.
    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    /// The decrypted lopdf document (read-only).
    pub fn document(&self) -> &Document {
        &self.doc
    }

    /// The security handler, if the document is encrypted.
    pub fn security(&self) -> Option<&SecurityHandler> {
        self.security.as_ref()
    }

    /// The password the document was opened with.
    pub fn password(&self) -> &str {
        &self.password
    }

    /// Whether the document is encrypted.
    pub fn is_encrypted(&self) -> bool {
        self.security.is_some()
    }

    /// Effective permissions (all when unencrypted or opened with the owner password).
    pub fn permissions(&self) -> PermissionFlags {
        self.security
            .as_ref()
            .map(|s| s.effective_permissions())
            .unwrap_or_else(PermissionFlags::all)
    }

    /// Fail with `permission_denied` unless `check(perms)` holds.
    pub fn require(&self, what: &str, check: fn(&PermissionFlags) -> bool) -> Result<()> {
        if check(&self.permissions()) {
            Ok(())
        } else {
            Err(PdfError::Permission(format!(
                "the document's owner does not allow {what}; open it with the owner password"
            )))
        }
    }

    /// Cross-reference form of the latest section.
    pub fn xref_kind(&self) -> XrefKind {
        self.xref_kind
    }

    /// Whether the xref was reconstructed (broken file).
    pub fn was_repaired(&self) -> bool {
        self.prev_xref.is_none()
    }

    /// PDF header version.
    pub fn version(&self) -> &str {
        &self.doc.version
    }

    /// The (decrypted) trailer, without `/Encrypt`.
    pub fn trailer(&self) -> &Dictionary {
        &self.doc.trailer
    }

    /// All objects.
    pub fn objects(&self) -> &BTreeMap<ObjectId, Object> {
        &self.doc.objects
    }

    /// One object.
    pub fn get(&self, id: ObjectId) -> Option<&Object> {
        self.doc.objects.get(&id)
    }

    /// Follow references (bounded) until a direct object.
    pub fn resolve<'a>(&'a self, mut obj: &'a Object) -> Option<&'a Object> {
        for _ in 0..32 {
            match obj {
                Object::Reference(id) => obj = self.doc.objects.get(id)?,
                other => return Some(other),
            }
        }
        None
    }

    /// Dictionary of object `id` (or of its stream).
    pub fn get_dict(&self, id: ObjectId) -> Option<&Dictionary> {
        match self.doc.objects.get(&id)? {
            Object::Dictionary(d) => Some(d),
            Object::Stream(s) => Some(&s.dict),
            _ => None,
        }
    }

    /// Replace (or create) object `id`; it will be written in the next update.
    pub fn set(&mut self, id: ObjectId, obj: Object) {
        self.doc.objects.insert(id, obj);
        self.deleted.remove(&id);
        self.dirty.insert(id);
        self.size = self.size.max(id.0.saturating_add(1));
    }

    /// Add a new object under a fresh number.
    pub fn add(&mut self, obj: Object) -> ObjectId {
        let id = (self.size, 0);
        self.set(id, obj);
        id
    }

    /// Mark object `id` free in the next update.
    pub fn delete(&mut self, id: ObjectId) {
        if self.doc.objects.remove(&id).is_some() || self.dirty.contains(&id) {
            self.deleted.insert(id);
        }
        self.dirty.remove(&id);
    }

    /// The next unused object number.
    pub fn next_number(&self) -> u32 {
        self.size
    }

    /// Whether there are unsaved changes.
    pub fn has_changes(&self) -> bool {
        self.trailer_dirty || !self.dirty.is_empty() || !self.deleted.is_empty()
    }

    /// Ids changed since load / last commit.
    pub fn dirty_ids(&self) -> &BTreeSet<ObjectId> {
        &self.dirty
    }

    /// Ids deleted since load / last commit.
    pub fn deleted_ids(&self) -> &BTreeSet<ObjectId> {
        &self.deleted
    }

    /// The catalog id.
    pub fn root_id(&self) -> Result<ObjectId> {
        self.doc
            .trailer
            .get(b"Root")
            .and_then(Object::as_reference)
            .map_err(|_| PdfError::Structure("trailer has no /Root".into()))
    }

    /// The catalog dictionary.
    pub fn catalog(&self) -> Result<&Dictionary> {
        let id = self.root_id()?;
        self.get_dict(id)
            .ok_or_else(|| PdfError::Structure("catalog is not a dictionary".into()))
    }

    /// Set a trailer entry (Root / Info); written with the next update.
    pub fn set_trailer(&mut self, key: &str, value: Object) {
        self.doc.trailer.set(key, value);
        // An update is needed even if no object changed.
        self.trailer_dirty = true;
    }

    fn id_pair(&self) -> Result<Option<(Object, Object)>> {
        let first = match self.doc.trailer.get(b"ID") {
            Ok(Object::Array(a)) => a.first().cloned(),
            _ => None,
        };
        match first {
            Some(f) => Ok(Some((f, new_id_element()?))),
            // Encrypted files without /ID derived their key from an empty ID: keep it absent.
            None if self.security.is_some() => Ok(None),
            None => {
                let x = new_id_element()?;
                Ok(Some((x.clone(), x)))
            }
        }
    }

    /// Bytes of an incremental update carrying `objects` (plaintext; encrypted here with the
    /// document key) and freeing `deleted`, appended to the original bytes. The original is
    /// an exact prefix of the result.
    pub fn build_update(
        &self,
        objects: &BTreeMap<ObjectId, Object>,
        deleted: &BTreeSet<ObjectId>,
    ) -> Result<Vec<u8>> {
        let root = self.doc.trailer.get(b"Root").ok().cloned();
        let info = self.doc.trailer.get(b"Info").ok().cloned();
        self.build_update_with_trailer(objects, deleted, root, info)
    }

    /// Like [`Pdf::build_update`] with explicit trailer `/Root` and `/Info` values.
    pub fn build_update_with_trailer(
        &self,
        objects: &BTreeMap<ObjectId, Object>,
        deleted: &BTreeSet<ObjectId>,
        root: Option<Object>,
        info: Option<Object>,
    ) -> Result<Vec<u8>> {
        let mut out = self.bytes.clone();
        if !matches!(out.last(), Some(b'\n') | Some(b'\r')) {
            out.push(b'\n');
        }
        let mut rows: BTreeMap<u32, XrefRow> = BTreeMap::new();
        let repaired = self.prev_xref.is_none();
        let write_one = |out: &mut Vec<u8>,
                         rows: &mut BTreeMap<u32, XrefRow>,
                         id: ObjectId,
                         obj: &Object|
         -> Result<()> {
            let off = out.len();
            match &self.security {
                Some(sec) => {
                    let mut o = obj.clone();
                    sec.encrypt_object(id, &mut o, &self.limits)?;
                    write_indirect(out, id, &o)?;
                }
                None => write_indirect(out, id, obj)?,
            }
            rows.insert(id.0, XrefRow::InUse(off, id.1));
            Ok(())
        };
        if repaired {
            // No trustworthy earlier xref: append every live object with a complete table.
            rows.insert(0, XrefRow::Free(0, 65535));
            for (&id, obj) in &self.doc.objects {
                if let Object::Stream(s) = obj {
                    if s.dict.has_type(b"ObjStm") || s.dict.has_type(b"XRef") {
                        continue;
                    }
                }
                let o = objects.get(&id).unwrap_or(obj);
                write_one(&mut out, &mut rows, id, o)?;
            }
            for (&id, obj) in objects {
                if !self.doc.objects.contains_key(&id) {
                    write_one(&mut out, &mut rows, id, obj)?;
                }
            }
            if let (Some(r), Some(Object::Reference(_))) = (self.encrypt_ref, &self.encrypt_entry) {
                let off = out.len();
                if let Some(sec) = &self.security {
                    write_indirect(&mut out, r, &Object::Dictionary(sec.dict.clone()))?;
                    rows.insert(r.0, XrefRow::InUse(off, r.1));
                }
            }
        } else {
            for (&id, obj) in objects {
                write_one(&mut out, &mut rows, id, obj)?;
            }
        }
        for id in deleted {
            rows.entry(id.0)
                .or_insert_with(|| XrefRow::Free(0, id.1.saturating_add(1)));
        }
        let mut size = self
            .size
            .max(rows.keys().next_back().map(|k| k + 1).unwrap_or(0));
        let mut trailer = Dictionary::new();
        let root = root.ok_or_else(|| PdfError::Structure("no /Root for the update".into()))?;
        trailer.set("Root", root);
        if let Some(i) = info {
            trailer.set("Info", i);
        }
        if let Some((a, b)) = self.id_pair()? {
            trailer.set("ID", Object::Array(vec![a, b]));
        }
        if let Some(e) = &self.encrypt_entry {
            trailer.set("Encrypt", e.clone());
        }
        if let Some(prev) = self.prev_xref {
            trailer.set("Prev", Object::Integer(prev as i64));
        }
        if repaired || self.xref_kind == XrefKind::Table {
            trailer.set("Size", Object::Integer(i64::from(size)));
            write_xref_table(&mut out, &rows, &trailer)?;
        } else {
            let xid = (size, 0);
            size += 1;
            trailer.set("Size", Object::Integer(i64::from(size)));
            write_xref_stream(&mut out, &rows, &trailer, xid)?;
        }
        Ok(out)
    }

    /// Incremental update with all pending changes (does not modify `self`).
    pub fn save_incremental(&self) -> Result<Vec<u8>> {
        if !self.has_changes() {
            return Ok(self.bytes.clone());
        }
        let objects: BTreeMap<ObjectId, Object> = self
            .dirty
            .iter()
            .filter_map(|id| self.doc.objects.get(id).map(|o| (*id, o.clone())))
            .collect();
        self.build_update(&objects, &self.deleted)
    }

    /// Write pending changes as an incremental update, then reload from the result so the
    /// in-memory state is exactly what a reader of the new bytes sees. Returns the bytes.
    pub fn commit(&mut self) -> Result<Vec<u8>> {
        let out = if self.bytes.len() > crate::limits::FULL_REWRITE_THRESHOLD {
            self.write_full(Protection::Keep)?
        } else {
            self.save_incremental()?
        };
        self.replace_bytes(out.clone(), None)?;
        Ok(out)
    }

    /// Reload from `bytes` (e.g. after a full rewrite), optionally with a new password.
    pub fn replace_bytes(&mut self, bytes: Vec<u8>, password: Option<&str>) -> Result<()> {
        let pw = password
            .map(str::to_string)
            .unwrap_or_else(|| self.password.clone());
        let fresh = Pdf::open_with_limits(bytes, Some(&pw), self.limits)?;
        *self = fresh;
        Ok(())
    }

    /// Object ids reachable from the trailer's /Root and /Info (breadth-first order).
    pub fn reachable(&self) -> Result<Vec<ObjectId>> {
        let mut order = Vec::new();
        let mut seen = HashSet::new();
        let mut queue = VecDeque::new();
        for key in [b"Root".as_slice(), b"Info".as_slice()] {
            if let Ok(Object::Reference(id)) = self.doc.trailer.get(key) {
                queue.push_back(*id);
            }
        }
        while let Some(id) = queue.pop_front() {
            if Some(id) == self.encrypt_ref || !seen.insert(id) {
                continue;
            }
            let Some(obj) = self.doc.objects.get(&id) else {
                continue;
            };
            order.push(id);
            if order.len() > self.limits.max_objects {
                return Err(PdfError::Limit("too many reachable objects".into()));
            }
            for_each_ref(obj, 0, &self.limits, &mut |r| queue.push_back(r))?;
        }
        Ok(order)
    }

    /// Whole-file rewrite: garbage-collects unreachable objects, renumbers compactly,
    /// drops earlier revisions, and writes the requested protection.
    pub fn write_full(&self, protection: Protection) -> Result<Vec<u8>> {
        let order = self.reachable()?;
        let map: BTreeMap<ObjectId, ObjectId> = order
            .iter()
            .enumerate()
            .map(|(i, id)| (*id, ((i + 1) as u32, 0)))
            .collect();
        let mut objects = BTreeMap::new();
        for old in &order {
            let Some(obj) = self.doc.objects.get(old) else {
                continue;
            };
            let mut o = obj.clone();
            map_refs(&mut o, 0, &self.limits, &mut |r| {
                map.get(&r)
                    .map(|n| Object::Reference(*n))
                    .unwrap_or(Object::Null)
            })?;
            if let Some(new) = map.get(old) {
                objects.insert(*new, o);
            }
        }
        let root = map
            .get(&self.root_id()?)
            .copied()
            .ok_or_else(|| PdfError::Structure("catalog missing".into()))?;
        let info = self
            .doc
            .trailer
            .get(b"Info")
            .and_then(Object::as_reference)
            .ok()
            .and_then(|i| map.get(&i).copied());
        let (security, id) = match &protection {
            Protection::Keep => (self.security.clone(), self.id_pair()?),
            Protection::Remove => (None, None),
            Protection::New(h) => (Some(h.clone()), None),
        };
        let mut version = self.doc.version.clone();
        if let (Protection::New(h), Some(Object::Dictionary(cat))) =
            (&protection, objects.get_mut(&root))
        {
            if h.r >= 6 && version.as_str() < "2.0" {
                version = "1.7".into();
                let mut adbe = Dictionary::new();
                adbe.set("BaseVersion", Object::Name(b"1.7".to_vec()));
                adbe.set("ExtensionLevel", Object::Integer(8));
                let mut ext = Dictionary::new();
                ext.set("ADBE", Object::Dictionary(adbe));
                cat.set("Extensions", Object::Dictionary(ext));
            }
        }
        write_new_file(
            &version,
            &objects,
            root,
            info,
            id,
            security.as_ref(),
            XrefKind::Table,
            &self.limits,
        )
    }
}
