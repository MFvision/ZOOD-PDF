//! `redact.apply`: true redaction.
//!
//! 1. Areas come from the caller (user-space rectangles per page) and/or from the document's
//!    `/Redact` annotations (`/QuadPoints`, else `/Rect`; fill `/IC`; `/OverlayText`) — the marks
//!    EmbedPDF draws in its redaction mode.
//! 2. The words under the areas are read first (warraq-text) so they can be scrubbed from other
//!    strings afterwards (document info, bookmarks, annotation contents, field values, XMP).
//! 3. Each affected page's content (and every form XObject it draws) is rewritten by
//!    [`crate::content::Rewriter`]: covered glyphs, path parts, image pixels and inline images
//!    are removed, not hidden.
//! 4. Annotations and widgets overlapping an area are removed (and dropped from the AcroForm field
//!    tree); the page thumbnail is removed.
//! 5. Fill boxes (colour, optional overlay text — shaped with harfrust and tagged with per-word
//!    `/ActualText` when a font is supplied) are drawn on top.
//! 6. [`apply_and_rewrite`] writes the file whole: unreachable objects are collected and earlier
//!    revisions dropped, so the result has exactly one revision and the removed bytes are gone.

use std::collections::{BTreeMap, HashSet};

use lopdf::{dictionary, Dictionary, Object, ObjectId, Stream};
use serde::Serialize;
use warraq_pdf::limits::decode_stream;
use warraq_pdf::metadata::{decode_text, encode_text};
use warraq_pdf::{pages, Pdf, Protection};
use warraq_text::geom::{Matrix, Rect};
use warraq_text::source::ContentSource;
use warraq_text::{extract_pages, normalize_for_search, DocSource, LayoutOptions};

use crate::content::{ContentReport, Rewriter};
use crate::error::{RedactError, Result};
use crate::find::page_geoms;
use crate::util::{flate_stream, intersects, name_of, num, number, valid_rect};

/// A redaction area.
#[derive(Debug, Clone, PartialEq)]
pub struct Area {
    /// 0-based page.
    pub page: usize,
    /// User space, y up.
    pub rect: Rect,
    /// Fill colour (RGB 0–1); `None` = the default fill.
    pub fill: Option<Option<[f64; 3]>>,
    pub overlay: Option<String>,
}

/// Options of [`apply`].
#[derive(Debug, Clone)]
pub struct ApplyOptions {
    pub areas: Vec<Area>,
    /// Also apply (and remove) the document's `/Redact` annotations.
    pub use_annotations: bool,
    /// Default fill (`None` = no box).
    pub fill: Option<[f64; 3]>,
    /// Default overlay text.
    pub overlay_text: Option<String>,
    /// Font program (TrueType/OpenType) for overlay text that is not plain ASCII.
    pub font: Option<Vec<u8>>,
    /// Remove annotations overlapping an area (default true).
    pub remove_annotations: bool,
    /// Scrub removed words from other strings (default true).
    pub scrub: bool,
}

impl Default for ApplyOptions {
    fn default() -> Self {
        ApplyOptions {
            areas: Vec::new(),
            use_annotations: true,
            fill: Some([0.0, 0.0, 0.0]),
            overlay_text: None,
            font: None,
            remove_annotations: true,
            scrub: true,
        }
    }
}

/// What was done.
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    pub pages: Vec<usize>,
    pub areas: usize,
    pub redact_annotations: usize,
    pub annotations_removed: usize,
    pub fields_removed: usize,
    pub thumbnails_removed: usize,
    pub strings_scrubbed: usize,
    pub content: ContentReport,
}

fn resolve<'a>(pdf: &'a Pdf, o: &'a Object) -> Option<&'a Object> {
    pdf.resolve(o)
}

fn nums_of(pdf: &Pdf, o: Option<&Object>) -> Vec<f64> {
    match o.and_then(|o| resolve(pdf, o)) {
        Some(Object::Array(a)) => a
            .iter()
            .take(8 * 4096)
            .filter_map(|x| resolve(pdf, x).and_then(number))
            .collect(),
        _ => Vec::new(),
    }
}

