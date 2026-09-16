//! Document handle over `lopdf`. The original bytes are kept untouched.
use crate::crypt::{self, CryptError};
use crate::{Error, Result};
use lopdf::{Document, LoadOptions, Object, ObjectId};

pub struct PdfDocument {
    pub(crate) doc: Document,
    original: Vec<u8>,
    pages: Vec<ObjectId>,
    /// Highest object id present when the document was opened: everything above
    /// it was added by us and must go into an incremental update.
    base_max_id: u32,
    /// Objects that existed already and that we changed.
    pub(crate) touched: std::collections::BTreeSet<u32>,
    pub(crate) was_encrypted: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Metadata {
    pub title: Option<String>,
    pub author: Option<String>,
    pub producer: Option<String>,
    pub creator: Option<String>,
    pub pages: usize,
    pub encrypted: bool,
}

/// Decode a PDF text string (UTF-16BE with BOM, UTF-8 BOM, or PDFDocEncoding≈Latin-1).
pub fn decode_text_string(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let u: Vec<u16> = bytes[2..]
            .chunks(2)
            .map(|c| u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)]))
            .collect();
        String::from_utf16_lossy(&u)
    } else if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&bytes[3..]).into_owned()
    } else {
        bytes.iter().map(|b| *b as char).collect()
    }
}

impl PdfDocument {
    pub fn open(bytes: Vec<u8>, password: Option<&str>) -> Result<Self> {
        let password = password.unwrap_or("");
        // lopdf 0.45 authenticates while it parses and keeps a single object of
        // any file it cannot open there and then, so encrypted files are loaded
        // with their ciphertext intact and decrypted by our own standard
        // security handler; lopdf's stays as the fallback. See `crate::crypt`.
        let mut doc =
            crypt::load_preserving_ciphertext(&bytes).map_err(|e| Error::Parse(e.to_string()))?;
        let encrypted = crypt::is_encrypted(&doc);
        if encrypted {
            match crypt::decrypt_document(&mut doc, password) {
                Ok(()) => {}
                Err(CryptError::WrongPassword) => return Err(Error::Password),
                Err(e) => {
                    log::warn!("warraq-pdf: {e}; falling back to lopdf's security handler");
                    doc = Self::load_with_lopdf(&bytes, password)?;
                }
            }
            if doc.get_pages().is_empty() {
                doc = Self::load_with_lopdf(&bytes, password)?;
            }
        }
        let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
        let base_max_id = doc.max_id;
        Ok(Self {
            doc,
            original: bytes,
            pages,
            base_max_id,
            touched: Default::default(),
            was_encrypted: encrypted,
        })
    }

    /// Record that an object that already existed in the file was modified.
    pub fn mark_touched(&mut self, id: ObjectId) {
        if id.0 <= self.base_max_id {
            self.touched.insert(id.0);
        }
    }

    /// Ids that an incremental update must carry: everything we added plus
    /// everything we modified.
    pub fn dirty_ids(&self) -> std::collections::BTreeSet<u32> {
        let mut ids = self.touched.clone();
        ids.extend(
            self.doc
                .objects
                .keys()
                .map(|(n, _)| *n)
                .filter(|n| *n > self.base_max_id),
        );
        ids
    }

    /// `/Root`, `/Info` and `/ID` of the current trailer, rendered for a new trailer.
    pub(crate) fn trailer_refs(&self) -> String {
        let mut s = String::new();
        if let Ok(Object::Reference(id)) = self.doc.trailer.get(b"Root") {
            s.push_str(&format!(" /Root {} {} R", id.0, id.1));
        }
        if let Ok(Object::Reference(id)) = self.doc.trailer.get(b"Info") {
            s.push_str(&format!(" /Info {} {} R", id.0, id.1));
        }
        if let Ok(Object::Array(a)) = self.doc.trailer.get(b"ID") {
            let hex: Vec<String> = a
                .iter()
                .filter_map(|o| o.as_str().ok())
                .map(|b| {
                    format!(
                        "<{}>",
                        b.iter().map(|x| format!("{x:02X}")).collect::<String>()
                    )
                })
                .collect();
            if hex.len() == 2 {
                s.push_str(&format!(" /ID [{}]", hex.join(" ")));
            }
        }
        s
    }

    /// Read-only access to the underlying object model (diagnostics and tests).
    pub fn doc_ref(&self) -> &Document {
        &self.doc
    }

