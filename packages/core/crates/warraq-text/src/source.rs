//! The narrow interface the text engine needs from the PDF object layer.
//!
//! [`ContentSource`] is deliberately small (page count, page content bytes, resources and
//! object lookup) so that it can be implemented on top of `warraq-pdf`'s decrypted document
//! once that crate lands. Until then [`LopdfSource`] implements it directly on `lopdf`.

use lopdf::{Dictionary, Document, LoadOptions, Object, ObjectId, Stream};

use crate::error::{Result, TextError};
use crate::limits;

/// Everything the interpreter needs from a PDF.
pub trait ContentSource {
    /// Number of pages.
    fn page_count(&self) -> usize;
    /// Decoded, concatenated content streams of page `index` (0-based).
    fn page_content(&self, index: usize) -> Result<Vec<u8>>;
    /// The page's (possibly inherited) `/Resources` dictionary.
    fn page_resources(&self, index: usize) -> Result<Dictionary>;
    /// The visible page box `[x0 y0 x1 y1]` (CropBox, else MediaBox, else Letter).
    fn page_box(&self, index: usize) -> Result<[f64; 4]>;
    /// Indirect object lookup (already decrypted).
    fn object(&self, id: ObjectId) -> Option<&Object>;
}

/// Follow references (bounded) to the underlying object.
pub fn resolve<'a, S: ContentSource + ?Sized>(src: &'a S, obj: &'a Object) -> Option<&'a Object> {
    let mut cur = obj;
    for _ in 0..32 {
        match cur {
            Object::Reference(id) => cur = src.object(*id)?,
            other => return Some(other),
        }
    }
    None
}

/// Resolve and return the object as a dictionary (a stream's dictionary counts).
pub fn resolve_dict<'a, S: ContentSource + ?Sized>(
    src: &'a S,
    obj: &'a Object,
) -> Option<&'a Dictionary> {
    match resolve(src, obj)? {
        Object::Dictionary(d) => Some(d),
        Object::Stream(s) => Some(&s.dict),
        _ => None,
    }
}

/// `dict[key]`, resolved.
pub fn dict_get<'a, S: ContentSource + ?Sized>(
    src: &'a S,
    dict: &'a Dictionary,
    key: &[u8],
) -> Option<&'a Object> {
    resolve(src, dict.get(key).ok()?)
}

/// Numeric value of an object.
pub fn as_number(obj: &Object) -> Option<f64> {
    match obj {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => {
            let v = f64::from(*r);
            v.is_finite().then_some(v)
        }
        _ => None,
    }
}

/// Decode a stream with the crate-wide size limit.
pub fn stream_data(stream: &Stream) -> Result<Vec<u8>> {
    match stream.decompressed_content_with_limit(limits::MAX_CONTENT_BYTES) {
        Ok(d) => Ok(d),
        Err(lopdf::Error::Decompress(_)) if stream.content.len() <= limits::MAX_CONTENT_BYTES => {
            // Corrupt compressed data: lenient fallback to what is there (may still parse).
            Ok(stream.content.clone())
        }
        Err(e) => Err(TextError::Pdf(e.to_string())),
    }
}

/// [`ContentSource`] backed by a `lopdf::Document`.
pub struct LopdfSource {
    doc: Document,
    pages: Vec<ObjectId>,
}

impl LopdfSource {
    /// Parse `bytes`. `password` is tried for encrypted files (lopdf's own handler; the
    /// `warraq-pdf` handler replaces it at integration).
    pub fn open(bytes: &[u8], password: Option<&str>) -> Result<Self> {
        let opts = LoadOptions {
            max_decompressed_size: Some(limits::MAX_CONTENT_BYTES),
            password: password.map(str::to_string),
            ..Default::default()
        };
        let doc = Document::load_mem_with_options(bytes, opts)
            .map_err(|e| TextError::Pdf(e.to_string()))?;
        Ok(Self::from_document(doc))
    }

    /// Wrap an already loaded document.
    pub fn from_document(doc: Document) -> Self {
        let pages = doc.page_iter().take(1_000_000).collect();
        LopdfSource { doc, pages }
    }

    pub fn document(&self) -> &Document {
        &self.doc
    }

    fn page_dict(&self, index: usize) -> Result<&Dictionary> {
        let id = self
            .pages
            .get(index)
            .ok_or(TextError::PageOutOfRange(index))?;
        self.doc
            .get_dictionary(*id)
            .map_err(|e| TextError::Pdf(e.to_string()))
    }

    /// Look `key` up on the page or its ancestors (inheritable attributes).
    fn inherited(&self, index: usize, key: &[u8]) -> Result<Option<&Object>> {
        let mut dict = self.page_dict(index)?;
        for _ in 0..64 {
            if let Ok(v) = dict.get(key) {
                return Ok(resolve(self, v));
            }
            match dict.get(b"Parent").ok().and_then(|p| resolve_dict(self, p)) {
                Some(parent) => dict = parent,
                None => break,
            }
        }
        Ok(None)
    }
}

impl ContentSource for LopdfSource {
    fn page_count(&self) -> usize {
        self.pages.len()
    }

    fn page_content(&self, index: usize) -> Result<Vec<u8>> {
        let dict = self.page_dict(index)?;
        let mut out = Vec::new();
        let contents = match dict.get(b"Contents").ok().and_then(|c| resolve(self, c)) {
            Some(c) => c,
            None => return Ok(out),
        };
        let mut push = |s: &Stream| -> Result<()> {
            let data = stream_data(s)?;
            if out.len() + data.len() > limits::MAX_CONTENT_BYTES {
                return Err(TextError::Limit("page content size"));
            }
            out.extend_from_slice(&data);
            out.push(b'\n');
            Ok(())
        };
        match contents {
            Object::Stream(s) => push(s)?,
            Object::Array(items) => {
                for item in items.iter().take(100_000) {
                    if let Some(Object::Stream(s)) = resolve(self, item) {
                        push(s)?;
                    }
                }
            }
            _ => {}
        }
        Ok(out)
    }

    fn page_resources(&self, index: usize) -> Result<Dictionary> {
        Ok(match self.inherited(index, b"Resources")? {
            Some(Object::Dictionary(d)) => d.clone(),
            _ => Dictionary::new(),
        })
    }

    fn page_box(&self, index: usize) -> Result<[f64; 4]> {
        for key in [&b"CropBox"[..], b"MediaBox"] {
            if let Some(Object::Array(a)) = self.inherited(index, key)? {
                let nums: Vec<f64> = a
                    .iter()
                    .filter_map(|o| resolve(self, o).and_then(as_number))
                    .collect();
                if let [x0, y0, x1, y1] = nums.as_slice() {
                    return Ok([x0.min(*x1), y0.min(*y1), x0.max(*x1), y0.max(*y1)]);
                }
            }
        }
        Ok([0.0, 0.0, 612.0, 792.0])
    }

    fn object(&self, id: ObjectId) -> Option<&Object> {
        self.doc.objects.get(&id)
    }
}