fn colour(v: &[f64]) -> Option<[f64; 3]> {
    let c = |x: f64| x.clamp(0.0, 1.0);
    match v {
        [g] => Some([c(*g); 3]),
        [r, g, b] => Some([c(*r), c(*g), c(*b)]),
        [cy, m, y, k] => Some([
            (1.0 - c(*cy)) * (1.0 - c(*k)),
            (1.0 - c(*m)) * (1.0 - c(*k)),
            (1.0 - c(*y)) * (1.0 - c(*k)),
        ]),
        _ => None,
    }
}

/// `/Redact` annotations of a page → areas.
fn redact_annotation_areas(pdf: &Pdf, page_idx: usize, annot: &Dictionary) -> Vec<Area> {
    let q = nums_of(pdf, annot.get(b"QuadPoints").ok());
    let mut rects: Vec<Rect> = q
        .chunks_exact(8)
        .map(|c| {
            let pts: Vec<(f64, f64)> = c
                .chunks_exact(2)
                .filter_map(|p| match p {
                    [x, y] => Some((*x, *y)),
                    _ => None,
                })
                .collect();
            Rect::from_points(&pts)
        })
        .filter(valid_rect)
        .collect();
    if rects.is_empty() {
        if let [a, b, c, d] = nums_of(pdf, annot.get(b"Rect").ok()).as_slice() {
            let r = Rect::new(*a, *b, *c, *d);
            if valid_rect(&r) {
                rects.push(r);
            }
        }
    }
    let ic = nums_of(pdf, annot.get(b"IC").ok());
    let fill = if annot.has(b"IC") {
        Some(colour(&ic))
    } else {
        None
    };
    let overlay = match annot.get(b"OverlayText").ok().and_then(|o| resolve(pdf, o)) {
        Some(Object::String(s, _)) => Some(decode_text(s)).filter(|s| !s.trim().is_empty()),
        _ => None,
    };
    rects
        .into_iter()
        .map(|rect| Area {
            page: page_idx,
            rect,
            fill,
            overlay: overlay.clone(),
        })
        .collect()
}

fn annots_of(pdf: &Pdf, page: &Dictionary) -> Vec<Object> {
    match page.get(b"Annots").ok().and_then(|o| resolve(pdf, o)) {
        Some(Object::Array(a)) => a.iter().take(100_000).cloned().collect(),
        _ => Vec::new(),
    }
}

fn annot_rect(pdf: &Pdf, d: &Dictionary) -> Option<Rect> {
    match nums_of(pdf, d.get(b"Rect").ok()).as_slice() {
        [a, b, c, e] => Some(Rect::new(*a, *b, *c, *e)),
        _ => None,
    }
}

/// Decoded page content (all streams joined).
fn page_content(pdf: &Pdf, page: &Dictionary) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let items: Vec<Object> = match page.get(b"Contents").ok() {
        Some(Object::Array(a)) => a.clone(),
        Some(o) => match resolve(pdf, o) {
            Some(Object::Array(a)) => a.clone(),
            _ => vec![o.clone()],
        },
        None => Vec::new(),
    };
    for it in items.iter().take(100_000) {
        if let Some(Object::Stream(s)) = resolve(pdf, it) {
            out.extend(decode_stream(s, pdf.limits())?);
            out.push(b'\n');
        }
    }
    Ok(out)
}

fn resources_of(pdf: &Pdf, info: &pages::PageInfo) -> Dictionary {
    info.resources
        .as_ref()
        .and_then(|o| resolve(pdf, o))
        .and_then(|o| o.as_dict().ok())
        .cloned()
        .unwrap_or_default()
}

fn sub_dict(pdf: &Pdf, res: &Dictionary, key: &[u8]) -> Dictionary {
    res.get(key)
        .ok()
        .and_then(|o| resolve(pdf, o))
        .and_then(|o| o.as_dict().ok())
        .cloned()
        .unwrap_or_default()
}

