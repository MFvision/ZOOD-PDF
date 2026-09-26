//! The structure tree as the UI lists it: elements in reading (tree) order with their type, text in
//! logical order (the words of their marked content, as warraq-text orders them), page, box, alt
//! text and language.

use std::collections::HashMap;

use lopdf::{Object, ObjectId};
use serde::Serialize;
use warraq_pdf::{pages, Pdf};
use warraq_text::geom::Rect;

use crate::autotag::current_title;
use crate::error::Result;
use crate::pagemap::PageMap;
use crate::tree::{Kid, Tree};

/// Pages whose text is read for the listing (bigger documents list types without text).
pub const MAX_TEXT_PAGES: usize = 300;
/// Characters of text preview per element.
pub const PREVIEW: usize = 280;

/// What one MCID on a page shows.
#[derive(Debug, Clone, Default)]
pub struct McInfo {
    /// Words in logical order.
    pub text: String,
    /// Top-left box.
    pub bbox: Option<Rect>,
    /// Draws a picture.
    pub image: bool,
}

/// Map every MCID of a page to its words (logical order) and box.
pub fn mcid_info(pm: &PageMap) -> HashMap<i64, McInfo> {
    let mut out: HashMap<i64, McInfo> = HashMap::new();
    let mut word_votes: HashMap<usize, HashMap<i64, usize>> = HashMap::new();
    for (si, s) in pm.scan.shows.iter().enumerate() {
        let Some(m) = pm.marks.get(s.op).and_then(|m| m.mcid) else {
            continue;
        };
        let e = out.entry(m).or_default();
        for g in &s.glyphs {
            let r = pm.to_tl(&g.bbox);
            if r.width() > 0.0 || r.height() > 0.0 {
                e.bbox = Some(e.bbox.map_or(r, |b| b.union(&r)));
            }
        }
        for (w, n) in pm.show_votes.get(si).map(Vec::as_slice).unwrap_or(&[]) {
            *word_votes.entry(*w).or_default().entry(m).or_default() += n;
        }
    }
    for (ii, im) in pm.scan.images.iter().enumerate() {
        let Some(m) = pm.marks.get(im.op).and_then(|m| m.mcid) else {
            continue;
        };
        let e = out.entry(m).or_default();
        e.image = true;
        if let Some(r) = pm.image_box(ii) {
            e.bbox = Some(e.bbox.map_or(r, |b| b.union(&r)));
        }
    }
    let mut words: Vec<(usize, i64)> = word_votes
        .into_iter()
        .filter_map(|(w, v)| {
            v.into_iter()
                .max_by_key(|(m, n)| (*n, -m))
                .map(|(m, _)| (w, m))
        })
        .collect();
    words.sort_unstable();
    for (w, m) in words {
        if let (Some(e), Some(x)) = (out.get_mut(&m), pm.words.get(w)) {
            if !e.text.is_empty() {
                e.text.push(' ');
            }
            e.text.push_str(&x.text);
        }
    }
    out
}

/// One listed element.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// Object number (stable id for edits); None for a direct element (not editable).
    pub id: Option<u32>,
    /// `/S` as written.
    #[serde(rename = "type")]
    pub s: String,
    /// Standard type through the RoleMap.
    pub role: String,
    pub depth: usize,
    pub parent: Option<u32>,
    /// 0-based page index.
    pub page: Option<usize>,
    /// Text of the element's subtree in reading order (preview).
    pub text: String,
    pub lang: Option<String>,
    /// Language in effect (own, inherited or the document's).
    pub effective_lang: Option<String>,
    pub alt: Option<String>,
    pub actual_text: Option<String>,
    /// Top-left page box.
    pub bbox: Option<[f64; 4]>,
    /// Marked-content sequences of its own.
    pub mcids: usize,
    /// Child elements.
    pub children: usize,
    /// Annotations it holds.
    pub annotations: usize,
}

/// The listing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub tagged: bool,
    pub marked: bool,
    pub lang: Option<String>,
    pub title: Option<String>,
    pub display_doc_title: bool,
    pub page_count: usize,
    pub elements: Vec<Item>,
    /// The tree hit a reading bound (not every element is listed; edits are refused).
    pub truncated: bool,
    /// Text was read for every page.
    pub text_complete: bool,
}

/// Catalog `/Lang`.
pub fn doc_lang(pdf: &Pdf) -> Option<String> {
    let c = pdf.catalog().ok()?;
    match pdf.resolve(c.get(b"Lang").ok()?)? {
        Object::String(s, _) => {
            let t = warraq_pdf::metadata::decode_text(s);
            (!t.trim().is_empty()).then_some(t)
        }
        _ => None,
    }
}

/// `/MarkInfo /Marked true`.
pub fn is_marked(pdf: &Pdf) -> bool {
    let Ok(c) = pdf.catalog() else { return false };
    match c.get(b"MarkInfo").ok().and_then(|o| pdf.resolve(o)) {
        Some(Object::Dictionary(d)) => {
            matches!(
                d.get(b"Marked").ok().and_then(|o| pdf.resolve(o)),
                Some(Object::Boolean(true))
            )
        }
        _ => false,
    }
}

/// `/ViewerPreferences /DisplayDocTitle true`.
pub fn display_doc_title(pdf: &Pdf) -> bool {
    let Ok(c) = pdf.catalog() else { return false };
    match c
        .get(b"ViewerPreferences")
        .ok()
        .and_then(|o| pdf.resolve(o))
    {
        Some(Object::Dictionary(d)) => matches!(
            d.get(b"DisplayDocTitle").ok().and_then(|o| pdf.resolve(o)),
            Some(Object::Boolean(true))
        ),
        _ => false,
    }
}

