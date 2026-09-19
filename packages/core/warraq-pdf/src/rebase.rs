//! Another engine's changes to a document, kept as an update of it.
//!
//! EmbedPDF saves through PDFium, which writes a document whole: the file's
//! own bytes — and any signature over them — are gone, whatever changed.
//! PDFium keeps every object's number when it does, so the objects it wrote
//! differently are the changes, and the ones it added are new: `rebase`
//! appends just those to the file's own bytes, an incremental update, the
//! way Warraq saves its own edits.
use lopdf::{Dictionary, Object};

use crate::{PdfDocument, Result};

/// A stream of how the file is stored — an object stream, a cross-reference
/// stream — not of what it says.
fn storage_only(object: &Object) -> bool {
    matches!(
        object
            .as_stream()
            .ok()
            .and_then(|s| s.dict.get(b"Type").ok())
            .and_then(|t| t.as_name().ok()),
        Some(b"XRef" | b"ObjStm")
    )
}

/// The most a stream is decoded to, to compare it: past this, two streams
/// stored differently count as different (and the update keeps a copy).
const MAX_COMPARED: usize = 128 << 20;

/// A stream's bytes as they read: decoded, when it is stored encoded, up to
/// `limit`.
fn decoded(stream: &lopdf::Stream, limit: usize) -> Option<Vec<u8>> {
    if stream.dict.has(b"Filter") {
        stream.decompressed_content_with_limit(limit).ok()
    } else {
        Some(stream.content.clone())
    }
}

/// Whether two objects say the same thing. A stream is compared by its
/// dictionary, bar how it is stored, and its bytes — as stored when they
/// are stored alike, and decoded when not: PDFium compresses a stream it
/// finds uncompressed.
pub(crate) fn same(a: &Object, b: &Object) -> bool {
    let mut unbounded = usize::MAX;
    same_within(a, b, &mut unbounded)
}

/// `same`, decoding no more than `budget` bytes in all (what is decoded is
/// taken off it): a hostile file's streams can inflate without end, and a
/// signature check runs on every file that opens.
pub(crate) fn same_within(a: &Object, b: &Object, budget: &mut usize) -> bool {
    match (a, b) {
        (Object::Stream(x), Object::Stream(y)) => {
            let bare = |d: &Dictionary| {
                let mut d = d.clone();
                for key in [b"Length".as_slice(), b"Filter", b"DecodeParms", b"DL"] {
                    d.remove(key);
                }
                d
            };
            if bare(&x.dict) != bare(&y.dict) {
                return false;
            }
            let stored_alike = x.dict.get(b"Filter").ok() == y.dict.get(b"Filter").ok()
                && x.dict.get(b"DecodeParms").ok() == y.dict.get(b"DecodeParms").ok();
            if stored_alike && x.content == y.content {
                return true;
            }
            let limit = MAX_COMPARED.min(*budget);
            let Some(p) = decoded(x, limit) else {
                return false;
            };
            *budget = budget.saturating_sub(p.len());
            let Some(q) = decoded(y, limit.min(*budget)) else {
                return false;
            };
            *budget = budget.saturating_sub(q.len());
            p == q
        }
        _ => a == b,
    }
}

/// `same`, but blind to an annotation name (`/NM`) the other engine made
/// up: EmbedPDF gives every annotation that has none a fresh one when it
/// opens a file, and writes it back on save. Kept, that name alone was an
/// update after a signature on every save of a signed file — a signature
/// widget "modified" by nothing the person did. A name the file already had
/// and that was changed is still a change.
fn same_but_made_up_names(ours: &Object, theirs: &Object) -> bool {
    if same(ours, theirs) {
        return true;
    }
    match (ours, theirs) {
        (Object::Dictionary(x), Object::Dictionary(y)) if !x.has(b"NM") && y.has(b"NM") => {
            let mut y = y.clone();
            y.remove(b"NM");
            *x == y
        }
        _ => false,
    }
}

impl PdfDocument {
    /// Whether `other` is protected the same way: neither is, or both are
    /// sealed with the same key.
    fn same_protection(&self, other: &PdfDocument) -> bool {
        match (&self.sealer, &other.sealer) {
            (None, None) => !self.was_encrypted && !other.was_encrypted,
            (Some(ours), Some(theirs)) => ours.same_key(theirs),
            _ => false,
        }
    }