/// Words (removed glyphs only, logical order) under the areas: the strings to scrub elsewhere.
fn words_under(pdf: &Pdf, areas: &[Area]) -> Result<Vec<String>> {
    let src = DocSource::borrowed(pdf.document());
    let geoms = page_geoms(pdf, &src)?;
    let pages_hit: Vec<usize> = {
        let mut v: Vec<usize> = areas
            .iter()
            .map(|a| a.page)
            .filter(|p| *p < src.page_count())
            .collect();
        v.sort_unstable();
        v.dedup();
        v
    };
    let opts = LayoutOptions {
        glyphs: true,
        include_hidden: true,
        include_artifacts: true,
    };
    let texts = extract_pages(&src, &pages_hit, &opts)?;
    let mut out = Vec::new();
    for pt in &texts {
        let Some(g) = geoms.get(pt.page) else {
            continue;
        };
        // Areas in the extractor's top-left space.
        let local: Vec<Rect> = areas
            .iter()
            .filter(|a| a.page == pt.page)
            .map(|a| {
                Rect::new(
                    a.rect.x0 - g.bx[0],
                    g.bx[3] - a.rect.y1,
                    a.rect.x1 - g.bx[0],
                    g.bx[3] - a.rect.y0,
                )
            })
            .collect();
        for p in pt.paragraphs() {
            for l in &p.lines {
                for w in &l.words {
                    if !local.iter().any(|r| intersects(r, &w.bbox)) {
                        continue;
                    }
                    let mut s = String::new();
                    for gl in &w.glyphs {
                        let area = gl.bbox.width() * gl.bbox.height();
                        if local.iter().any(|r| {
                            area <= 0.0
                                || crate::util::overlap_area(r, &gl.bbox)
                                    >= crate::content::GLYPH_COVERAGE * area
                        }) {
                            s.push_str(&gl.text);
                        } else if !s.is_empty() {
                            out.push(std::mem::take(&mut s));
                        }
                    }
                    if w.glyphs.is_empty() {
                        s = w.text.clone();
                    }
                    if !s.is_empty() {
                        out.push(s);
                    }
                }
            }
        }
    }
    let mut v: Vec<String> = out
        .into_iter()
        .map(|s| normalize_for_search(&s).0.trim().to_string())
        .filter(|s| s.chars().count() >= 3)
        .collect();
    v.sort();
    v.dedup();
    Ok(v)
}

/// Remove every occurrence of `phrases` (normalised) from `s`. `None` = unchanged.
pub fn scrub_text(s: &str, phrases: &[String]) -> Option<String> {
    let (norm, map) = normalize_for_search(s);
    let mut cut: Vec<(usize, usize)> = Vec::new();
    for p in phrases {
        let mut from = 0;
        while let Some(pos) = norm.get(from..).and_then(|x| x.find(p.as_str())) {
            let b = from + pos;
            from = b + p.len().max(1);
            let ci = norm.get(..b).map_or(0, |x| x.chars().count());
            let n = p.chars().count();
            let (Some(&os), Some(&ol)) = (map.get(ci), map.get(ci + n - 1)) else {
                break;
            };
            let oe = ol
                + s.get(ol..)
                    .and_then(|x| x.chars().next())
                    .map_or(0, char::len_utf8);
            cut.push((os, oe));
        }
    }
    if cut.is_empty() {
        return None;
    }
    cut.sort_unstable();
    let mut out = String::with_capacity(s.len());
    let mut pos = 0;
    for (a, b) in cut {
        if a > pos {
            out.push_str(s.get(pos..a).unwrap_or(""));
        }
        pos = pos.max(b);
    }
    out.push_str(s.get(pos..).unwrap_or(""));
    Some(out)
}

