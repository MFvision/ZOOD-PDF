//! Document outline (bookmarks) and page labels: reading with every destination form resolved
//! to a page object, and writing new items. Used by Combine (outline merged under one entry per
//! file), Extract/Split (outline kept for the pages that remain) and "split by bookmarks".
//!
//! Every walk is bounded: at most [`MAX_ITEMS`] items, [`MAX_DEPTH`] levels, cycle-checked.

use crate::error::{PdfError, Result};
use crate::Pdf;
use lopdf::{Dictionary, Object, ObjectId, StringFormat};
use std::collections::HashSet;

/// Most outline items read from one document.
pub const MAX_ITEMS: usize = 20_000;
/// Deepest outline nesting read.
pub const MAX_DEPTH: usize = 32;
/// Most name-tree / number-tree nodes visited in one lookup.
const MAX_TREE_NODES: usize = 50_000;

/// A destination resolved to its page object plus the view parameters (`/XYZ l t z`, `/Fit`…).
#[derive(Debug, Clone, PartialEq)]
pub struct Dest {
    /// The page object the destination points at.
    pub page: ObjectId,
    /// The rest of the destination array (direct values only).
    pub view: Vec<Object>,
}

/// One outline item.
#[derive(Debug, Clone, PartialEq)]
pub struct OutlineItem {
    /// The `/Title` bytes as stored (PDF text string).
    pub title: Vec<u8>,
    /// Where the item points, if it resolves to a page of this document.
    pub dest: Option<Dest>,
    /// Child items.
    pub children: Vec<OutlineItem>,
}

impl OutlineItem {
    /// The title decoded (UTF-16BE with BOM, UTF-8 with BOM, else Latin-1).
    pub fn title_text(&self) -> String {
        decode_text(&self.title)
    }
}

/// Decode a PDF text string.
pub fn decode_text(b: &[u8]) -> String {
    if let Some(rest) = b.strip_prefix(&[0xfe, 0xff]) {
        let units: Vec<u16> = rest
            .chunks(2)
            .map(|c| match c {
                [a, b] => u16::from(*a) << 8 | u16::from(*b),
                [a] => u16::from(*a) << 8,
                _ => 0,
            })
            .collect();
        char::decode_utf16(units)
            .map(|r| r.unwrap_or('\u{FFFD}'))
            .collect()
    } else if let Some(rest) = b.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        String::from_utf8_lossy(rest).into_owned()
    } else {
        b.iter().map(|&c| char::from(c)).collect()
    }
}

/// Encode a PDF text string: Latin-1 printable ASCII stays literal, anything else UTF-16BE.
pub fn text_string(s: &str) -> Object {
    if s.bytes().all(|b| (0x20..0x7f).contains(&b)) {
        Object::String(s.as_bytes().to_vec(), StringFormat::Literal)
    } else {
        let mut v = vec![0xfe, 0xff];
        for u in s.encode_utf16() {
            v.extend_from_slice(&u.to_be_bytes());
        }
        Object::String(v, StringFormat::Hexadecimal)
    }
}

fn is_direct_value(o: &Object) -> bool {
    matches!(
        o,
        Object::Null | Object::Integer(_) | Object::Real(_) | Object::Name(_) | Object::Boolean(_)
    )
}

/// Look `key` up in a name tree (`/Names` pairs, `/Kids`), bounded.
fn name_tree_lookup<'a>(pdf: &'a Pdf, root: &'a Object, key: &[u8]) -> Option<&'a Object> {
    let mut stack = vec![root];
    let mut seen = HashSet::new();
    let mut visited = 0usize;
    while let Some(node) = stack.pop() {
        visited += 1;
        if visited > MAX_TREE_NODES {
            return None;
        }
        if let Object::Reference(id) = node {
            if !seen.insert(*id) {
                continue;
            }
        }
        let Some(d) = pdf.resolve(node).and_then(|o| o.as_dict().ok()) else {
            continue;
        };
        if let Some(Object::Array(names)) = d.get(b"Names").ok().and_then(|o| pdf.resolve(o)) {
            for pair in names.chunks(2) {
                if let [k, v] = pair {
                    if let Some(Object::String(s, _)) = pdf.resolve(k) {
                        if s.as_slice() == key {
                            return Some(v);
                        }
                    }
                }
            }
        }
        if let Some(Object::Array(kids)) = d.get(b"Kids").ok().and_then(|o| pdf.resolve(o)) {
            stack.extend(kids.iter());
        }
    }
    None
}