    /// `rewritten` — this document as another engine wrote it whole — as an
    /// update of this file's own bytes: the objects it says differently, and
    /// the ones it adds. The file itself when nothing differs. `None` when
    /// it cannot be: it is protected differently (a password added, changed
    /// or taken off, which an update cannot do), or it does not open.
    pub fn rebase(
        &mut self,
        rewritten: Vec<u8>,
        password: Option<&str>,
    ) -> Result<Option<Vec<u8>>> {
        let Ok(theirs) = PdfDocument::open(rewritten, password) else {
            return Ok(None);
        };
        if !self.same_protection(&theirs) {
            return Ok(None);
        }
        for (id, object) in &theirs.doc.objects {
            if storage_only(object) {
                continue;
            }
            if self
                .doc
                .objects
                .get(id)
                .is_some_and(|ours| same_but_made_up_names(ours, object))
            {
                continue;
            }
            self.doc.objects.insert(*id, object.clone());
            self.mark_touched(*id);
        }
        // Their catalog and information are the document's from now on.
        for key in [b"Root".as_slice(), b"Info"] {
            if let Ok(value @ Object::Reference(_)) = theirs.doc.trailer.get(key) {
                self.doc.trailer.set(key, value.clone());
            }
        }
        self.doc.max_id = self.doc.max_id.max(theirs.doc.max_id);
        self.save_incremental().map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    fn read(path: &str) -> Vec<u8> {
        std::fs::read(format!("{}/../../../{path}", env!("CARGO_MANIFEST_DIR"))).unwrap()
    }
    const THREE: &str = "tests/corpus/arabic/generated/chrome-notonaskh-justified-3pages.pdf";
    const AES: &str = "tests/corpus/arabic/generated/variant-encrypted-aes256.pdf";
    const REWRITES: &str = "tests/fixtures/rewrites";

    fn squares(doc: &PdfDocument) -> usize {
        let page = doc.doc.get_dictionary(doc.page_id(0).unwrap()).unwrap();
        let annots = match page.get(b"Annots") {
            Ok(Object::Reference(id)) => {
                doc.doc.get_object(*id).unwrap().as_array().unwrap().clone()
            }
            Ok(Object::Array(a)) => a.clone(),
            _ => vec![],
        };
        // An annotation is referred to, or written in place (PDFium does).
        annots
            .iter()
            .filter_map(|a| match a {
                Object::Reference(id) => doc.doc.get_dictionary(*id).ok(),
                Object::Dictionary(d) => Some(d),
                _ => None,
            })
            .filter(|d| d.get(b"Subtype").and_then(|s| s.as_name()).ok() == Some(b"Square"))
            .count()
    }

    #[test]
    fn a_rewrite_that_changed_nothing_is_the_file_itself() {
        let original = read(THREE);
        let mut doc = PdfDocument::open(original.clone(), None).unwrap();
        let rewritten = read(&format!("{REWRITES}/three-unchanged.pdf"));
        assert_ne!(rewritten, original, "PDFium wrote it differently");
        assert_eq!(doc.rebase(rewritten, None).unwrap(), Some(original));
    }

    #[test]
    fn an_annotation_added_elsewhere_becomes_an_update_of_the_file() {
        let original = read(THREE);
        let mut doc = PdfDocument::open(original.clone(), None).unwrap();
        let saved = doc
            .rebase(read(&format!("{REWRITES}/three-square.pdf")), None)
            .unwrap()
            .expect("rebased");
        assert!(
            saved.starts_with(&original),
            "the file's own bytes come first"
        );
        assert!(
            saved.len() - original.len() < 4_000,
            "only what changed is appended: {} bytes",
            saved.len() - original.len()
        );
        let back = PdfDocument::open(saved, None).unwrap();
        assert_eq!(back.page_count(), 3);
        assert_eq!(squares(&back), 1);
    }

    #[test]
    fn a_protected_file_stays_protected_under_its_own_bytes() {
        let original = read(AES);
        let mut doc = PdfDocument::open(original.clone(), Some("warraq")).unwrap();
        let saved = doc
            .rebase(
                read(&format!("{REWRITES}/aes256-square.pdf")),
                Some("warraq"),
            )
            .unwrap()
            .expect("rebased");
        assert!(saved.starts_with(&original));
        assert!(
            PdfDocument::open(saved.clone(), None).is_err(),
            "still protected"
        );
        assert_eq!(
            squares(&PdfDocument::open(saved, Some("warraq")).unwrap()),
            1
        );
    }

    #[test]
    fn a_name_made_up_for_an_annotation_is_not_a_change_but_a_changed_one_is() {
        let ours = Object::Dictionary(dictionary! { "Subtype" => "Widget", "FT" => "Sig" });
        let named = Object::Dictionary(dictionary! {
            "Subtype" => "Widget", "FT" => "Sig", "NM" => Object::string_literal("1ffdae9e"),
        });
        assert!(same_but_made_up_names(&ours, &named));
        assert!(!same(&ours, &named), "the verifier still sees it");
        let renamed = Object::Dictionary(dictionary! {
            "Subtype" => "Widget", "FT" => "Sig", "NM" => Object::string_literal("other"),
        });
        assert!(!same_but_made_up_names(&named, &renamed));
        let moved = Object::Dictionary(dictionary! {
            "Subtype" => "Widget", "FT" => "Tx", "NM" => Object::string_literal("1ffdae9e"),
        });
        assert!(!same_but_made_up_names(&ours, &moved));
    }

    #[test]
    fn a_rewrite_protected_differently_is_left_whole() {
        let mut doc = PdfDocument::open(read(AES), Some("warraq")).unwrap();
        assert_eq!(
            doc.rebase(
                read(&format!("{REWRITES}/aes256-unprotected.pdf")),
                Some("warraq")
            )
            .unwrap(),
            None,
            "a password taken off"
        );
        let mut plain = PdfDocument::open(read(THREE), None).unwrap();
        assert_eq!(
            plain
                .rebase(
                    read(&format!("{REWRITES}/aes256-square.pdf")),
                    Some("warraq")
                )
                .unwrap(),
            None,
            "a password put on"
        );
    }
}
