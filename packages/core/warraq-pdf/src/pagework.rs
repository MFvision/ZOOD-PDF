//! The page plumbing that page marks, placed images and links share: a
//! page's content streams, its own resources, and streams read and written
//! with limits.
use lopdf::{Dictionary, Object, ObjectId, Stream};

use crate::{Error, PdfDocument, Result};

/// A content stream is not decoded past this many bytes (as `hidden`).
pub(crate) const MAX_STREAM: usize = 64 * 1024 * 1024;
/// Nor all of one page's streams together, read for its marks: a
/// `/Contents` may list the same stream many times over.
pub(crate) const MAX_PAGE_CONTENT: usize = 256 * 1024 * 1024;

fn parse(e: impl std::fmt::Display) -> Error {
    Error::Parse(e.to_string())
}

impl PdfDocument {
    /// The page's content streams, in order. `/Contents` may be a stream,
    /// an array of them, or a reference to such an array.
    pub(crate) fn content_ids(&self, page_id: ObjectId) -> Vec<ObjectId> {
        let Ok(page) = self.doc.get_dictionary(page_id) else {
            return vec![];
        };
        let refs = |array: &[Object]| -> Vec<ObjectId> {
            array.iter().filter_map(|o| o.as_reference().ok()).collect()
        };
        match page.get(b"Contents") {
            Ok(Object::Reference(id)) => match self.doc.get_object(*id) {
                Ok(Object::Array(array)) => refs(array),
                Ok(Object::Stream(_)) => vec![*id],
                _ => vec![],
            },
            Ok(Object::Array(array)) => refs(array),
            _ => vec![],
        }
    }

    /// Replaces the page's `/Contents`.
    pub(crate) fn set_contents(&mut self, page_id: ObjectId, contents: Object) -> Result<()> {
        self.doc
            .get_dictionary_mut(page_id)
            .map_err(parse)?
            .set("Contents", contents);
        self.mark_touched(page_id);
        Ok(())
    }

    /// A stream's decoded bytes, bounded.
    pub(crate) fn stream_bytes(&self, id: ObjectId) -> Result<Vec<u8>> {
        let stream = self
            .doc
            .get_object(id)
            .and_then(Object::as_stream)
            .map_err(parse)?;
        stream
            .decompressed_content_with_limit(MAX_STREAM)
            .map_err(|e| Error::Edit(format!("a content stream could not be decoded: {e}")))
    }