    /// Last resort for a file our own handler cannot decrypt: let `lopdf`
    /// authenticate and decrypt while it loads.
    fn load_with_lopdf(bytes: &[u8], password: &str) -> Result<Document> {
        let doc = Document::load_mem_with_options(bytes, LoadOptions::with_password(password))
            .map_err(|_| Error::Password)?;
        if doc.get_pages().is_empty() {
            return Err(Error::Password);
        }
        Ok(doc)
    }

    /// True when the file we opened was encrypted, which stays true after the
    /// objects have been decrypted in memory (unlike `lopdf`'s own flag).
    pub fn was_encrypted(&self) -> bool {
        self.was_encrypted
    }

    pub fn original_bytes(&self) -> &[u8] {
        &self.original
    }

    pub fn page_count(&self) -> usize {
        self.pages.len()
    }

    pub fn page_id(&self, index: usize) -> Result<ObjectId> {
        self.pages.get(index).copied().ok_or(Error::Page(index))
    }

    fn inherited<'a>(&'a self, mut dict: &'a lopdf::Dictionary, key: &[u8]) -> Option<&'a Object> {
        loop {
            if let Ok(v) = dict.get(key) {
                return Some(v);
            }
            let parent = dict.get(b"Parent").ok()?.as_reference().ok()?;
            dict = self.doc.get_dictionary(parent).ok()?;
        }
    }

    fn rect(&self, obj: Option<&Object>) -> Option<[f32; 4]> {
        let arr = match obj? {
            Object::Reference(id) => self.doc.get_object(*id).ok()?.as_array().ok()?.clone(),
            o => o.as_array().ok()?.clone(),
        };
        if arr.len() != 4 {
            return None;
        }
        let mut r = [0f32; 4];
        for (i, v) in arr.iter().enumerate() {
            r[i] = match v {
                Object::Integer(n) => *n as f32,
                Object::Real(f) => *f,
                _ => return None,
            };
        }
        Some([
            r[0].min(r[2]),
            r[1].min(r[3]),
            r[0].max(r[2]),
            r[1].max(r[3]),
        ])
    }

    /// Page size in points after /Rotate, from the CropBox intersected with the MediaBox.
    pub fn page_size(&self, index: usize) -> Result<(f32, f32)> {
        let id = self.page_id(index)?;
        let dict = self
            .doc
            .get_dictionary(id)
            .map_err(|e| Error::Parse(e.to_string()))?;
        let media = self
            .rect(self.inherited(dict, b"MediaBox"))
            .unwrap_or([0.0, 0.0, 612.0, 792.0]);
        let crop = self.rect(self.inherited(dict, b"CropBox")).unwrap_or(media);
        let x0 = crop[0].max(media[0]);
        let y0 = crop[1].max(media[1]);
        let x1 = crop[2].min(media[2]);
        let y1 = crop[3].min(media[3]);
        let (w, h) = ((x1 - x0).max(1.0), (y1 - y0).max(1.0));
        let rotate = match self.inherited(dict, b"Rotate") {
            Some(Object::Integer(r)) => ((*r % 360) + 360) % 360,
            _ => 0,
        };
        Ok(if rotate == 90 || rotate == 270 {
            (h, w)
        } else {
            (w, h)
        })
    }

    pub fn metadata(&self) -> Metadata {
        let mut m = Metadata {
            pages: self.page_count(),
            encrypted: self.was_encrypted,
            ..Default::default()
        };
        if let Ok(info) = self
            .doc
            .trailer
            .get(b"Info")
            .and_then(|o| o.as_reference())
            .and_then(|id| self.doc.get_dictionary(id))
        {
            let get = |k: &[u8]| {
                info.get(k)
                    .ok()
                    .and_then(|o| o.as_str().ok())
                    .map(decode_text_string)
            };
            m.title = get(b"Title");
            m.author = get(b"Author");
            m.producer = get(b"Producer");
            m.creator = get(b"Creator");
        }
        m
    }