/// Resolve a destination (array, name, string, or a `/D` dictionary) to a page + view.
pub fn resolve_dest(pdf: &Pdf, dest: &Object) -> Option<Dest> {
    let mut cur = pdf.resolve(dest)?;
    for _ in 0..4 {
        match cur {
            Object::Array(a) => {
                let page = match a.first()? {
                    Object::Reference(id) => *id,
                    _ => return None, // remote (page number) destinations are not ours
                };
                let is_page = pdf
                    .get_dict(page)
                    .map(|d| d.has_type(b"Page") || d.has(b"Contents") || d.has(b"MediaBox"))
                    .unwrap_or(false);
                if !is_page {
                    return None;
                }
                let view = a
                    .iter()
                    .skip(1)
                    .take(6)
                    .map(|o| pdf.resolve(o).cloned().unwrap_or(Object::Null))
                    .map(|o| if is_direct_value(&o) { o } else { Object::Null })
                    .collect();
                return Some(Dest { page, view });
            }
            Object::Dictionary(d) => cur = pdf.resolve(d.get(b"D").ok()?)?,
            Object::Name(n) => {
                let cat = pdf.catalog().ok()?;
                let dests = pdf.resolve(cat.get(b"Dests").ok()?)?.as_dict().ok()?;
                cur = pdf.resolve(dests.get(n).ok()?)?;
            }
            Object::String(s, _) => {
                let cat = pdf.catalog().ok()?;
                let names = pdf.resolve(cat.get(b"Names").ok()?)?.as_dict().ok()?;
                let tree = names.get(b"Dests").ok()?;
                cur = pdf.resolve(name_tree_lookup(pdf, tree, s)?)?;
            }
            _ => return None,
        }
    }
    None
}

fn item_dest(pdf: &Pdf, d: &Dictionary) -> Option<Dest> {
    if let Ok(dest) = d.get(b"Dest") {
        return resolve_dest(pdf, dest);
    }
    let action = pdf.resolve(d.get(b"A").ok()?)?.as_dict().ok()?;
    match action.get(b"S").and_then(Object::as_name) {
        Ok(b"GoTo") => resolve_dest(pdf, action.get(b"D").ok()?),
        _ => None,
    }
}

/// Read the outline tree (empty when the document has none).
pub fn read_outline(pdf: &Pdf) -> Result<Vec<OutlineItem>> {
    let Ok(cat) = pdf.catalog() else {
        return Ok(Vec::new());
    };
    let Some(root) = cat
        .get(b"Outlines")
        .ok()
        .and_then(|o| pdf.resolve(o))
        .and_then(|o| o.as_dict().ok())
    else {
        return Ok(Vec::new());
    };
    let mut seen = HashSet::new();
    let mut count = 0usize;
    Ok(read_level(
        pdf,
        root.get(b"First").ok(),
        0,
        &mut seen,
        &mut count,
    ))
}

fn read_level(
    pdf: &Pdf,
    first: Option<&Object>,
    depth: usize,
    seen: &mut HashSet<ObjectId>,
    count: &mut usize,
) -> Vec<OutlineItem> {
    let mut out = Vec::new();
    if depth > MAX_DEPTH {
        return out;
    }
    let mut next = first.and_then(|o| o.as_reference().ok());
    while let Some(id) = next {
        if !seen.insert(id) || *count >= MAX_ITEMS {
            break;
        }
        *count += 1;
        let Some(d) = pdf.get_dict(id) else { break };
        let title = match d.get(b"Title").ok().and_then(|o| pdf.resolve(o)) {
            Some(Object::String(s, _)) => s.clone(),
            _ => Vec::new(),
        };
        let children = read_level(pdf, d.get(b"First").ok(), depth + 1, seen, count);
        out.push(OutlineItem {
            title,
            dest: item_dest(pdf, d),
            children,
        });
        next = d.get(b"Next").ok().and_then(|o| o.as_reference().ok());
    }
    out
}

