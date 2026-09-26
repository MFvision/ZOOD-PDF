//! How ZOOD marks live in a page.
//!
//! * A mark has one **info dictionary** `<< /Type /ZOODMark /V 1 /Id (…) /Spec (json) [/Picture …] >>`.
//! * On every marked page a **form XObject** (`/ZOODMark` → the info dictionary) draws it, and a
//!   small **mark stream** of its own, `q /Artifact <</Type /Pagination /Subtype /Watermark …>> BDC
//!   /ZMk1 Do EMC Q`, is added to the page's `/Contents` array (its dictionary also carries
//!   `/ZOODMark`). Behind-content marks go before the original streams; in-front marks after them,
//!   with the original content wrapped between two tiny shared streams `q` / `Q` (`/ZOODWrap`) so
//!   whatever state it leaves cannot move or recolour the mark.
//! * Removing a mark takes its streams (and the form's resource entry) off the page; content
//!   streams are never rewritten, so every other content byte stays identical. When the last mark
//!   goes, the wrappers go too and `/Contents` is the original again.

use lopdf::{Dictionary, Object, ObjectId, StringFormat};
use warraq_edit::page::new_stream;
use warraq_pdf::Pdf;

use crate::error::{MarkError, Result};

/// Private key on mark streams, mark forms (→ info dictionary).
pub const KEY: &[u8] = b"ZOODMark";
/// Private key on the `q`/`Q` wrapper streams (`/Open`, `/Close`).
pub const WRAP: &[u8] = b"ZOODWrap";

/// What an entry of `/Contents` is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Item {
    Original,
    Mark(ObjectId),
    WrapOpen,
    WrapClose,
}

fn stream_dict<'a>(pdf: &'a Pdf, o: &'a Object) -> Option<&'a Dictionary> {
    match pdf.resolve(o)? {
        Object::Stream(s) => Some(&s.dict),
        _ => None,
    }
}

/// Classify a `/Contents` entry.
pub fn classify(pdf: &Pdf, o: &Object) -> Item {
    let Some(d) = stream_dict(pdf, o) else {
        return Item::Original;
    };
    if let Ok(Object::Reference(info)) = d.get(KEY) {
        return Item::Mark(*info);
    }
    match d.get(WRAP) {
        Ok(Object::Name(n)) if n.as_slice() == b"Open" => Item::WrapOpen,
        Ok(Object::Name(n)) if n.as_slice() == b"Close" => Item::WrapClose,
        _ => Item::Original,
    }
}

/// The page's `/Contents` entries (streams or references), read only.
pub fn contents_ro(pdf: &Pdf, page_id: ObjectId) -> Vec<Object> {
    let Some(c) = pdf.get_dict(page_id).and_then(|p| p.get(b"Contents").ok()) else {
        return Vec::new();
    };
    match c {
        Object::Reference(_) => match pdf.resolve(c) {
            Some(Object::Array(a)) => a.iter().take(100_000).cloned().collect(),
            Some(Object::Stream(_)) => vec![c.clone()],
            _ => Vec::new(),
        },
        Object::Array(a) => a.iter().take(100_000).cloned().collect(),
        Object::Stream(_) => vec![c.clone()],
        _ => Vec::new(),
    }
}

/// The page's `/Contents` as a list of (indirect) stream references; direct streams (invalid
/// but tolerated) become objects so they can be referenced.
pub fn contents(pdf: &mut Pdf, page_id: ObjectId) -> Result<Vec<Object>> {
    if pdf.get_dict(page_id).is_none() {
        return Err(MarkError::NotFound("page object".into()));
    }
    let items = contents_ro(pdf, page_id);
    let mut out = Vec::with_capacity(items.len());
    for it in items {
        match it {
            Object::Stream(s) => out.push(Object::Reference(pdf.add(Object::Stream(s)))),
            Object::Reference(_) => out.push(it),
            _ => {}
        }
    }
    Ok(out)
}

/// Write `items` as the page's `/Contents` (a single reference when there is one).
pub fn set_contents(pdf: &mut Pdf, page_id: ObjectId, items: Vec<Object>) -> Result<()> {
    let mut page = pdf
        .get_dict(page_id)
        .cloned()
        .ok_or_else(|| MarkError::NotFound("page object".into()))?;
    match items.len() {
        0 => {
            page.remove(b"Contents");
        }
        1 => {
            let one = items.into_iter().next().unwrap_or(Object::Null);
            page.set("Contents", one);
        }
        _ => page.set("Contents", Object::Array(items)),
    }
    pdf.set(page_id, Object::Dictionary(page));
    Ok(())
}

