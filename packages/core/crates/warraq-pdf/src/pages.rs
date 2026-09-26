//! Page tree operations for the Organize tool. All edits go through `Pdf::set/add/delete`
//! and are therefore written as incremental updates by `Pdf::commit`.
//!
//! Reorder/delete/insert flatten the tree: every page gets its inherited attributes
//! (Resources, MediaBox, CropBox, Rotate) materialised and becomes a direct kid of the root
//! `/Pages` node; intermediate nodes that are no longer used are freed.

use crate::error::{PdfError, Result};
use crate::Pdf;
use lopdf::{Dictionary, Object, ObjectId};
use std::collections::{BTreeSet, HashSet};

/// A page with its inherited attributes resolved.
#[derive(Debug, Clone)]
pub struct PageInfo {
    /// The page object.
    pub id: ObjectId,
    /// Effective /MediaBox (normalised x0 < x1, y0 < y1). Defaults to US Letter.
    pub media_box: [f64; 4],
    /// Effective /CropBox if present.
    pub crop_box: Option<[f64; 4]>,
    /// Effective /Rotate normalised to 0, 90, 180, 270.
    pub rotate: i64,
    /// Effective /Resources (direct object or reference).
    pub resources: Option<Object>,
}

impl PageInfo {
    /// Visible box: crop box clipped to the media box.
    pub fn visible_box(&self) -> [f64; 4] {
        let m = self.media_box;
        match self.crop_box {
            Some(c) => {
                let b = [
                    c[0].max(m[0]),
                    c[1].max(m[1]),
                    c[2].min(m[2]),
                    c[3].min(m[3]),
                ];
                if b[2] > b[0] && b[3] > b[1] {
                    b
                } else {
                    m
                }
            }
            None => m,
        }
    }

    /// Width and height of the visible box before rotation.
    pub fn size(&self) -> (f64, f64) {
        let b = self.visible_box();
        (b[2] - b[0], b[3] - b[1])
    }
}

#[derive(Clone, Default)]
struct Inherited {
    media: Option<[f64; 4]>,
    crop: Option<[f64; 4]>,
    rotate: Option<i64>,
    resources: Option<Object>,
}

fn parse_box(pdf: &Pdf, o: &Object) -> Option<[f64; 4]> {
    let arr = pdf.resolve(o)?.as_array().ok()?;
    let mut v = [0f64; 4];
    if arr.len() != 4 {
        return None;
    }
    for (slot, item) in v.iter_mut().zip(arr.iter()) {
        *slot = match pdf.resolve(item)? {
            Object::Integer(i) => *i as f64,
            Object::Real(r) => f64::from(*r),
            _ => return None,
        };
        if !slot.is_finite() {
            return None;
        }
    }
    Some([
        v[0].min(v[2]),
        v[1].min(v[3]),
        v[0].max(v[2]),
        v[1].max(v[3]),
    ])
}

fn norm_rotate(r: i64) -> i64 {
    r.rem_euclid(360) / 90 * 90
}

fn box_obj(b: [f64; 4]) -> Object {
    Object::Array(b.iter().map(|v| Object::Real(*v as f32)).collect())
}

/// The root `/Pages` node id.
pub fn pages_root(pdf: &Pdf) -> Result<ObjectId> {
    pdf.catalog()?
        .get(b"Pages")
        .and_then(Object::as_reference)
        .map_err(|_| PdfError::Structure("catalog has no /Pages".into()))
}