    /// A stream's decoded bytes if they are no more than `limit`: `None`
    /// for what is not a stream or cannot be decoded, an error for one that
    /// is longer.
    pub(crate) fn stream_bytes_within(
        &self,
        id: ObjectId,
        limit: usize,
    ) -> Result<Option<Vec<u8>>> {
        let Ok(stream) = self.doc.get_object(id).and_then(Object::as_stream) else {
            return Ok(None);
        };
        match stream.decompressed_content_with_limit(limit) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(lopdf::Error::Decompress(lopdf::DecompressError::MemoryLimitExceeded {
                ..
            })) => Err(Error::Edit("a content stream is too long to read".into())),
            Err(_) => Ok(None),
        }
    }

    /// The depth of `q` the page's streams `ids` leave open, counted over
    /// them as one — a `q` in one may be closed by a `Q` in the next — and
    /// read one at a time, keeping nothing.
    pub(crate) fn open_saves_in(&self, ids: &[ObjectId]) -> Result<usize> {
        let mut depth = 0usize;
        let mut left = MAX_PAGE_CONTENT;
        for id in ids {
            let Some(bytes) = self.stream_bytes_within(*id, left.min(MAX_STREAM))? else {
                continue;
            };
            left -= bytes.len();
            depth = saves_after(depth, &bytes);
        }
        Ok(depth)
    }

    /// Writes new bytes into an existing stream, compressed, keeping the
    /// rest of its dictionary.
    pub(crate) fn set_stream_bytes(&mut self, id: ObjectId, bytes: Vec<u8>) -> Result<()> {
        let stream = self
            .doc
            .get_object_mut(id)
            .and_then(Object::as_stream_mut)
            .map_err(parse)?;
        stream.dict.remove(b"Filter");
        stream.dict.remove(b"DecodeParms");
        stream.set_plain_content(bytes);
        let _ = stream.compress();
        self.mark_touched(id);
        Ok(())
    }

    /// A new content stream, compressed.
    pub(crate) fn new_stream(&mut self, dict: Dictionary, bytes: Vec<u8>) -> ObjectId {
        let mut stream = Stream::new(dict, bytes);
        let _ = stream.compress();
        self.doc.add_object(stream)
    }

    /// Drops an object this session added and nothing uses any more; one
    /// that came with the file stays, unreferenced, in its revision.
    pub(crate) fn forget(&mut self, id: ObjectId) {
        if self.is_addition(id) {
            self.doc.objects.remove(&id);
        }
    }

    /// The resources the page draws with: its own, or the nearest ancestor's.
    pub(crate) fn page_resources(&self, page_id: ObjectId) -> Option<&Dictionary> {
        let page = self.doc.get_dictionary(page_id).ok()?;
        let resources = self.inherited(page, b"Resources")?;
        match resources {
            Object::Reference(id) => self.doc.get_dictionary(*id).ok(),
            Object::Dictionary(d) => Some(d),
            _ => None,
        }
    }

    /// Gives the page a resource dictionary of its own, written in the page,
    /// with its `/XObject` group written in it too, so that what is added to
    /// one page is not added to every page that shared its resources. The
    /// fonts, pictures and the rest stay shared, by reference.
    pub(crate) fn own_resources(&mut self, page_id: ObjectId) -> Result<()> {
        let mut own = self.page_resources(page_id).cloned().unwrap_or_default();
        if let Ok(Object::Reference(id)) = own.get(b"XObject") {
            let group = self.doc.get_dictionary(*id).cloned().unwrap_or_default();
            own.set("XObject", Object::Dictionary(group));
        }
        let page = self.doc.get_dictionary_mut(page_id).map_err(parse)?;
        page.set("Resources", Object::Dictionary(own));
        self.mark_touched(page_id);
        Ok(())
    }

    /// The page's own `/XObject` group, after `own_resources`.
    pub(crate) fn own_xobjects(&mut self, page_id: ObjectId) -> Result<&mut Dictionary> {
        let page = self.doc.get_dictionary_mut(page_id).map_err(parse)?;
        let resources = page
            .get_mut(b"Resources")
            .and_then(Object::as_dict_mut)
            .map_err(|_| Error::Edit("the page has no resources of its own".into()))?;
        if !matches!(resources.get(b"XObject"), Ok(Object::Dictionary(_))) {
            resources.set("XObject", Object::Dictionary(Dictionary::new()));
        }
        resources
            .get_mut(b"XObject")
            .and_then(Object::as_dict_mut)
            .map_err(parse)
    }

    /// Registers `id` in the page's own XObjects under a fresh name that
    /// starts with `prefix`; returns the name.
    pub(crate) fn add_xobject(
        &mut self,
        page_id: ObjectId,
        prefix: &str,
        id: ObjectId,
    ) -> Result<Vec<u8>> {
        let group = self.own_xobjects(page_id)?;
        let mut n = 1;
        while group.has(format!("{prefix}{n}").as_bytes()) {
            n += 1;
        }
        let name = format!("{prefix}{n}").into_bytes();
        group.set(name.clone(), Object::Reference(id));
        Ok(name)
    }
}

/// The depth of `q` open after `content`, from `depth` open before it.
/// Read an operation at a time: nothing of the stream is kept.
pub(crate) fn saves_after(mut depth: usize, content: &[u8]) -> usize {
    for op in crate::lex::ops(content) {
        if op.is("q") {
            depth += 1;
        } else if op.is("Q") {
            depth = depth.saturating_sub(1);
        }
    }
    depth
}

/// The depth of `q` a content stream leaves open.
#[cfg(test)]
pub(crate) fn open_saves(content: &[u8]) -> usize {
    saves_after(0, content)
}

/// A number as content-stream text: short, and never in exponent form.
pub(crate) fn num(v: f32) -> String {
    let v = if v.is_finite() { v } else { 0.0 };
    let s = format!("{v:.4}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" || s.is_empty() {
        "0".into()
    } else {
        s.to_string()
    }
}

/// `a b c d e f cm`.
pub(crate) fn cm(m: [f32; 6]) -> String {
    format!(
        "{} {} {} {} {} {} cm",
        num(m[0]),
        num(m[1]),
        num(m[2]),
        num(m[3]),
        num(m[4]),
        num(m[5])
    )
}

/// A name as content-stream text, escaping what a name cannot hold.
pub(crate) fn name(n: &[u8]) -> String {
    let mut s = String::from("/");
    for b in n {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'+') {
            s.push(*b as char);
        } else {
            s.push_str(&format!("#{b:02X}"));
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_written_short_and_plain() {
        assert_eq!(num(1.0), "1");
        assert_eq!(num(-0.00001), "0");
        assert_eq!(num(12.5), "12.5");
        assert_eq!(num(f32::NAN), "0");
        assert_eq!(num(1.0e9), "1000000000");
        assert_eq!(name(b"Im 1"), "/Im#201");
        assert_eq!(open_saves(b"q q Q q"), 2);
        assert_eq!(open_saves(b"Q Q q"), 1);
    }
}