/// An item to write: title, target page in the destination document, view, children.
#[derive(Debug, Clone, PartialEq)]
pub struct NewItem {
    /// Title (PDF text string bytes, e.g. from [`OutlineItem::title`] or [`text_string`]).
    pub title: Object,
    /// Target page and view.
    pub dest: Option<Dest>,
    /// Children (written closed).
    pub children: Vec<NewItem>,
}

fn count_items(items: &[NewItem]) -> usize {
    items.iter().map(|i| 1 + count_items(&i.children)).sum()
}

/// Write `items` as new objects under `parent`; returns (first, last) ids.
fn write_level(pdf: &mut Pdf, parent: ObjectId, items: &[NewItem]) -> Option<(ObjectId, ObjectId)> {
    let ids: Vec<ObjectId> = items
        .iter()
        .map(|_| pdf.add(Object::Dictionary(Dictionary::new())))
        .collect();
    for (k, item) in items.iter().enumerate() {
        let Some(&id) = ids.get(k) else { continue };
        let mut d = Dictionary::new();
        d.set("Title", item.title.clone());
        d.set("Parent", Object::Reference(parent));
        if k > 0 {
            if let Some(p) = ids.get(k - 1) {
                d.set("Prev", Object::Reference(*p));
            }
        }
        if let Some(n) = ids.get(k + 1) {
            d.set("Next", Object::Reference(*n));
        }
        if let Some(dest) = &item.dest {
            let mut arr = vec![Object::Reference(dest.page)];
            if dest.view.is_empty() {
                arr.push(Object::Name(b"Fit".to_vec()));
            } else {
                arr.extend(dest.view.iter().cloned());
            }
            d.set("Dest", Object::Array(arr));
        }
        if let Some((f, l)) = write_level(pdf, id, &item.children) {
            d.set("First", Object::Reference(f));
            d.set("Last", Object::Reference(l));
            // Negative: closed, with this many visible descendants when opened.
            d.set("Count", Object::Integer(-(item.children.len() as i64)));
        }
        pdf.set(id, Object::Dictionary(d));
    }
    Some((*ids.first()?, *ids.last()?))
}

/// Append `items` at the top level of the document outline (created when missing).
pub fn append_outline(pdf: &mut Pdf, items: &[NewItem]) -> Result<()> {
    if items.is_empty() {
        return Ok(());
    }
    if count_items(items) > MAX_ITEMS {
        return Err(PdfError::Limit("too many outline items".into()));
    }
    let root_id = pdf.root_id()?;
    let mut cat = pdf
        .get_dict(root_id)
        .cloned()
        .ok_or_else(|| PdfError::Structure("catalog is not a dictionary".into()))?;
    let existing = cat
        .get(b"Outlines")
        .ok()
        .and_then(|o| o.as_reference().ok());
    let (outlines_id, mut od) =
        match existing.and_then(|id| pdf.get_dict(id).cloned().map(|d| (id, d))) {
            Some(x) => x,
            None => {
                let mut d = Dictionary::new();
                d.set("Type", Object::Name(b"Outlines".to_vec()));
                let id = pdf.add(Object::Dictionary(d.clone()));
                cat.set("Outlines", Object::Reference(id));
                pdf.set(root_id, Object::Dictionary(cat));
                (id, d)
            }
        };
    let Some((first, last)) = write_level(pdf, outlines_id, items) else {
        return Ok(());
    };
    let old_last = od.get(b"Last").ok().and_then(|o| o.as_reference().ok());
    match old_last.and_then(|id| pdf.get_dict(id).cloned().map(|d| (id, d))) {
        Some((lid, mut ld)) => {
            ld.set("Next", Object::Reference(first));
            pdf.set(lid, Object::Dictionary(ld));
            if let Some(mut fd) = pdf.get_dict(first).cloned() {
                fd.set("Prev", Object::Reference(lid));
                pdf.set(first, Object::Dictionary(fd));
            }
        }
        None => od.set("First", Object::Reference(first)),
    }
    od.set("Last", Object::Reference(last));
    let old_count = od
        .get(b"Count")
        .ok()
        .and_then(|o| o.as_i64().ok())
        .unwrap_or(0)
        .max(0);
    od.set("Count", Object::Integer(old_count + items.len() as i64));
    pdf.set(outlines_id, Object::Dictionary(od));
    Ok(())
}