/// Flatten the page tree: pages in order plus all intermediate node ids.
pub fn flatten_with_nodes(pdf: &Pdf) -> Result<(Vec<PageInfo>, Vec<ObjectId>)> {
    let limits = *pdf.limits();
    let root = pages_root(pdf)?;
    let mut pages = Vec::new();
    let mut nodes = Vec::new();
    let mut seen = HashSet::new();
    let mut stack = vec![(root, Inherited::default(), 0usize)];
    while let Some((id, inh, depth)) = stack.pop() {
        limits.check_depth(depth)?;
        if !seen.insert(id) {
            continue; // cycle or shared node: visit once
        }
        let Some(d) = pdf.get_dict(id) else { continue };
        let mut here = inh.clone();
        if let Some(b) = d.get(b"MediaBox").ok().and_then(|o| parse_box(pdf, o)) {
            here.media = Some(b);
        }
        if let Some(b) = d.get(b"CropBox").ok().and_then(|o| parse_box(pdf, o)) {
            here.crop = Some(b);
        }
        if let Some(r) = d
            .get(b"Rotate")
            .ok()
            .and_then(|o| pdf.resolve(o))
            .and_then(|o| o.as_i64().ok())
        {
            here.rotate = Some(r);
        }
        if let Ok(r) = d.get(b"Resources") {
            here.resources = Some(r.clone());
        }
        let is_node = d.has_type(b"Pages") || (!d.has_type(b"Page") && d.has(b"Kids"));
        if is_node {
            nodes.push(id);
            let kids = d
                .get(b"Kids")
                .ok()
                .and_then(|k| pdf.resolve(k))
                .and_then(|k| k.as_array().ok())
                .cloned()
                .unwrap_or_default();
            for k in kids.iter().rev() {
                if let Object::Reference(kid) = k {
                    stack.push((*kid, here.clone(), depth + 1));
                }
            }
        } else {
            if pages.len() >= limits.max_pages {
                return Err(PdfError::Limit(format!(
                    "more than {} pages",
                    limits.max_pages
                )));
            }
            pages.push(PageInfo {
                id,
                media_box: here.media.unwrap_or([0.0, 0.0, 612.0, 792.0]),
                crop_box: here.crop,
                rotate: norm_rotate(here.rotate.unwrap_or(0)),
                resources: here.resources,
            });
        }
    }
    Ok((pages, nodes))
}

/// Flatten the page tree.
pub fn flatten(pdf: &Pdf) -> Result<Vec<PageInfo>> {
    flatten_with_nodes(pdf).map(|(p, _)| p)
}

/// Number of pages.
pub fn count(pdf: &Pdf) -> Result<usize> {
    flatten(pdf).map(|p| p.len())
}

pub(crate) fn check_indices(indices: &[usize], n: usize) -> Result<()> {
    if indices.is_empty() {
        return Err(PdfError::InvalidArgument("no pages given".into()));
    }
    for &i in indices {
        if i >= n {
            return Err(PdfError::InvalidArgument(format!(
                "page {} does not exist ({} pages)",
                i + 1,
                n
            )));
        }
    }
    Ok(())
}

pub(crate) fn page_dict(pdf: &Pdf, id: ObjectId) -> Result<Dictionary> {
    pdf.get_dict(id)
        .cloned()
        .ok_or_else(|| PdfError::Structure(format!("page {} {} is not a dictionary", id.0, id.1)))
}

fn assemble(p: &crate::PermissionFlags) -> bool {
    p.assemble || p.modify
}

/// Rotate pages by `degrees` (multiple of 90, relative to the current rotation).
pub fn rotate(pdf: &mut Pdf, indices: &[usize], degrees: i64) -> Result<()> {
    pdf.require("rotating pages", assemble)?;
    if degrees % 90 != 0 {
        return Err(PdfError::InvalidArgument(
            "rotation must be a multiple of 90°".into(),
        ));
    }
    let pages = flatten(pdf)?;
    check_indices(indices, pages.len())?;
    let unique: BTreeSet<usize> = indices.iter().copied().collect();
    for i in unique {
        let Some(p) = pages.get(i) else { continue };
        let mut d = page_dict(pdf, p.id)?;
        d.set("Rotate", Object::Integer(norm_rotate(p.rotate + degrees)));
        pdf.set(p.id, Object::Dictionary(d));
    }
    Ok(())
}

/// Set the crop box of pages (`[x0, y0, x1, y1]` in default user space).
pub fn crop(pdf: &mut Pdf, indices: &[usize], rect: [f64; 4]) -> Result<()> {
    pdf.require("cropping pages", assemble)?;
    if !rect.iter().all(|v| v.is_finite()) || rect[2] <= rect[0] || rect[3] <= rect[1] {
        return Err(PdfError::InvalidArgument(
            "crop box must have x0 < x1 and y0 < y1".into(),
        ));
    }
    let pages = flatten(pdf)?;
    check_indices(indices, pages.len())?;
    for &i in indices {
        let Some(p) = pages.get(i) else { continue };
        let mut d = page_dict(pdf, p.id)?;
        d.set("CropBox", box_obj(rect));
        pdf.set(p.id, Object::Dictionary(d));
    }
    Ok(())
}