fn scrub_object(o: &mut Object, phrases: &[String], depth: usize, count: &mut usize) {
    if depth > 64 {
        return;
    }
    match o {
        Object::String(bytes, _) => {
            let text = decode_text(bytes);
            if let Some(new) = scrub_text(&text, phrases) {
                *o = encode_text(&new);
                *count += 1;
            }
        }
        Object::Array(a) => {
            for x in a.iter_mut() {
                scrub_object(x, phrases, depth + 1, count);
            }
        }
        Object::Dictionary(d) => scrub_dict(d, phrases, depth, count),
        Object::Stream(s) => scrub_dict(&mut s.dict, phrases, depth, count),
        _ => {}
    }
}

fn scrub_dict(d: &mut Dictionary, phrases: &[String], depth: usize, count: &mut usize) {
    // Signature values and IDs are binary.
    let is_sig = matches!(name_of(d, b"Type"), Some(b"Sig") | Some(b"DocTimeStamp"));
    for (k, v) in d.iter_mut() {
        if (is_sig && k.as_slice() == b"Contents") || k.as_slice() == b"ID" {
            continue;
        }
        scrub_object(v, phrases, depth + 1, count);
    }
}

/// Scrub strings of every object and the XMP streams.
fn scrub_document(pdf: &mut Pdf, phrases: &[String]) -> usize {
    if phrases.is_empty() {
        return 0;
    }
    let mut count = 0;
    let ids: Vec<ObjectId> = pdf.objects().keys().copied().collect();
    for id in ids {
        let Some(obj) = pdf.get(id) else { continue };
        let mut o = obj.clone();
        let before = count;
        scrub_object(&mut o, phrases, 0, &mut count);
        // XMP packets are text.
        if let Object::Stream(s) = &mut o {
            if name_of(&s.dict, b"Type") == Some(b"Metadata") {
                if let Ok(data) = decode_stream(s, pdf.limits()) {
                    let text = String::from_utf8_lossy(&data).into_owned();
                    if let Some(new) = scrub_text(&text, phrases) {
                        *s = Stream::new(
                            {
                                let mut d = s.dict.clone();
                                d.remove(b"Filter");
                                d.remove(b"DecodeParms");
                                d
                            },
                            new.into_bytes(),
                        );
                        count += 1;
                    }
                }
            }
        }
        if count != before {
            pdf.set(id, o);
        }
    }
    // The trailer's /Info may be direct.
    if let Ok(Object::Dictionary(d)) = pdf.trailer().get(b"Info") {
        let mut d = d.clone();
        let before = count;
        scrub_dict(&mut d, phrases, 0, &mut count);
        if count != before {
            pdf.set_trailer("Info", Object::Dictionary(d));
        }
    }
    count
}

/// Remove `removed` widget/annotation ids from the AcroForm field tree.
fn prune_fields(pdf: &mut Pdf, removed: &HashSet<ObjectId>) -> Result<usize> {
    let root = pdf.root_id()?;
    let Some(cat) = pdf.get_dict(root).cloned() else {
        return Ok(0);
    };
    let Some(acro_obj) = cat.get(b"AcroForm").ok().cloned() else {
        return Ok(0);
    };
    let (acro_id, mut acro) = match &acro_obj {
        Object::Reference(id) => match pdf.get_dict(*id) {
            Some(d) => (Some(*id), d.clone()),
            None => return Ok(0),
        },
        Object::Dictionary(d) => (None, d.clone()),
        _ => return Ok(0),
    };
    let mut count = 0usize;
    // Returns whether the node should stay.
    fn walk(
        pdf: &mut Pdf,
        id: ObjectId,
        removed: &HashSet<ObjectId>,
        depth: usize,
        count: &mut usize,
        seen: &mut HashSet<ObjectId>,
    ) -> bool {
        if removed.contains(&id) {
            *count += 1;
            return false;
        }
        if depth > 64 || !seen.insert(id) {
            return true;
        }
        let Some(d) = pdf.get_dict(id).cloned() else {
            return true;
        };
        let kids = match d.get(b"Kids").ok().and_then(|o| pdf.resolve(o)).cloned() {
            Some(Object::Array(a)) => a,
            _ => return true,
        };
        let mut keep = Vec::new();
        for k in kids.iter().take(100_000) {
            match k {
                Object::Reference(kid) => {
                    if walk(pdf, *kid, removed, depth + 1, count, seen) {
                        keep.push(k.clone());
                    }
                }
                other => keep.push(other.clone()),
            }
        }
        if keep.len() != kids.len() {
            if keep.is_empty() {
                *count += 1;
                return false;
            }
            let mut nd = d.clone();
            nd.set("Kids", Object::Array(keep));
            match pdf.get(id) {
                Some(Object::Stream(s)) => {
                    let mut s = s.clone();
                    s.dict = nd;
                    pdf.set(id, Object::Stream(s));
                }
                _ => pdf.set(id, Object::Dictionary(nd)),
            }
        }
        true
    }
    let fields = match acro
        .get(b"Fields")
        .ok()
        .and_then(|o| pdf.resolve(o))
        .cloned()
    {
        Some(Object::Array(a)) => a,
        _ => return Ok(0),
    };
    let mut keep = Vec::new();
    let mut seen = HashSet::new();
    for f in fields.iter().take(100_000) {
        match f {
            Object::Reference(fid) => {
                if walk(pdf, *fid, removed, 0, &mut count, &mut seen) {
                    keep.push(f.clone());
                }
            }
            other => keep.push(other.clone()),
        }
    }
    if keep.len() != fields.len() {
        acro.set("Fields", Object::Array(keep));
        match acro_id {
            Some(id) => pdf.set(id, Object::Dictionary(acro)),
            None => {
                let mut c = cat.clone();
                c.set("AcroForm", Object::Dictionary(acro));
                pdf.set(root, Object::Dictionary(c));
            }
        }
    }
    Ok(count)
}