/// Page-label ranges `(first page index, label dictionary)` from `/PageLabels` (sorted).
pub fn read_page_labels(pdf: &Pdf) -> Vec<(i64, Dictionary)> {
    let mut out = Vec::new();
    let Ok(cat) = pdf.catalog() else { return out };
    let Ok(root) = cat.get(b"PageLabels") else {
        return out;
    };
    let mut stack = vec![root];
    let mut seen = HashSet::new();
    let mut visited = 0usize;
    while let Some(node) = stack.pop() {
        visited += 1;
        if visited > MAX_TREE_NODES {
            break;
        }
        if let Object::Reference(id) = node {
            if !seen.insert(*id) {
                continue;
            }
        }
        let Some(d) = pdf.resolve(node).and_then(|o| o.as_dict().ok()) else {
            continue;
        };
        if let Some(Object::Array(nums)) = d.get(b"Nums").ok().and_then(|o| pdf.resolve(o)) {
            for pair in nums.chunks(2) {
                if let [k, v] = pair {
                    let key = pdf.resolve(k).and_then(|o| o.as_i64().ok());
                    let val = pdf.resolve(v).and_then(|o| o.as_dict().ok());
                    if let (Some(k), Some(v)) = (key, val) {
                        // Keep only direct values: /S name, /P string, /St integer.
                        let mut clean = Dictionary::new();
                        for key in [b"S".as_slice(), b"P", b"St"] {
                            if let Some(o) = v.get(key).ok().and_then(|o| pdf.resolve(o)) {
                                if matches!(
                                    o,
                                    Object::Name(_) | Object::String(..) | Object::Integer(_)
                                ) {
                                    clean.set(key.to_vec(), o.clone());
                                }
                            }
                        }
                        if k >= 0 {
                            out.push((k, clean));
                        }
                    }
                }
            }
        }
        if let Some(Object::Array(kids)) = d.get(b"Kids").ok().and_then(|o| pdf.resolve(o)) {
            stack.extend(kids.iter());
        }
    }
    out.sort_by_key(|(k, _)| *k);
    out.dedup_by_key(|(k, _)| *k);
    out
}

/// Replace `/PageLabels` with a flat number tree holding `ranges`.
pub fn write_page_labels(pdf: &mut Pdf, ranges: &[(i64, Dictionary)]) -> Result<()> {
    let root_id = pdf.root_id()?;
    let mut cat = pdf
        .get_dict(root_id)
        .cloned()
        .ok_or_else(|| PdfError::Structure("catalog is not a dictionary".into()))?;
    let mut nums = Vec::with_capacity(ranges.len() * 2);
    for (k, d) in ranges {
        nums.push(Object::Integer(*k));
        nums.push(Object::Dictionary(d.clone()));
    }
    let mut tree = Dictionary::new();
    tree.set("Nums", Object::Array(nums));
    let id = pdf.add(Object::Dictionary(tree));
    cat.set("PageLabels", Object::Reference(id));
    pdf.set(root_id, Object::Dictionary(cat));
    Ok(())
}