    /// Full rewrite of the document (incremental updates come with the edit log in Phase 2).
    pub fn save_to_vec(&mut self) -> Result<Vec<u8>> {
        let mut out = Vec::with_capacity(self.original.len() + 4096);
        self.doc
            .save_to(&mut out)
            .map_err(|e| Error::Io(e.to_string()))?;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/generated/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    #[test]
    fn opens_pages_sizes_and_metadata_of_corpus_files() {
        let d = PdfDocument::open(corpus("chrome-notonaskh-justified-3pages.pdf"), None).unwrap();
        assert_eq!(d.page_count(), 3);
        let (w, h) = d.page_size(0).unwrap();
        assert!(
            (w - 595.0).abs() < 1.5 && (h - 842.0).abs() < 1.5,
            "A4 expected, got {w}x{h}"
        );
        assert_eq!(
            d.page_size(5).err().map(|e| e.to_string()),
            Some("E_PAGE: page index 5 out of range".into())
        );
        let m = PdfDocument::open(corpus("variant-arabic-metadata-outlines-annots.pdf"), None)
            .unwrap()
            .metadata();
        assert_eq!(m.title.as_deref(), Some("دليل وراق: النسخة التجريبية"));
        assert_eq!(m.author.as_deref(), Some("فريق وراق"));
    }

    #[test]
    fn encrypted_file_needs_the_password() {
        assert!(matches!(
            PdfDocument::open(corpus("variant-encrypted-aes256.pdf"), None),
            Err(Error::Password)
        ));
        let d = PdfDocument::open(corpus("variant-encrypted-aes256.pdf"), Some("warraq")).unwrap();
        assert_eq!(d.page_count(), 3);
    }

    /// Every revision and cipher of the standard security handler in the
    /// corpus: RC4 40-bit (R2), RC4 128-bit (R3), AES-128 with
    /// `/EncryptMetadata false` (R4) and AES-256 (R6), the last of them with an
    /// empty user password and its objects inside an object stream.
    #[test]
    fn every_encrypted_variant_opens_with_its_password() {
        let variants = [
            ("variant-encrypted-rc4-40.pdf", "warraq", 1),
            ("variant-encrypted-rc4-128.pdf", "warraq", 1),
            ("variant-encrypted-aes128.pdf", "warraq", 1),
            ("variant-encrypted-aes256-owner-only.pdf", "", 1),
            ("variant-encrypted-aes256.pdf", "warraq", 3),
        ];
        for (name, password, pages) in variants {
            let d = PdfDocument::open(corpus(name), Some(password)).unwrap_or_else(|e| {
                panic!("{name} did not open with its user password: {e}");
            });
            assert_eq!(d.page_count(), pages, "{name}");
            // The owner password opens every one of them as well.
            let d = PdfDocument::open(corpus(name), Some("warraq-owner"))
                .unwrap_or_else(|e| panic!("{name} did not open with the owner password: {e}"));
            assert_eq!(d.page_count(), pages, "{name} (owner password)");
            // The page tree is readable, i.e. the objects really were decrypted.
            let (w, h) = d.page_size(0).unwrap();
            assert!(w > 100.0 && h > 100.0, "{name}: page is {w}x{h}");

            // A full rewrite of a decrypted document is plaintext: it reopens
            // with no password at all.
            let mut d = d;
            let saved = d.save_to_vec().unwrap();
            let reopened = PdfDocument::open(saved, None)
                .unwrap_or_else(|e| panic!("{name} did not survive a rewrite: {e}"));
            assert_eq!(reopened.page_count(), pages, "{name} (rewritten)");
            assert!(!reopened.metadata().encrypted, "{name} (rewritten)");

            let wrong = PdfDocument::open(corpus(name), Some("not-the-password"));
            assert!(
                matches!(wrong, Err(Error::Password)),
                "{name}: a wrong password gave {:?}",
                wrong.err().map(|e| e.to_string())
            );
        }
        // No password at all is the same as an empty one: it opens only the
        // file whose user password is empty.
        assert!(PdfDocument::open(corpus("variant-encrypted-aes256-owner-only.pdf"), None).is_ok());
        assert!(matches!(
            PdfDocument::open(corpus("variant-encrypted-rc4-128.pdf"), None),
            Err(Error::Password)
        ));
    }

    #[test]
    fn perf_500_pages_opens_fast() {
        let t = std::time::Instant::now();
        let d = PdfDocument::open(corpus("perf-text-500-pages.pdf"), None).unwrap();
        assert_eq!(d.page_count(), 500);
        assert!(t.elapsed().as_millis() < 1000, "took {:?}", t.elapsed());
    }
}