fn is_ascii_text(s: &str) -> bool {
    s.chars().all(|c| (' '..='~').contains(&c))
}

/// Overlay-text font resources (built lazily, shared by all pages).
struct OverlayFont {
    font_id: Option<ObjectId>,
    helv_id: Option<ObjectId>,
    widths: BTreeMap<u32, f64>,
    descendant: Option<ObjectId>,
}

/// Apply redactions to `pdf` in memory (objects replaced / added). Call
/// [`apply_and_rewrite`] to get the final bytes.
pub fn apply(pdf: &mut Pdf, opts: &ApplyOptions) -> Result<ApplyReport> {
    pdf.require("redaction", |p| p.modify)?;
    let list = pages::flatten(pdf)?;
    let mut areas: Vec<Area> = opts
        .areas
        .iter()
        .filter(|a| valid_rect(&a.rect) && a.page < list.len())
        .cloned()
        .collect();
    let mut report = ApplyReport::default();
    let mut redact_annots: HashSet<ObjectId> = HashSet::new();
    if opts.use_annotations {
        for (i, p) in list.iter().enumerate() {
            let Some(pd) = pdf.get_dict(p.id) else {
                continue;
            };
            for a in annots_of(pdf, pd) {
                let Some(d) = resolve(pdf, &a).and_then(|o| o.as_dict().ok()) else {
                    continue;
                };
                if name_of(d, b"Subtype") == Some(b"Redact") {
                    let found = redact_annotation_areas(pdf, i, d);
                    report.redact_annotations += 1;
                    areas.extend(found);
                    if let Object::Reference(id) = a {
                        redact_annots.insert(id);
                    }
                }
            }
        }
    }
    if areas.is_empty() && redact_annots.is_empty() {
        return Err(RedactError::Params(
            "nothing to redact: no areas and no redaction marks".into(),
        ));
    }
    report.areas = areas.len();
    let phrases = if opts.scrub {
        words_under(pdf, &areas)?
    } else {
        Vec::new()
    };

    // Phase 1 (read-only): rewrite content of every affected page.
    let mut touched: Vec<usize> = areas.iter().map(|a| a.page).collect();
    touched.extend(list.iter().enumerate().filter_map(|(i, p)| {
        let pd = pdf.get_dict(p.id)?;
        annots_of(pdf, pd)
            .iter()
            .any(|a| matches!(a, Object::Reference(id) if redact_annots.contains(id)))
            .then_some(i)
    }));
    touched.sort_unstable();
    touched.dedup();
    struct Plan {
        page: usize,
        content: Vec<u8>,
        open_q: usize,
        additions: Vec<(Vec<u8>, ObjectId)>,
        used: HashSet<Vec<u8>>,
    }
    let mut plans: Vec<Plan> = Vec::new();
    let (new_objects, next_free, content_report) = {
        let src = DocSource::borrowed(pdf.document());
        let mut rw = Rewriter::new(&src, pdf.next_number());
        for &pi in &touched {
            let Some(info) = list.get(pi) else { continue };
            let Some(pd) = pdf.get_dict(info.id) else {
                continue;
            };
            let rects: Vec<Rect> = areas
                .iter()
                .filter(|a| a.page == pi)
                .map(|a| a.rect)
                .collect();
            let content = page_content(pdf, pd)?;
            let res = resources_of(pdf, info);
            rw.set_rects(&rects);
            let out = rw.rewrite(&content, &res, Matrix::IDENTITY);
            plans.push(Plan {
                page: pi,
                content: out.content,
                open_q: out.open_q,
                additions: out.additions,
                used: out.used,
            });
        }
        let _ = src.page_count();
        (
            std::mem::take(&mut rw.new_objects),
            rw.next_number(),
            rw.report.clone(),
        )
    };
    report.content = content_report;
    for (id, o) in new_objects {
        pdf.set(id, o);
    }
    let _ = next_free;

    // Phase 2: annotations, thumbnails, fill boxes, new content.
    let mut removed_annots: HashSet<ObjectId> = HashSet::new();
    let mut overlay = OverlayFont {
        font_id: None,
        helv_id: None,
        widths: BTreeMap::new(),
        descendant: None,
    };
    for plan in &plans {
        let Some(info) = list.get(plan.page) else {
            continue;
        };
        let Some(mut pd) = pdf.get_dict(info.id).cloned() else {
            continue;
        };
        let page_areas: Vec<&Area> = areas.iter().filter(|a| a.page == plan.page).collect();
        // Annotations.
        let annots = annots_of(pdf, &pd);
        if !annots.is_empty() {
            let mut keep = Vec::new();
            let mut drop_ids: HashSet<ObjectId> = HashSet::new();
            for a in &annots {
                let id = a.as_reference().ok();
                let Some(d) = resolve(pdf, a).and_then(|o| o.as_dict().ok()) else {
                    keep.push(a.clone());
                    continue;
                };
                let is_redact = name_of(d, b"Subtype") == Some(b"Redact");
                let overlaps = annot_rect(pdf, d)
                    .is_some_and(|r| page_areas.iter().any(|x| intersects(&x.rect, &r)));
                let drop = (is_redact && opts.use_annotations)
                    || (opts.remove_annotations && overlaps && !is_redact);
                if drop {
                    if let Some(id) = id {
                        drop_ids.insert(id);
                    }
                    if let Ok(Object::Reference(p)) = d.get(b"Popup") {
                        drop_ids.insert(*p);
                    }
                    if !is_redact {
                        report.annotations_removed += 1;
                    }
                }
            }
            for a in &annots {
                let id = a.as_reference().ok();
                let parent_dropped = resolve(pdf, a)
                    .and_then(|o| o.as_dict().ok())
                    .and_then(|d| d.get(b"Parent").ok())
                    .and_then(|p| p.as_reference().ok())
                    .is_some_and(|p| drop_ids.contains(&p));
                if id.is_some_and(|i| drop_ids.contains(&i)) || parent_dropped {
                    if let Some(i) = id {
                        removed_annots.insert(i);
                    }
                    continue;
                }
                keep.push(a.clone());
            }
            pd.set("Annots", Object::Array(keep));
        }
        if pd.remove(b"Thumb").is_some() {
            report.thumbnails_removed += 1;
        }
        // Resources.
        let mut res = resources_of(pdf, info);
        if res.has(b"XObject") || !plan.additions.is_empty() {
            let mut x = sub_dict(pdf, &res, b"XObject");
            for (n, id) in &plan.additions {
                x.set(n.clone(), Object::Reference(*id));
            }
            crate::content::prune_xobjects(&mut x, &plan.used);
            res.set("XObject", Object::Dictionary(x));
        }
        // Fill boxes and overlay text.
        let mut boxes = String::new();
        for a in &page_areas {
            let fill = a.fill.unwrap_or(opts.fill);
            let r = a.rect;
            if let Some([cr, cg, cb]) = fill {
                boxes.push_str(&format!(
                    "q {} {} {} rg {} {} {} {} re f Q\n",
                    num(cr),
                    num(cg),
                    num(cb),
                    num(r.x0),
                    num(r.y0),
                    num(r.x1 - r.x0),
                    num(r.y1 - r.y0)
                ));
            }
            let text = a
                .overlay
                .clone()
                .or_else(|| opts.overlay_text.clone())
                .filter(|t| !t.trim().is_empty());
            if let Some(t) = text {
                let dark = fill.is_some_and(|[r, g, b]| 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5);
                let ink = if dark { "1 g" } else { "0 g" };
                boxes.push_str(&overlay_ops(
                    pdf,
                    &mut overlay,
                    &mut res,
                    opts.font.as_deref(),
                    &t,
                    &r,
                    ink,
                )?);
            }
        }
        pd.set("Resources", Object::Dictionary(res));
        let mut content = b"q\n".to_vec();
        content.extend_from_slice(&plan.content);
        content.push(b'\n');
        for _ in 0..=plan.open_q.min(crate::content::MAX_Q_DEPTH * 64) {
            content.extend_from_slice(b"Q\n");
        }
        content.extend_from_slice(boxes.as_bytes());
        let cid = pdf.add(Object::Stream(flate_stream(Dictionary::new(), &content)));
        pd.set("Contents", Object::Reference(cid));
        pdf.set(info.id, Object::Dictionary(pd));
        report.pages.push(plan.page);
    }
    // Finish the overlay font's widths.
    if let (Some(desc), false) = (overlay.descendant, overlay.widths.is_empty()) {
        if let Some(Object::Dictionary(d)) = pdf.get(desc).cloned() {
            let mut d = d;
            let w: Vec<Object> = overlay
                .widths
                .iter()
                .flat_map(|(g, w)| {
                    [
                        Object::Integer(i64::from(*g)),
                        Object::Array(vec![Object::Real(*w as f32)]),
                    ]
                })
                .collect();
            d.set("W", Object::Array(w));
            pdf.set(desc, Object::Dictionary(d));
        }
    }
    if !removed_annots.is_empty() {
        report.fields_removed = prune_fields(pdf, &removed_annots)?;
    }
    report.strings_scrubbed = scrub_document(pdf, &phrases);
    Ok(report)
}