/// Make `list` the page sequence: one flat root node, inherited attributes materialised.
pub(crate) fn rebuild(pdf: &mut Pdf, list: &[PageInfo], old_nodes: &[ObjectId]) -> Result<()> {
    let root = pages_root(pdf)?;
    let mut kids = Vec::with_capacity(list.len());
    let mut done = HashSet::new();
    for p in list {
        if !done.insert(p.id) {
            return Err(PdfError::Structure(
                "the same page object appears twice".into(),
            ));
        }
        let mut d = page_dict(pdf, p.id)?;
        let before = d.clone();
        d.set("Parent", Object::Reference(root));
        if !d.has(b"MediaBox") {
            d.set("MediaBox", box_obj(p.media_box));
        }
        if !d.has(b"CropBox") {
            if let Some(c) = p.crop_box {
                d.set("CropBox", box_obj(c));
            }
        }
        if !d.has(b"Rotate") && p.rotate != 0 {
            d.set("Rotate", Object::Integer(p.rotate));
        }
        if !d.has(b"Resources") {
            d.set(
                "Resources",
                p.resources
                    .clone()
                    .unwrap_or_else(|| Object::Dictionary(Dictionary::new())),
            );
        }
        let changed = !crate::compare::objects_equal(
            &Object::Dictionary(before),
            &Object::Dictionary(d.clone()),
            pdf.limits(),
        );
        if changed {
            pdf.set(p.id, Object::Dictionary(d));
        }
        kids.push(Object::Reference(p.id));
    }
    let mut rd = page_dict(pdf, root)?;
    rd.set("Type", Object::Name(b"Pages".to_vec()));
    rd.set("Kids", Object::Array(kids));
    rd.set("Count", Object::Integer(list.len() as i64));
    rd.remove(b"Parent");
    pdf.set(root, Object::Dictionary(rd));
    for n in old_nodes {
        if *n != root {
            pdf.delete(*n);
        }
    }
    Ok(())
}

/// Reorder pages: `order[k]` is the old index of the page that becomes page `k`.
pub fn reorder(pdf: &mut Pdf, order: &[usize]) -> Result<()> {
    pdf.require("reordering pages", assemble)?;
    let (pages, nodes) = flatten_with_nodes(pdf)?;
    let mut sorted = order.to_vec();
    sorted.sort_unstable();
    if sorted != (0..pages.len()).collect::<Vec<_>>() {
        return Err(PdfError::InvalidArgument(
            "order must be a permutation of all pages".into(),
        ));
    }
    let list: Vec<PageInfo> = order
        .iter()
        .filter_map(|&i| pages.get(i).cloned())
        .collect();
    rebuild(pdf, &list, &nodes)
}

/// Move the pages at `indices` (kept in their relative order) so that the first of them
/// lands at position `to` of the resulting document.
pub fn move_to(pdf: &mut Pdf, indices: &[usize], to: usize) -> Result<()> {
    let n = count(pdf)?;
    check_indices(indices, n)?;
    let moving: BTreeSet<usize> = indices.iter().copied().collect();
    let rest: Vec<usize> = (0..n).filter(|i| !moving.contains(i)).collect();
    let to = to.min(rest.len());
    let mut order: Vec<usize> = rest.get(..to).unwrap_or_default().to_vec();
    order.extend(moving.iter().copied());
    order.extend(rest.get(to..).unwrap_or_default().iter().copied());
    reorder(pdf, &order)
}

/// Delete pages. A document keeps at least one page.
pub fn delete(pdf: &mut Pdf, indices: &[usize]) -> Result<()> {
    pdf.require("deleting pages", assemble)?;
    let (pages, nodes) = flatten_with_nodes(pdf)?;
    check_indices(indices, pages.len())?;
    let gone: BTreeSet<usize> = indices.iter().copied().collect();
    if gone.len() >= pages.len() {
        return Err(PdfError::InvalidArgument(
            "a document needs at least one page".into(),
        ));
    }
    let list: Vec<PageInfo> = pages
        .iter()
        .enumerate()
        .filter(|(i, _)| !gone.contains(i))
        .map(|(_, p)| p.clone())
        .collect();
    rebuild(pdf, &list, &nodes)?;
    for i in gone {
        if let Some(p) = pages.get(i) {
            pdf.delete(p.id);
        }
    }
    Ok(())
}

