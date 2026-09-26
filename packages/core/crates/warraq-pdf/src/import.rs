//! Copying pages between documents (Insert from file, Replace, Extract, Split, Combine) with
//! what belongs to them: the objects they reference (deep copy, renumbered), their bookmarks,
//! their form fields (added to the target `/AcroForm`, clashing names renamed) and — when the
//! pages are appended at the end — their page labels.

use crate::error::{PdfError, Result};
use crate::outline::{self, Dest, NewItem, OutlineItem};
use crate::pages::{
    check_indices, flatten, flatten_with_nodes, page_dict, pages_root, rebuild, PageInfo,
};
use crate::pdf::map_refs;
use crate::{Limits, Pdf};
use lopdf::{Dictionary, Object, ObjectId, StringFormat};
use std::collections::{BTreeMap, HashMap, HashSet};

/// What comes along with imported pages.
#[derive(Debug, Clone)]
pub struct ImportOptions {
    /// Copy the source outline items that point at imported pages.
    pub outline: bool,
    /// Put the copied outline under one new top-level item with this title (pointing at the
    /// first imported page). Used by Combine: one entry per file.
    pub outline_title: Option<String>,
    /// Add the source form fields of imported widgets to the target `/AcroForm`.
    pub forms: bool,
    /// Merge the source page labels (only when the pages are appended at the end).
    pub page_labels: bool,
}

impl Default for ImportOptions {
    fn default() -> Self {
        ImportOptions {
            outline: true,
            outline_title: None,
            forms: true,
            page_labels: true,
        }
    }
}

/// Deep copier from `src` into a target numbering space starting at `next`.
struct Copier<'a> {
    src: &'a Pdf,
    limits: Limits,
    map: HashMap<ObjectId, ObjectId>,
    next: u32,
    out: BTreeMap<ObjectId, Object>,
    /// Source pages being copied (references to other pages become null).
    selected: HashSet<ObjectId>,
    src_root: Option<ObjectId>,
    copied: usize,
}

impl<'a> Copier<'a> {
    fn new(src: &'a Pdf, limits: Limits, next: u32) -> Self {
        Copier {
            src,
            limits,
            map: HashMap::new(),
            next,
            out: BTreeMap::new(),
            selected: HashSet::new(),
            src_root: src.root_id().ok(),
            copied: 0,
        }
    }

    fn alloc(&mut self) -> ObjectId {
        let id = (self.next, 0);
        self.next += 1;
        id
    }

    /// Remap every reference in `obj`, scheduling newly seen objects for copying.
    fn remap(&mut self, obj: &mut Object, work: &mut Vec<ObjectId>) -> Result<()> {
        let Copier {
            src,
            limits,
            map,
            next,
            selected,
            src_root,
            ..
        } = self;
        map_refs(obj, 0, limits, &mut |r| {
            if let Some(n) = map.get(&r) {
                return Object::Reference(*n);
            }
            if Some(r) == *src_root || selected.contains(&r) {
                return Object::Null;
            }
            match src.get_dict(r) {
                Some(d)
                    if d.has_type(b"Page") || d.has_type(b"Pages") || d.has_type(b"Catalog") =>
                {
                    return Object::Null
                }
                _ => {}
            }
            if src.get(r).is_none() {
                return Object::Null;
            }
            let n = (*next, 0);
            *next += 1;
            map.insert(r, n);
            work.push(r);
            Object::Reference(n)
        })
    }

    /// Copy `obj` (a direct object) and everything it references; returns the copy.
    fn copy(&mut self, obj: &Object) -> Result<Object> {
        let mut work = Vec::new();
        let mut o = obj.clone();
        self.remap(&mut o, &mut work)?;
        self.drain(work)?;
        Ok(o)
    }

    fn drain(&mut self, mut work: Vec<ObjectId>) -> Result<()> {
        while let Some(sid) = work.pop() {
            self.copied += 1;
            if self.copied > self.limits.max_objects {
                return Err(PdfError::Limit("too many objects to copy".into()));
            }
            let Some(nid) = self.map.get(&sid).copied() else {
                continue;
            };
            let Some(obj) = self.src.get(sid) else {
                continue;
            };
            let mut o = obj.clone();
            self.remap(&mut o, &mut work)?;
            self.out.insert(nid, o);
        }
        Ok(())
    }
}

/// Map an outline item's destination into the target (`None` when its page was not copied).
fn map_items(items: &[OutlineItem], map: &HashMap<ObjectId, ObjectId>) -> Vec<NewItem> {
    let mut out = Vec::new();
    for it in items {
        let dest = it.dest.as_ref().and_then(|d| {
            map.get(&d.page).map(|p| Dest {
                page: *p,
                view: d.view.clone(),
            })
        });
        let children = map_items(&it.children, map);
        if dest.is_none() && children.is_empty() {
            continue;
        }
        out.push(NewItem {
            title: Object::String(it.title.clone(), StringFormat::Literal),
            dest,
            children,
        });
    }
    out
}

fn field_name(pdf: &Pdf, d: &Dictionary) -> Option<Vec<u8>> {
    match d.get(b"T").ok().and_then(|o| pdf.resolve(o)) {
        Some(Object::String(s, _)) => Some(s.clone()),
        _ => None,
    }
}