fn overlay_ops(
    pdf: &mut Pdf,
    st: &mut OverlayFont,
    res: &mut Dictionary,
    font: Option<&[u8]>,
    text: &str,
    r: &Rect,
    ink: &str,
) -> Result<String> {
    let w = r.x1 - r.x0;
    let h = r.y1 - r.y0;
    let mut size = (h * 0.7).clamp(1.0, 14.0);
    match font {
        Some(fb) => {
            let mut run = warraq_text::shape(text, fb, size)?;
            if run.width > w * 0.95 && run.width > 0.0 {
                size = (size * w * 0.95 / run.width).max(1.0);
                run = warraq_text::shape(text, fb, size)?;
            }
            let fid = match st.font_id {
                Some(id) => id,
                None => {
                    let ff = pdf.add(Object::Stream(flate_stream(
                        dictionary! {"Length1" => fb.len() as i64},
                        fb,
                    )));
                    let fd = pdf.add(Object::Dictionary(dictionary! {
                        "Type" => "FontDescriptor", "FontName" => "ZoodOverlay", "Flags" => 4,
                        "FontBBox" => vec![(-500).into(), (-700).into(), 1500.into(), 1200.into()], "ItalicAngle" => 0,
                        "Ascent" => 1000, "Descent" => -400, "CapHeight" => 700, "StemV" => 80, "FontFile2" => ff,
                    }));
                    let desc = pdf.add(Object::Dictionary(dictionary! {
                        "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => "ZoodOverlay",
                        "CIDSystemInfo" => dictionary! {"Registry" => Object::string_literal("Adobe"), "Ordering" => Object::string_literal("Identity"), "Supplement" => 0},
                        "FontDescriptor" => fd, "CIDToGIDMap" => "Identity", "DW" => 1000,
                    }));
                    let f = pdf.add(Object::Dictionary(dictionary! {
                        "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "ZoodOverlay", "Encoding" => "Identity-H",
                        "DescendantFonts" => vec![Object::Reference(desc)],
                    }));
                    st.font_id = Some(f);
                    st.descendant = Some(desc);
                    f
                }
            };
            for g in &run.glyphs {
                if size > 0.0 {
                    st.widths.insert(g.glyph_id, g.x_advance / size * 1000.0);
                }
            }
            let mut fonts = sub_dict(pdf, res, b"Font");
            fonts.set("WqOv", Object::Reference(fid));
            res.set("Font", Object::Dictionary(fonts));
            let x = r.x0 + (w - run.width) / 2.0;
            let y = r.y0 + (h - size * 0.7) / 2.0;
            let mut s = format!("q {ink}\n");
            s.push_str(&String::from_utf8_lossy(
                &warraq_text::shape::content_stream(&run, "WqOv", x, y),
            ));
            s.push_str("Q\n");
            Ok(s)
        }
        None => {
            if !is_ascii_text(text) {
                return Err(RedactError::FontRequired(
                    "overlay text that is not plain ASCII needs a font (blobs[0])".into(),
                ));
            }
            let est = |sz: f64| text.chars().count() as f64 * sz * 0.55;
            if est(size) > w * 0.95 {
                size = (w * 0.95 / (text.chars().count().max(1) as f64 * 0.55)).max(1.0);
            }
            let hid = match st.helv_id {
                Some(id) => id,
                None => {
                    let id = pdf.add(Object::Dictionary(dictionary! {
                        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding",
                    }));
                    st.helv_id = Some(id);
                    id
                }
            };
            let mut fonts = sub_dict(pdf, res, b"Font");
            fonts.set("WqHv", Object::Reference(hid));
            res.set("Font", Object::Dictionary(fonts));
            let x = r.x0 + (w - est(size)) / 2.0;
            let y = r.y0 + (h - size * 0.7) / 2.0;
            let lit: String = text
                .chars()
                .map(|c| match c {
                    '(' | ')' | '\\' => format!("\\{c}"),
                    c => c.to_string(),
                })
                .collect();
            Ok(format!(
                "q {ink} BT /WqHv {} Tf {} {} Td ({lit}) Tj ET Q\n",
                num(size),
                num(x),
                num(y)
            ))
        }
    }
}

/// Apply and write the whole file (garbage-collected, single revision, protection kept).
pub fn apply_and_rewrite(pdf: &mut Pdf, opts: &ApplyOptions) -> Result<(Vec<u8>, ApplyReport)> {
    let report = apply(pdf, opts)?;
    let bytes = pdf.write_full(Protection::Keep)?;
    Ok((bytes, report))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn scrub_removes_arabic_phrases_with_tashkeel() {
        let phrases = vec![normalize_for_search("محمد").0];
        assert_eq!(
            scrub_text("كتبه مُحَمَّد اليوم", &phrases).unwrap(),
            "كتبه  اليوم"
        );
        assert!(scrub_text("nothing here", &phrases).is_none());
    }

    #[test]
    fn colours() {
        assert_eq!(colour(&[0.5]), Some([0.5, 0.5, 0.5]));
        assert_eq!(colour(&[0.0, 0.0, 0.0, 1.0]), Some([0.0, 0.0, 0.0]));
        assert_eq!(colour(&[]), None);
    }
}