/// Insert a blank page of `width`×`height` points at position `at`.
pub fn insert_blank(pdf: &mut Pdf, at: usize, width: f64, height: f64) -> Result<ObjectId> {
    pdf.require("inserting pages", assemble)?;
    if !(1.0..=14_400.0).contains(&width) || !(1.0..=14_400.0).contains(&height) {
        return Err(PdfError::InvalidArgument(
            "page size must be 1–14400 points".into(),
        ));
    }
    let (mut pages, nodes) = flatten_with_nodes(pdf)?;
    let root = pages_root(pdf)?;
    let mut d = Dictionary::new();
    d.set("Type", Object::Name(b"Page".to_vec()));
    d.set("Parent", Object::Reference(root));
    d.set("MediaBox", box_obj([0.0, 0.0, width, height]));
    d.set("Resources", Object::Dictionary(Dictionary::new()));
    let id = pdf.add(Object::Dictionary(d));
    let info = PageInfo {
        id,
        media_box: [0.0, 0.0, width, height],
        crop_box: None,
        rotate: 0,
        resources: None,
    };
    let at = at.min(pages.len());
    pages.insert(at, info);
    rebuild(pdf, &pages, &nodes)?;
    Ok(id)
}

/// Deep-copy pages `indices` of `src` into `dst` at position `at`. Every object reachable
/// from the copied pages is renumbered into `dst`; references to pages that are not copied,
/// to page-tree nodes and to the source catalog become `null`. Bookmarks pointing at the
/// copied pages and their form fields come along (see [`crate::import`]).
pub fn insert_from(
    dst: &mut Pdf,
    src: &Pdf,
    indices: &[usize],
    at: usize,
) -> Result<Vec<ObjectId>> {
    crate::import::import_pages(
        dst,
        src,
        indices,
        at,
        &crate::import::ImportOptions::default(),
    )
}

/// A new document containing pages `indices` of `src` (unencrypted, garbage-collected), with
/// the bookmarks, form fields and page labels that belong to those pages.
pub fn extract(src: &Pdf, indices: &[usize]) -> Result<Vec<u8>> {
    crate::import::assemble(&[(src, indices.to_vec(), None)])
}

/// Concatenate all pages of `docs` into a new document.
pub fn merge(docs: &[Pdf]) -> Result<Vec<u8>> {
    let titled: Vec<(&Pdf, Option<String>)> = docs.iter().map(|d| (d, None)).collect();
    merge_titled(&titled)
}

/// Concatenate all pages of `docs`; each file with a title gets one top-level bookmark (its
/// own bookmarks nested under it). Form fields are merged (clashing names renamed) and page
/// labels kept per file.
pub fn merge_titled(docs: &[(&Pdf, Option<String>)]) -> Result<Vec<u8>> {
    if docs.is_empty() {
        return Err(PdfError::InvalidArgument("nothing to merge".into()));
    }
    let mut parts = Vec::with_capacity(docs.len());
    for (d, title) in docs {
        let n = count(d)?;
        parts.push((*d, (0..n).collect::<Vec<_>>(), title.clone()));
    }
    crate::import::assemble(&parts)
}

/// Insert a ready-made page dictionary at `at` (its `/Parent` is set here).
pub fn insert_page_dict(pdf: &mut Pdf, at: usize, mut d: Dictionary) -> Result<ObjectId> {
    pdf.require("inserting pages", assemble)?;
    let (mut pages, nodes) = flatten_with_nodes(pdf)?;
    let root = pages_root(pdf)?;
    let media = d
        .get(b"MediaBox")
        .ok()
        .and_then(|o| parse_box(pdf, o))
        .unwrap_or([0.0, 0.0, 595.276, 841.89]);
    d.set("Type", Object::Name(b"Page".to_vec()));
    d.set("Parent", Object::Reference(root));
    d.set("MediaBox", box_obj(media));
    if !d.has(b"Resources") {
        d.set("Resources", Object::Dictionary(Dictionary::new()));
    }
    let id = pdf.add(Object::Dictionary(d));
    let info = PageInfo {
        id,
        media_box: media,
        crop_box: None,
        rotate: 0,
        resources: None,
    };
    let at = at.min(pages.len());
    pages.insert(at, info);
    rebuild(pdf, &pages, &nodes)?;
    Ok(id)
}