fn acroform(pdf: &Pdf) -> Option<Dictionary> {
    let cat = pdf.catalog().ok()?;
    pdf.resolve(cat.get(b"AcroForm").ok()?)?
        .as_dict()
        .ok()
        .cloned()
}

fn field_refs(pdf: &Pdf, form: &Dictionary) -> Vec<ObjectId> {
    match form.get(b"Fields").ok().and_then(|o| pdf.resolve(o)) {
        Some(Object::Array(a)) => a.iter().filter_map(|o| o.as_reference().ok()).collect(),
        _ => Vec::new(),
    }
}

/// Make `name` unique among `taken` by appending `_2`, `_3`, … (UTF-16 names get the suffix in
/// UTF-16).
fn unique_name(name: &[u8], taken: &HashSet<Vec<u8>>) -> Vec<u8> {
    if !taken.contains(name) {
        return name.to_vec();
    }
    let utf16 = name.starts_with(&[0xfe, 0xff]);
    for k in 2..10_000u32 {
        let suffix = format!("_{k}");
        let mut cand = name.to_vec();
        if utf16 {
            for u in suffix.encode_utf16() {
                cand.extend_from_slice(&u.to_be_bytes());
            }
        } else {
            cand.extend_from_slice(suffix.as_bytes());
        }
        if !taken.contains(&cand) {
            return cand;
        }
    }
    name.to_vec()
}

/// Copy pages `indices` of `src` into `dst` at position `at`, with the extras chosen in `opts`.
/// Returns the new page ids in order.
pub fn import_pages(
    dst: &mut Pdf,
    src: &Pdf,
    indices: &[usize],
    at: usize,
    opts: &ImportOptions,
) -> Result<Vec<ObjectId>> {
    dst.require("inserting pages", |p| p.assemble || p.modify)?;
    src.require("copying pages", |p| p.copy || p.assemble || p.modify)?;
    let limits = *dst.limits();
    let src_pages = flatten(src)?;
    check_indices(indices, src_pages.len())?;
    let (mut pages, nodes) = flatten_with_nodes(dst)?;
    let original_count = pages.len();
    let root = pages_root(dst)?;

    let mut c = Copier::new(src, limits, dst.next_number());
    let mut new_pages = Vec::new();
    for &i in indices {
        let Some(p) = src_pages.get(i) else { continue };
        // The same source page may be inserted twice: give each copy its own id.
        let nid = c.alloc();
        new_pages.push((p.clone(), nid));
        c.map.entry(p.id).or_insert(nid);
        c.selected.insert(p.id);
    }
    let mut infos = Vec::new();
    for (p, nid) in &new_pages {
        let mut d = page_dict(src, p.id)?;
        d.remove(b"Parent");
        d.remove(b"StructParents");
        d.set("MediaBox", box_obj(p.media_box));
        if let Some(cb) = p.crop_box {
            d.set("CropBox", box_obj(cb));
        }
        d.set("Rotate", Object::Integer(p.rotate));
        if let Some(r) = &p.resources {
            d.set("Resources", r.clone());
        }
        let mut o = c.copy(&Object::Dictionary(d))?;
        if let Object::Dictionary(d) = &mut o {
            d.set("Parent", Object::Reference(root));
        }
        c.out.insert(*nid, o);
        infos.push(PageInfo {
            id: *nid,
            media_box: p.media_box,
            crop_box: p.crop_box,
            rotate: p.rotate,
            resources: None,
        });
    }

    // Form fields: top-level source fields whose copies exist (reached through the widgets).
    let mut new_fields: Vec<ObjectId> = Vec::new();
    let mut src_dr: Option<Object> = None;
    if opts.forms {
        if let Some(sf) = acroform(src) {
            for f in field_refs(src, &sf) {
                if let Some(n) = c.map.get(&f) {
                    new_fields.push(*n);
                }
            }
            if !new_fields.is_empty() {
                if let Ok(dr) = sf.get(b"DR") {
                    src_dr = Some(c.copy(dr)?);
                }
            }
        }
    }

    let outline_items = if opts.outline || opts.outline_title.is_some() {
        let items = if opts.outline {
            map_items(&outline::read_outline(src)?, &c.map)
        } else {
            Vec::new()
        };
        match (&opts.outline_title, infos.first()) {
            (Some(t), Some(first)) => vec![NewItem {
                title: outline::text_string(t),
                dest: Some(Dest {
                    page: first.id,
                    view: Vec::new(),
                }),
                children: items,
            }],
            _ => items,
        }
    } else {
        Vec::new()
    };

    let src_labels = if opts.page_labels && at >= original_count {
        outline::read_page_labels(src)
    } else {
        Vec::new()
    };

    for (id, o) in std::mem::take(&mut c.out) {
        dst.set(id, o);
    }
    let at = at.min(pages.len());
    let ids: Vec<ObjectId> = infos.iter().map(|p| p.id).collect();
    for (k, info) in infos.into_iter().enumerate() {
        pages.insert(at + k, info);
    }
    rebuild(dst, &pages, &nodes)?;

    if !new_fields.is_empty() {
        add_fields(dst, &new_fields, src_dr)?;
    }
    outline::append_outline(dst, &outline_items)?;
    if opts.page_labels && at >= original_count {
        merge_labels(dst, src, &src_labels, original_count as i64, indices)?;
    }
    Ok(ids)
}

