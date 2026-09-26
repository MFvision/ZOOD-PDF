//! Page content access and write-back.
//!
//! A page's `/Contents` (one stream or an array) is decoded and concatenated with a `\n` between
//! streams (the same bytes warraq-text interprets). Edits are splices over that concatenation;
//! only streams that contain a splice are replaced (by NEW stream objects, because content streams
//! may be shared between pages), the others keep their references. New drawing is appended after
//! the original content in a clean graphics state: `[q] original… [Q new]`, so whatever state the
//! original content leaves behind (CTM, clip, colours, text state) cannot leak into it.

use std::io::Write;
use std::ops::Range;

use lopdf::{Dictionary, Object, ObjectId, Stream};
use warraq_pdf::limits::decode_stream;
use warraq_pdf::{pages, Pdf};

use crate::content::{rewrite, Splice};
use crate::error::{EditError, Result};
use crate::geom::PageSpace;

/// Maximum decoded content of one page.
pub const MAX_PAGE_CONTENT: usize = 64 * 1024 * 1024;

/// One content stream's bytes inside [`PageContent::data`].
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    /// The stream object (None for a direct stream, which is invalid but tolerated).
    pub stream: Option<ObjectId>,
    pub range: Range<usize>,
}

/// The decoded content of a page.
#[derive(Debug, Clone)]
pub struct PageContent {
    pub index: usize,
    pub page_id: ObjectId,
    pub data: Vec<u8>,
    pub segments: Vec<Segment>,
    pub space: PageSpace,
    /// Effective `/Rotate` (0, 90, 180, 270).
    pub rotate: i64,
}

/// Object id of page `index` and its info.
pub fn page_info(pdf: &Pdf, index: usize) -> Result<pages::PageInfo> {
    let list = pages::flatten(pdf)?;
    list.into_iter()
        .nth(index)
        .ok_or(EditError::PageOutOfRange(index))
}

/// Number of pages.
pub fn page_count(pdf: &Pdf) -> Result<usize> {
    Ok(pages::count(pdf)?)
}

/// Load the content of page `index`.
pub fn load(pdf: &Pdf, index: usize) -> Result<PageContent> {
    let info = page_info(pdf, index)?;
    let dict = pdf
        .get_dict(info.id)
        .ok_or_else(|| EditError::NotFound("page object".into()))?;
    let mut data = Vec::new();
    let mut segments = Vec::new();
    let mut push = |id: Option<ObjectId>, s: &Stream, data: &mut Vec<u8>| -> Result<()> {
        let bytes = decode_stream(s, pdf.limits())?;
        if data.len() + bytes.len() + 1 > MAX_PAGE_CONTENT {
            return Err(EditError::Limit("page content size".into()));
        }
        if !segments.is_empty() {
            data.push(b'\n');
        }
        let start = data.len();
        data.extend_from_slice(&bytes);
        segments.push(Segment {
            stream: id,
            range: start..data.len(),
        });
        Ok(())
    };
    let stream_of = |o: &Object| -> Option<(Option<ObjectId>, Stream)> {
        match o {
            Object::Reference(id) => match pdf.resolve(o)? {
                Object::Stream(s) => Some((Some(*id), s.clone())),
                _ => None,
            },
            Object::Stream(s) => Some((None, s.clone())),
            _ => None,
        }
    };
    if let Ok(c) = dict.get(b"Contents") {
        let items: Vec<Object> = match pdf.resolve(c) {
            Some(Object::Array(a)) => a.iter().take(100_000).cloned().collect(),
            Some(Object::Stream(_)) => vec![c.clone()],
            _ => Vec::new(),
        };
        for item in &items {
            if let Some((id, s)) = stream_of(item) {
                push(id, &s, &mut data)?;
            }
        }
    }
    Ok(PageContent {
        index,
        page_id: info.id,
        data,
        segments,
        space: PageSpace {
            vbox: info.visible_box(),
        },
        rotate: info.rotate,
    })
}

/// A new compressed stream object.
pub fn new_stream(pdf: &mut Pdf, mut dict: Dictionary, data: &[u8]) -> Result<ObjectId> {
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(data)
        .map_err(|e| EditError::Limit(format!("compress: {e}")))?;
    let z = enc
        .finish()
        .map_err(|e| EditError::Limit(format!("compress: {e}")))?;
    dict.set("Filter", Object::Name(b"FlateDecode".to_vec()));
    Ok(pdf.add(Object::Stream(Stream::new(dict, z))))
}