/// Page object → index.
pub fn page_index(pdf: &Pdf) -> HashMap<ObjectId, usize> {
    pages::flatten(pdf)
        .map(|l| l.iter().enumerate().map(|(i, p)| (p.id, i)).collect())
        .unwrap_or_default()
}

/// MCID information for every page that the tree references (bounded by [`MAX_TEXT_PAGES`]).
pub fn page_infos(pdf: &Pdf, tree: &Tree) -> (HashMap<ObjectId, HashMap<i64, McInfo>>, bool) {
    let index = page_index(pdf);
    let mut wanted: Vec<(usize, ObjectId)> = tree
        .page_mcids()
        .keys()
        .filter_map(|p| index.get(p).map(|i| (*i, *p)))
        .collect();
    wanted.sort_unstable();
    let complete = wanted.len() <= MAX_TEXT_PAGES;
    let mut out = HashMap::new();
    for (i, p) in wanted.into_iter().take(MAX_TEXT_PAGES) {
        if let Ok(pm) = PageMap::build(pdf, i, None) {
            out.insert(p, mcid_info(&pm));
        }
    }
    (out, complete)
}

fn clip(s: &str) -> String {
    if s.chars().count() <= PREVIEW {
        return s.to_string();
    }
    let mut t: String = s.chars().take(PREVIEW).collect();
    t.push('…');
    t
}

/// List the document's structure.
pub fn list(pdf: &Pdf) -> Result<Listing> {
    let tree = Tree::read(pdf);
    let index = page_index(pdf);
    let (infos, complete) = page_infos(pdf, &tree);
    let dlang = doc_lang(pdf);
    let order = tree.preorder();
    // Own text and box per element, then subtree aggregation (children after parents in
    // pre-order, so walk backwards).
    let n = tree.elems.len();
    let mut text: Vec<String> = vec![String::new(); n];
    let mut bbox: Vec<Option<Rect>> = vec![None; n];
    let mut pos: HashMap<usize, usize> = HashMap::new();
    for (k, (i, _)) in order.iter().enumerate() {
        pos.insert(*i, k);
    }
    for (i, _) in order.iter().rev() {
        let Some(e) = tree.elems.get(*i) else {
            continue;
        };
        let mut parts: Vec<String> = Vec::new();
        let mut b: Option<Rect> = None;
        for k in &e.kids {
            match k {
                Kid::Mcr {
                    mcid,
                    page,
                    stm: None,
                } => {
                    let p = page.or(e.page);
                    if let Some(info) = p.and_then(|p| infos.get(&p)).and_then(|m| m.get(mcid)) {
                        if !info.text.is_empty() {
                            parts.push(info.text.clone());
                        }
                        if let Some(r) = info.bbox {
                            b = Some(b.map_or(r, |x| x.union(&r)));
                        }
                    }
                }
                Kid::Elem(c) if pos.contains_key(c) => {
                    if let Some(t) = text.get(*c).filter(|t| !t.is_empty()) {
                        parts.push(t.clone());
                    }
                    if let Some(Some(r)) = bbox.get(*c) {
                        b = Some(b.map_or(*r, |x| x.union(r)));
                    }
                }
                _ => {}
            }
        }
        let joined = parts.join(" ");
        if let Some(t) = text.get_mut(*i) {
            *t = if joined.chars().count() > 4 * PREVIEW {
                joined.chars().take(4 * PREVIEW).collect()
            } else {
                joined
            };
        }
        if let Some(x) = bbox.get_mut(*i) {
            *x = b;
        }
    }
    let mut elements = Vec::with_capacity(order.len());
    for (i, depth) in &order {
        let Some(e) = tree.elems.get(*i) else {
            continue;
        };
        let parent = e
            .parent
            .and_then(|p| tree.elems.get(p))
            .and_then(|p| p.id)
            .map(|(n, _)| n);
        let page = e
            .page
            .or_else(|| e.mcrs().find_map(|(_, p, _)| p))
            .and_then(|p| index.get(&p).copied());
        let mut eff = e.lang.clone();
        let mut up = e.parent;
        let mut hops = 0;
        while eff.is_none() && hops < 256 {
            let Some(p) = up.and_then(|p| tree.elems.get(p)) else {
                break;
            };
            eff = p.lang.clone();
            up = p.parent;
            hops += 1;
        }
        elements.push(Item {
            id: e.id.map(|(n, _)| n),
            s: e.s.clone(),
            role: tree.std_role(&e.s),
            depth: *depth,
            parent,
            page,
            text: clip(text.get(*i).map(String::as_str).unwrap_or("")),
            lang: e.lang.clone(),
            effective_lang: eff.or_else(|| dlang.clone()),
            alt: e.alt.clone(),
            actual_text: e.actual_text.clone(),
            bbox: bbox
                .get(*i)
                .copied()
                .flatten()
                .map(|r| [r.x0, r.y0, r.x1, r.y1].map(|v| (v * 100.0).round() / 100.0)),
            mcids: e.mcrs().count(),
            children: e.child_elems().count(),
            annotations: e
                .kids
                .iter()
                .filter(|k| matches!(k, Kid::Objr { .. }))
                .count(),
        });
    }
    Ok(Listing {
        tagged: tree.exists(),
        marked: is_marked(pdf),
        lang: dlang,
        title: current_title(pdf),
        display_doc_title: display_doc_title(pdf),
        page_count: index.len(),
        elements,
        truncated: tree.truncated,
        text_complete: complete,
    })
}