fn box_obj(b: [f64; 4]) -> Object {
    Object::Array(b.iter().map(|v| Object::Real(*v as f32)).collect())
}

/// Append `fields` (already copied into `dst`) to the target AcroForm, renaming clashes.
fn add_fields(dst: &mut Pdf, fields: &[ObjectId], src_dr: Option<Object>) -> Result<()> {
    let root_id = dst.root_id()?;
    let mut cat = dst
        .get_dict(root_id)
        .cloned()
        .ok_or_else(|| PdfError::Structure("catalog is not a dictionary".into()))?;
    let form_ref = cat
        .get(b"AcroForm")
        .ok()
        .and_then(|o| o.as_reference().ok());
    let mut form = acroform(dst).unwrap_or_default();
    let mut list = match form.get(b"Fields").ok().and_then(|o| dst.resolve(o)) {
        Some(Object::Array(a)) => a.clone(),
        _ => Vec::new(),
    };
    let mut taken: HashSet<Vec<u8>> = list
        .iter()
        .filter_map(|o| o.as_reference().ok())
        .filter_map(|id| dst.get_dict(id))
        .filter_map(|d| field_name(dst, d))
        .collect();
    for &f in fields {
        if let Some(mut d) = dst.get_dict(f).cloned() {
            if let Some(name) = field_name(dst, &d) {
                let u = unique_name(&name, &taken);
                if u != name {
                    d.set("T", Object::String(u.clone(), StringFormat::Literal));
                    let obj = match dst.get(f) {
                        Some(Object::Stream(s)) => {
                            let mut s = s.clone();
                            s.dict = d;
                            Object::Stream(s)
                        }
                        _ => Object::Dictionary(d),
                    };
                    dst.set(f, obj);
                }
                taken.insert(u);
            }
        }
        list.push(Object::Reference(f));
    }
    form.set("Fields", Object::Array(list));
    if !form.has(b"DR") {
        if let Some(dr) = src_dr {
            form.set("DR", dr);
        }
    }
    if !form.has(b"DA") {
        form.set(
            "DA",
            Object::String(b"/Helv 0 Tf 0 g".to_vec(), StringFormat::Literal),
        );
    }
    match form_ref {
        Some(id) => dst.set(id, Object::Dictionary(form)),
        None => {
            let id = dst.add(Object::Dictionary(form));
            cat.set("AcroForm", Object::Reference(id));
            dst.set(root_id, Object::Dictionary(cat));
        }
    }
    Ok(())
}

fn decimal() -> Dictionary {
    let mut d = Dictionary::new();
    d.set("S", Object::Name(b"D".to_vec()));
    d
}

/// Page labels for pages appended at `offset`: the source's own ranges (when all its pages
/// came in order) or plain decimal numbering restarting at 1, so every file keeps its numbers.
fn merge_labels(
    dst: &mut Pdf,
    src: &Pdf,
    src_labels: &[(i64, Dictionary)],
    offset: i64,
    indices: &[usize],
) -> Result<()> {
    let mut ranges = outline::read_page_labels(dst);
    let whole = indices.iter().enumerate().all(|(k, &i)| k == i)
        && crate::pages::count(src)
            .map(|n| n == indices.len())
            .unwrap_or(false);
    if src_labels.is_empty() && ranges.is_empty() {
        return Ok(());
    }
    if ranges.is_empty() && offset > 0 {
        ranges.push((0, decimal()));
    }
    if whole && !src_labels.is_empty() {
        if src_labels.first().map(|(k, _)| *k > 0).unwrap_or(false) {
            ranges.push((offset, decimal()));
        }
        for (k, d) in src_labels {
            ranges.push((offset + k, d.clone()));
        }
    } else {
        ranges.push((offset, decimal()));
    }
    ranges.sort_by_key(|(k, _)| *k);
    ranges.dedup_by(|b, a| {
        // keep the later entry for the same start
        if a.0 == b.0 {
            a.1 = b.1.clone();
            true
        } else {
            false
        }
    });
    outline::write_page_labels(dst, &ranges)
}

/// A new, unencrypted document made of `parts`: each `(source, page indices, outline title)`.
pub fn assemble(parts: &[(&Pdf, Vec<usize>, Option<String>)]) -> Result<Vec<u8>> {
    let limits = parts
        .first()
        .map(|(p, _, _)| *p.limits())
        .unwrap_or_default();
    let mut base = Pdf::open_with_limits(crate::builder::empty_pdf()?, None, limits)?;
    for (src, indices, title) in parts {
        let at = crate::pages::count(&base)?;
        let opts = ImportOptions {
            outline_title: title.clone(),
            ..ImportOptions::default()
        };
        import_pages(&mut base, src, indices, at, &opts)?;
    }
    base.write_full(crate::Protection::Remove)
}