/// Write `splices` (over `pc.data`) and optional `append`ed drawing back to the page.
pub fn write(
    pdf: &mut Pdf,
    pc: &PageContent,
    splices: &[Splice],
    append: Option<&[u8]>,
) -> Result<()> {
    if splices.is_empty() && append.is_none() {
        return Ok(());
    }
    let mut items: Vec<Object> = Vec::new();
    let crosses = splices.iter().any(|s| {
        !pc.segments
            .iter()
            .any(|seg| seg.range.start <= s.range.start && s.range.end <= seg.range.end)
    });
    if crosses || pc.segments.is_empty() {
        // One stream for everything (splices straddle stream boundaries, or no content yet).
        if !pc.data.is_empty() || !splices.is_empty() {
            let out = rewrite(&pc.data, splices)?;
            items.push(Object::Reference(new_stream(pdf, Dictionary::new(), &out)?));
        }
    } else {
        for seg in &pc.segments {
            let mine: Vec<Splice> = splices
                .iter()
                .filter(|s| seg.range.start <= s.range.start && s.range.end <= seg.range.end)
                .map(|s| Splice {
                    range: s.range.start - seg.range.start..s.range.end - seg.range.start,
                    with: s.with.clone(),
                })
                .collect();
            match (seg.stream, mine.is_empty()) {
                (Some(id), true) => items.push(Object::Reference(id)),
                _ => {
                    let bytes = pc.data.get(seg.range.clone()).unwrap_or(&[]);
                    let out = rewrite(bytes, &mine)?;
                    items.push(Object::Reference(new_stream(pdf, Dictionary::new(), &out)?));
                }
            }
        }
    }
    if let Some(extra) = append {
        let pre = new_stream(pdf, Dictionary::new(), b"q\n")?;
        let mut tail = b"\nQ\n".to_vec();
        tail.extend_from_slice(extra);
        let post = new_stream(pdf, Dictionary::new(), &tail)?;
        items.insert(0, Object::Reference(pre));
        items.push(Object::Reference(post));
    }
    let mut dict = pdf
        .get_dict(pc.page_id)
        .cloned()
        .ok_or_else(|| EditError::NotFound("page object".into()))?;
    let contents = match items.as_slice() {
        [one] => one.clone(),
        _ => Object::Array(items),
    };
    dict.set("Contents", contents);
    pdf.set(pc.page_id, Object::Dictionary(dict));
    Ok(())
}

/// The page's effective `/Resources` (inherited, resolved) as a direct dictionary.
pub fn resources(pdf: &Pdf, page_id: ObjectId) -> Dictionary {
    let mut cur = pdf.get_dict(page_id);
    for _ in 0..64 {
        let Some(d) = cur else { break };
        if let Ok(r) = d.get(b"Resources") {
            if let Some(Object::Dictionary(rd)) = pdf.resolve(r) {
                return rd.clone();
            }
            return Dictionary::new();
        }
        cur = d.get(b"Parent").ok().and_then(|p| match p {
            Object::Reference(id) => pdf.get_dict(*id),
            _ => None,
        });
    }
    Dictionary::new()
}

/// Look `name` up in the page's resource `category` (`Font`, `XObject`, …).
pub fn resource<'a>(
    pdf: &'a Pdf,
    res: &'a Dictionary,
    category: &[u8],
    name: &[u8],
) -> Option<(Option<ObjectId>, &'a Object)> {
    let cat = pdf.resolve(res.get(category).ok()?)?;
    let Object::Dictionary(cd) = cat else {
        return None;
    };
    let entry = cd.get(name).ok()?;
    let id = match entry {
        Object::Reference(id) => Some(*id),
        _ => None,
    };
    Some((id, pdf.resolve(entry)?))
}

/// Add `obj` to the page's resource `category` under a fresh name starting with `prefix`;
/// the page gets a direct copy of its (possibly inherited or shared) resources. Returns the name.
pub fn add_resource(
    pdf: &mut Pdf,
    page_id: ObjectId,
    category: &[u8],
    prefix: &str,
    obj: Object,
) -> Result<Vec<u8>> {
    let mut res = resources(pdf, page_id);
    let mut cat = match res.get(category).ok().and_then(|o| pdf.resolve(o)) {
        Some(Object::Dictionary(d)) => d.clone(),
        _ => Dictionary::new(),
    };
    let mut n = 1usize;
    let name = loop {
        let cand = format!("{prefix}{n}").into_bytes();
        if !cat.has(&cand) {
            break cand;
        }
        n += 1;
        if n > 1_000_000 {
            return Err(EditError::Limit("resource names".into()));
        }
    };
    cat.set(name.clone(), obj);
    res.set(category.to_vec(), Object::Dictionary(cat));
    let mut page = pdf
        .get_dict(page_id)
        .cloned()
        .ok_or_else(|| EditError::NotFound("page object".into()))?;
    page.set("Resources", Object::Dictionary(res));
    pdf.set(page_id, Object::Dictionary(page));
    Ok(name)
}