/// The two shared wrapper streams.
pub struct Wrappers {
    pub open: ObjectId,
    pub close: ObjectId,
}

impl Wrappers {
    pub fn new(pdf: &mut Pdf) -> Result<Wrappers> {
        let mut d = Dictionary::new();
        d.set(WRAP, Object::Name(b"Open".to_vec()));
        let open = new_stream(pdf, d, b"q\n")?;
        let mut d = Dictionary::new();
        d.set(WRAP, Object::Name(b"Close".to_vec()));
        let close = new_stream(pdf, d, b"\nQ\n")?;
        Ok(Wrappers { open, close })
    }
}

/// Remove the mark streams whose info dictionary is in `infos`; drop the wrappers when no
/// in-front mark is left. Returns whether anything was removed.
pub fn remove_from(pdf: &Pdf, items: &mut Vec<Object>, infos: &[ObjectId]) -> bool {
    let before = items.len();
    items.retain(|o| !matches!(classify(pdf, o), Item::Mark(i) if infos.contains(&i)));
    let removed = items.len() != before;
    let kinds: Vec<Item> = items.iter().map(|o| classify(pdf, o)).collect();
    let close_at = kinds.iter().position(|k| *k == Item::WrapClose);
    let front_left =
        close_at.is_some_and(|c| kinds.iter().skip(c + 1).any(|k| matches!(k, Item::Mark(_))));
    if !front_left
        && kinds
            .iter()
            .any(|k| matches!(k, Item::WrapOpen | Item::WrapClose))
    {
        items.retain(|o| !matches!(classify(pdf, o), Item::WrapOpen | Item::WrapClose));
        return true;
    }
    removed
}

/// A mark's info dictionary.
#[derive(Debug, Clone)]
pub struct Info {
    pub id: String,
    pub spec: String,
    pub picture: Option<ObjectId>,
}

pub fn read_info(pdf: &Pdf, info: ObjectId) -> Option<Info> {
    let d = pdf.get_dict(info)?;
    let text = |k: &[u8]| match d.get(k).ok().and_then(|o| pdf.resolve(o)) {
        Some(Object::String(s, _)) => Some(String::from_utf8_lossy(s).into_owned()),
        _ => None,
    };
    Some(Info {
        id: text(b"Id")?,
        spec: text(b"Spec").unwrap_or_default(),
        picture: match d.get(b"Picture") {
            Ok(Object::Reference(r)) => Some(*r),
            _ => None,
        },
    })
}

pub fn new_info(pdf: &mut Pdf, id: &str, spec: &str, picture: Option<ObjectId>) -> ObjectId {
    let mut d = Dictionary::new();
    d.set("Type", Object::Name(KEY.to_vec()));
    d.set("V", 1);
    d.set(
        "Id",
        Object::String(id.as_bytes().to_vec(), StringFormat::Literal),
    );
    d.set(
        "Spec",
        Object::String(spec.as_bytes().to_vec(), StringFormat::Literal),
    );
    if let Some(p) = picture {
        d.set("Picture", Object::Reference(p));
    }
    pdf.add(Object::Dictionary(d))
}

/// Remove `/XObject` resource entries of the page that point at forms of `infos`.
pub fn drop_form_resources(pdf: &mut Pdf, page_id: ObjectId, infos: &[ObjectId]) -> Result<()> {
    let Some(page) = pdf.get_dict(page_id) else {
        return Ok(());
    };
    // Only resources we made direct on the page are edited (add_resource copies them there).
    let Ok(Object::Dictionary(res)) = page.get(b"Resources") else {
        return Ok(());
    };
    let Some(Object::Dictionary(x)) = res.get(b"XObject").ok().and_then(|o| pdf.resolve(o)) else {
        return Ok(());
    };
    let doomed: Vec<Vec<u8>> = x
        .iter()
        .filter(|(_, v)| {
            stream_dict(pdf, v).is_some_and(
                |d| matches!(d.get(KEY), Ok(Object::Reference(i)) if infos.contains(i)),
            )
        })
        .map(|(k, _)| k.clone())
        .collect();
    if doomed.is_empty() {
        return Ok(());
    }
    let mut x = x.clone();
    for k in &doomed {
        x.remove(k);
    }
    let mut res = res.clone();
    res.set("XObject", Object::Dictionary(x));
    let mut page = page.clone();
    page.set("Resources", Object::Dictionary(res));
    pdf.set(page_id, Object::Dictionary(page));
    Ok(())
}
