//! Auto-tagging without moving pixels.
//!
//! Per page: warraq-text's logical-order paragraphs become structure (headings by relative size,
//! lists by their labels, P), warraq-office's ruled/aligned grids become tables (TR, TH with
//! `/Scope /Column` on the first row, TD, spans), pictures become Figures with a `/BBox`, link
//! annotations become Link elements (with the words they cover and an OBJR), widgets Form, other
//! annotations Annot; running headers/footers, page numbers, rules/backgrounds and blank glyphs
//! become artifacts. Words whose script differs from their element's language get a `Span` with its
//! own `/Lang`.
//!
//! Content: operators of one owner that follow each other in content order are wrapped in ONE
//! `/Tag <</MCID n>> BDC … EMC` sequence, placed at operation boundaries where every
//! `BDC/EMC`, `BT/ET` and `q/Q` pair nests ([`crate::marked::balance`]). Only insertions are
//! made, so every other byte of the content is unchanged and nothing moves on the page.
//! Structure order follows the words' logical order (not content order, which is visual for
//! right-to-left runs in Chromium files). Existing tags are kept; only untagged content is tagged
//! (`retag: true` first removes the MCIDs from the content and starts a new tree).

use std::collections::{BTreeMap, HashMap, HashSet};

use lopdf::{Dictionary, Object, ObjectId, StringFormat};
use serde::Serialize;
use warraq_edit::content::Splice;
use warraq_edit::page::{load, resources, write};
use warraq_office::table::{aligned_grids, ruled_grids, WordBox};
use warraq_pdf::limits::decode_stream;
use warraq_pdf::metadata::get_info;
use warraq_pdf::{pages, Pdf};
use warraq_text::geom::Rect;
use warraq_text::DocSource;

use crate::classify::{list_label, stats, Stats};
use crate::error::{A11yError, Result};
use crate::lang;
use crate::marked::{
    analyze, balance, is_mc, is_path_construct, is_path_paint, is_show, named_props,
};
use crate::pagemap::{extract, xobject_kind, PageMap};
use crate::rewrite::{strip_mcids, Insert};
use crate::tree::{Elem, Kid, Tree};

/// Largest document auto-tagged in one call.
pub const MAX_PAGES: usize = 5_000;

/// Options of [`autotag`].
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// Remove existing MCIDs from the content and build a new tree ("retag all").
    pub retag: bool,
    /// Document title to set (Info `/Title`, XMP `dc:title`) — asked in the UI when missing.
    pub title: Option<String>,
    /// Document language (default: detected from the text).
    pub lang: Option<String>,
}

/// What was tagged.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub pages: usize,
    /// New structure elements per type.
    pub elements: BTreeMap<String, usize>,
    pub mcids: usize,
    pub artifacts: usize,
    pub lang: Option<String>,
    pub title: Option<String>,
    /// Pages whose content could not be tagged (unreadable content).
    pub skipped_pages: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum ArtKind {
    Layout,
    Header,
    Footer,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Owner {
    Neutral,
    Blocker,
    Absorb,
    Elem(usize),
    Art(ArtKind),
}

#[derive(Debug, Clone)]
struct PElem {
    role: String,
    parent: Option<usize>,
    lang: Option<String>,
    attrs: Option<Object>,
    objr: Option<ObjectId>,
    /// Rank from the position on the page (pictures, annotations, empty cells).
    pos_rank: Option<f64>,
    /// Sort key among siblings overriding the rank (table rows and cells).
    order: Option<f64>,
    keep_empty: bool,
}

impl PElem {
    fn new(role: &str, parent: Option<usize>) -> PElem {
        PElem {
            role: role.to_string(),
            parent,
            lang: None,
            attrs: None,
            objr: None,
            pos_rank: None,
            order: None,
            keep_empty: false,
        }
    }
}

struct Unit {
    s: usize,
    e: usize,
    owner: Owner,
    rank: Option<(f64, f64)>,
}

struct Seq {
    s: usize,
    e: usize,
    owner: Owner,
    rank: Option<(f64, f64)>,
}

fn name(n: &str) -> Object {
    Object::Name(n.as_bytes().to_vec())
}

fn rect_obj(r: [f64; 4]) -> Object {
    Object::Array(r.iter().map(|v| Object::Real(*v as f32)).collect())
}

fn num(pdf: &Pdf, o: &Object) -> Option<f64> {
    match pdf.resolve(o)? {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(f64::from(*r)),
        _ => None,
    }
}

/// The annotation rectangle (user space).
pub fn annot_rect(pdf: &Pdf, d: &Dictionary) -> Option<[f64; 4]> {
    let a = pdf.resolve(d.get(b"Rect").ok()?)?.as_array().ok()?;
    let v: Vec<f64> = a.iter().filter_map(|o| num(pdf, o)).collect();
    match v.as_slice() {
        [x0, y0, x1, y1] if v.iter().all(|x| x.is_finite()) => {
            Some([x0.min(*x1), y0.min(*y1), x0.max(*x1), y0.max(*y1)])
        }
        _ => None,
    }
}

/// The page's annotation references (bounded).
pub fn annots(pdf: &Pdf, page: ObjectId) -> Vec<ObjectId> {
    let Some(d) = pdf.get_dict(page) else {
        return Vec::new();
    };
    match d.get(b"Annots").ok().and_then(|o| pdf.resolve(o)) {
        Some(Object::Array(a)) => a
            .iter()
            .take(10_000)
            .filter_map(|o| match o {
                Object::Reference(id) => Some(*id),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Subtype and hidden flag of an annotation.
pub fn annot_kind(pdf: &Pdf, id: ObjectId) -> Option<(String, bool)> {
    let d = pdf.get_dict(id)?;
    let st = d
        .get(b"Subtype")
        .ok()
        .and_then(|o| pdf.resolve(o))
        .and_then(|o| o.as_name().ok())
        .map(|n| String::from_utf8_lossy(n).into_owned())?;
    let flags = d.get(b"F").ok().and_then(|o| num(pdf, o)).unwrap_or(0.0) as i64;
    Some((st, flags & 2 != 0))
}

/// Whether an annotation must be in the structure tree (PDF/UA 7.18.1).
pub fn annot_needs_tag(kind: &str, hidden: bool) -> bool {
    !hidden && !matches!(kind, "Popup" | "PrinterMark" | "TrapNet")
}

/// What a form XObject contains.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FormClass {
    /// Everything inside is marked `/Artifact` (page marks).
    Artifact,
    /// Carries its own MCIDs.
    Tagged,
    /// Shows text.
    Text,
    /// Graphics only.
    Graphic,
}

/// Classify a form XObject by a bounded look at its content.
pub fn form_class(pdf: &Pdf, id: Option<ObjectId>) -> FormClass {
    let Some(Object::Stream(s)) = id.and_then(|i| pdf.get(i)) else {
        return FormClass::Graphic;
    };
    let Ok(data) = decode_stream(s, pdf.limits()) else {
        return FormClass::Graphic;
    };
    let Ok(c) = warraq_edit::content::parse(&data) else {
        return FormClass::Graphic;
    };
    let none = |_: &[u8]| None;
    let m = analyze(&c, &none);
    let mut any_paint = false;
    let mut all_art = true;
    let mut text = false;
    for (i, op) in c.ops.iter().enumerate().take(200_000) {
        let Some(mk) = m.get(i) else { break };
        if mk.opens_mcid.is_some() {
            return FormClass::Tagged;
        }
        let paints =
            is_show(op) || is_path_paint(op) || op.is(b"Do") || op.is(b"BI") || op.is(b"sh");
        if paints {
            any_paint = true;
            if !mk.artifact {
                all_art = false;
            }
            if is_show(op) && !mk.artifact {
                text = true;
            }
        }
    }
    if any_paint && all_art {
        FormClass::Artifact
    } else if text {
        FormClass::Text
    } else {
        FormClass::Graphic
    }
}

/// Auto-tag the document.
pub fn autotag(pdf: &mut Pdf, opts: &Options) -> Result<Report> {
    pdf.require("tagging the document", |p| p.modify)?;
    if let Some(l) = &opts.lang {
        if !lang::valid_tag(l) {
            return Err(A11yError::Params(format!("bad language tag {l:?}")));
        }
    }
    let list = pages::flatten(pdf)?;
    if list.len() > MAX_PAGES {
        return Err(A11yError::Limit(format!("more than {MAX_PAGES} pages")));
    }
    let mut report = Report {
        pages: list.len(),
        ..Report::default()
    };
    let mut tree = if opts.retag {
        for i in 0..list.len() {
            strip_page(pdf, i)?;
        }
        Tree::default()
    } else {
        let t = Tree::read(pdf);
        if t.truncated {
            return Err(A11yError::Limit(
                "the structure tree is too large or too deep".into(),
            ));
        }
        t
    };
    if opts.retag {
        // A new tree: the old root and its elements become unreferenced.
        let cat_id = pdf.root_id()?;
        let mut cat = pdf.catalog()?.clone();
        cat.remove(b"StructTreeRoot");
        pdf.set(cat_id, Object::Dictionary(cat));
        for p in &list {
            for a in annots(pdf, p.id) {
                if let Some(Object::Dictionary(mut d)) = pdf.get(a).cloned() {
                    if d.remove(b"StructParent").is_some() {
                        pdf.set(a, Object::Dictionary(d));
                    }
                }
            }
            if let Some(mut d) = pdf.get_dict(p.id).cloned() {
                if d.remove(b"StructParents").is_some() {
                    pdf.set(p.id, Object::Dictionary(d));
                }
            }
        }
    }
    let indices: Vec<usize> = (0..list.len()).collect();
    let texts = extract(pdf, &indices)?;
    let st = stats(&texts);
    let doc_lang: Option<String> = opts
        .lang
        .clone()
        .or_else(|| {
            pdf.catalog()
                .ok()
                .and_then(|c| c.get(b"Lang").ok().cloned())
                .and_then(|o| match pdf.resolve(&o) {
                    Some(Object::String(s, _)) => Some(warraq_pdf::metadata::decode_text(s)),
                    _ => None,
                })
                .filter(|s| !s.trim().is_empty())
        })
        .or_else(|| st.lang.map(str::to_string));
    report.lang = doc_lang.clone();

    // Container: the tree's Document element, or a new one.
    let container = match tree
        .top
        .iter()
        .copied()
        .find(|i| tree.role(*i) == "Document")
    {
        Some(c) => c,
        None if tree.top.is_empty() => tree.add(Elem::new("Document", None, None), None),
        None => {
            // A tree without a Document element: new content goes at the root.
            usize::MAX
        }
    };
    let container = (container != usize::MAX).then_some(container);
    let tagged_annots = tree.objrs();
    let tree_mcids = tree.page_mcids();

    for (i, text) in texts.into_iter().enumerate() {
        let pm = match PageMap::build(pdf, i, Some(text)) {
            Ok(pm) => pm,
            Err(_) => {
                report.skipped_pages.push(i);
                continue;
            }
        };
        let used = tree_mcids.get(&pm.page_id()).cloned().unwrap_or_default();
        tag_page(
            pdf,
            &pm,
            &st,
            doc_lang.as_deref(),
            &tagged_annots,
            &used,
            &mut tree,
            container,
            &mut report,
        )?;
        let mut pd = pdf
            .get_dict(pm.page_id())
            .cloned()
            .ok_or_else(|| A11yError::NotFound("page".into()))?;
        pd.set("Tabs", name("S"));
        pdf.set(pm.page_id(), Object::Dictionary(pd));
    }

    // Catalog: marked, language, title shown in the window title.
    let cat_id = pdf.root_id()?;
    let mut cat = pdf.catalog()?.clone();
    let mut mi = match cat.get(b"MarkInfo").ok().and_then(|o| pdf.resolve(o)) {
        Some(Object::Dictionary(d)) => d.clone(),
        _ => Dictionary::new(),
    };
    mi.set("Marked", Object::Boolean(true));
    if opts.retag {
        mi.remove(b"Suspects");
    }
    cat.set("MarkInfo", Object::Dictionary(mi));
    if let Some(l) = &doc_lang {
        let has = cat.has(b"Lang");
        if opts.lang.is_some() || !has {
            cat.set(
                "Lang",
                Object::String(l.as_bytes().to_vec(), StringFormat::Literal),
            );
        }
    }
    pdf.set(cat_id, Object::Dictionary(cat));
    if let Some(t) = opts
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        set_title(pdf, t)?;
        report.title = Some(t.to_string());
    } else {
        report.title = current_title(pdf);
    }
    if report.title.is_some() {
        set_display_doc_title(pdf)?;
    }
    tree.write(pdf)?;
    Ok(report)
}

/// Remove MCIDs from page `index`'s content (retag all).
pub fn strip_page(pdf: &mut Pdf, index: usize) -> Result<()> {
    let pc = load(pdf, index)?;
    let c = warraq_edit::content::parse(&pc.data)?;
    let res = resources(pdf, pc.page_id);
    let splices = {
        let named = named_props(pdf, &res);
        let m = analyze(&c, &named);
        strip_mcids(&c, &m)
    };
    if !splices.is_empty() {
        write(pdf, &pc, &splices, None)?;
    }
    Ok(())
}

/// The document title (Info `/Title`, else XMP `dc:title`).
pub fn current_title(pdf: &Pdf) -> Option<String> {
    if let Some(t) = get_info(pdf).get("Title").filter(|t| !t.trim().is_empty()) {
        return Some(t.clone());
    }
    let xmp = warraq_pdf::metadata::get_xmp(pdf).ok().flatten()?;
    crate::meta::xmp_title(&xmp)
}

/// Set Info `/Title` and XMP `dc:title`.
pub fn set_title(pdf: &mut Pdf, title: &str) -> Result<()> {
    if title.chars().count() > 1000 {
        return Err(A11yError::Params("title too long".into()));
    }
    let mut ch = BTreeMap::new();
    ch.insert("Title".to_string(), Some(title.to_string()));
    warraq_pdf::metadata::set_info(pdf, &ch)?;
    let xmp = warraq_pdf::metadata::get_xmp(pdf)?;
    let new = match xmp {
        Some(x) => crate::meta::xmp_with_title(&x, title),
        None => warraq_pdf::metadata::xmp_from_info(&get_info(pdf)),
    };
    warraq_pdf::metadata::set_xmp(pdf, &new)?;
    Ok(())
}

/// `/ViewerPreferences /DisplayDocTitle true`.
pub fn set_display_doc_title(pdf: &mut Pdf) -> Result<()> {
    let cat_id = pdf.root_id()?;
    let mut cat = pdf.catalog()?.clone();
    match cat.get(b"ViewerPreferences").ok().cloned() {
        Some(Object::Reference(id)) if pdf.get_dict(id).is_some() => {
            let mut d = pdf.get_dict(id).cloned().unwrap_or_default();
            d.set("DisplayDocTitle", Object::Boolean(true));
            pdf.set(id, Object::Dictionary(d));
        }
        other => {
            let mut d = match other {
                Some(Object::Dictionary(d)) => d,
                _ => Dictionary::new(),
            };
            d.set("DisplayDocTitle", Object::Boolean(true));
            cat.set("ViewerPreferences", Object::Dictionary(d));
            pdf.set(cat_id, Object::Dictionary(cat));
        }
    }
    Ok(())
}

fn lang_of_words<'a>(texts: impl IntoIterator<Item = &'a str>) -> Option<&'static str> {
    lang::dominant(texts)
}

/// Tag one page.
#[allow(clippy::too_many_arguments)]
fn tag_page(
    pdf: &mut Pdf,
    pm: &PageMap,
    st: &Stats,
    doc_lang: Option<&str>,
    tagged_annots: &HashSet<ObjectId>,
    used_mcids: &HashSet<i64>,
    tree: &mut Tree,
    container: Option<usize>,
    report: &mut Report,
) -> Result<()> {
    let ops = &pm.scan.content.ops;
    let n = ops.len();
    let show_at = pm.show_at();
    let image_at = pm.image_at();
    let marks = &pm.marks;
    let mut elems: Vec<PElem> = Vec::new();
    let nw = pm.words.len();
    let mut word_owner: Vec<Owner> = vec![Owner::Neutral; nw];

    // Words already tagged (or artifacts) are left alone.
    let mut word_tagged = vec![false; nw];
    for (w, info) in pm.words.iter().enumerate() {
        if info.artifact {
            if let Some(t) = word_tagged.get_mut(w) {
                *t = true;
            }
        }
    }
    for (si, s) in pm.scan.shows.iter().enumerate() {
        let tagged = marks
            .get(s.op)
            .is_some_and(|m| m.mcid.is_some() || m.artifact);
        if let (true, Some(Some(w))) = (tagged, pm.show_word.get(si)) {
            if let Some(t) = word_tagged.get_mut(*w) {
                *t = true;
            }
        }
    }
    let free = |w: usize, wo: &Vec<Owner>| {
        !word_tagged.get(w).copied().unwrap_or(true) && matches!(wo.get(w), Some(Owner::Neutral))
    };

    // Paragraph roles decided first (lists and pagination are kept out of table detection).
    let mut para_label: Vec<Option<String>> = Vec::with_capacity(pm.paras.len());
    for (pi, p) in pm.paras.iter().enumerate() {
        let lab = if st.pagination.contains_key(&(pm.index, pi)) {
            None
        } else {
            list_label(&p.text)
        };
        para_label.push(lab);
    }

    // 1. Tables.
    let src = DocSource::borrowed(pdf.document());
    let segs = warraq_office::rules::page_segments(&src, pm.index).unwrap_or_default();
    let mut grids = ruled_grids(&segs);
    grids.retain(|g| {
        let b = g.bbox();
        (0..nw).any(|w| {
            pm.words.get(w).is_some_and(|x| {
                let (cx, cy) = (x.bbox.cx(), x.bbox.cy());
                free(w, &word_owner) && cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1
            })
        })
    });
    let exclude: Vec<Rect> = grids.iter().map(|g| g.bbox()).collect();
    let boxes: Vec<WordBox> = pm
        .words
        .iter()
        .enumerate()
        .filter(|(w, x)| {
            free(*w, &word_owner)
                && para_label.get(x.para).is_some_and(Option::is_none)
                && !st.pagination.contains_key(&(pm.index, x.para))
        })
        .map(|(w, x)| WordBox {
            bbox: x.bbox,
            size: x.size,
            id: w,
        })
        .collect();
    grids.extend(aligned_grids(&boxes, &exclude));
    for g in &grids {
        let t = elems.len();
        elems.push(PElem::new("Table", None));
        let rtl = {
            let inside: Vec<&crate::pagemap::WordInfo> = pm
                .words
                .iter()
                .filter(|x| g.cell_at(x.bbox.cx(), x.bbox.cy()).is_some())
                .collect();
            inside.iter().filter(|x| x.rtl).count() * 2 > inside.len()
        };
        let cols = g.cols();
        let mut rows: HashMap<usize, usize> = HashMap::new();
        let mut cell_elem: Vec<usize> = Vec::with_capacity(g.cells.len());
        for c in &g.cells {
            let tr = *rows.entry(c.row).or_insert_with(|| {
                let mut e = PElem::new("TR", Some(t));
                e.order = Some(c.row as f64);
                e.keep_empty = true;
                elems.push(e);
                elems.len() - 1
            });
            let th = c.row == 0 && g.rows() >= 2;
            let mut e = PElem::new(if th { "TH" } else { "TD" }, Some(tr));
            let logical_col = if rtl {
                cols.saturating_sub(c.col + c.colspan)
            } else {
                c.col
            };
            e.order = Some(logical_col as f64);
            e.keep_empty = true;
            let mut a = Dictionary::new();
            a.set("O", name("Table"));
            if th {
                a.set("Scope", name("Column"));
            }
            if c.rowspan > 1 {
                a.set("RowSpan", Object::Integer(c.rowspan as i64));
            }
            if c.colspan > 1 {
                a.set("ColSpan", Object::Integer(c.colspan as i64));
            }
            if a.len() > 1 {
                e.attrs = Some(Object::Dictionary(a));
            }
            elems.push(e);
            cell_elem.push(elems.len() - 1);
        }
        let b = g.bbox();
        if let Some(e) = elems.get_mut(t) {
            e.pos_rank = Some(pos_rank(pm, &b));
        }
        for w in 0..nw {
            if !free(w, &word_owner) {
                continue;
            }
            let Some(x) = pm.words.get(w) else { continue };
            if let Some(ci) = g.cell_at(x.bbox.cx(), x.bbox.cy()) {
                if let (Some(e), Some(o)) = (cell_elem.get(ci), word_owner.get_mut(w)) {
                    *o = Owner::Elem(*e);
                }
            }
        }
    }

    // 2. Paragraphs: pagination artifacts, list items, headings, paragraphs.
    let mut last_list: Option<usize> = None;
    for (pi, p) in pm.paras.iter().enumerate() {
        let ws: Vec<usize> = p.words.clone().filter(|w| free(*w, &word_owner)).collect();
        if ws.is_empty() {
            if p.words
                .clone()
                .any(|w| matches!(word_owner.get(w), Some(Owner::Elem(_))))
            {
                last_list = None;
            }
            continue;
        }
        if let Some(top) = st.pagination.get(&(pm.index, pi)) {
            let k = if *top {
                ArtKind::Header
            } else {
                ArtKind::Footer
            };
            for w in ws {
                if let Some(o) = word_owner.get_mut(w) {
                    *o = Owner::Art(k);
                }
            }
            continue;
        }
        let text: String = ws
            .iter()
            .filter_map(|w| pm.words.get(*w).map(|x| x.text.as_str()))
            .collect::<Vec<_>>()
            .join(" ");
        if let Some(label) = para_label
            .get(pi)
            .cloned()
            .flatten()
            .filter(|_| list_label(&text).is_some())
        {
            let l = match last_list {
                Some(l) => l,
                None => {
                    elems.push(PElem::new("L", None));
                    elems.len() - 1
                }
            };
            last_list = Some(l);
            elems.push(PElem::new("LI", Some(l)));
            let li = elems.len() - 1;
            let first = ws.first().copied();
            let label_word =
                first.filter(|w| pm.words.get(*w).is_some_and(|x| x.text.trim() == label));
            let body_words: Vec<usize> = ws
                .iter()
                .copied()
                .filter(|w| Some(*w) != label_word)
                .collect();
            if let Some(lw) = label_word {
                elems.push(PElem::new("Lbl", Some(li)));
                let lbl = elems.len() - 1;
                if let Some(o) = word_owner.get_mut(lw) {
                    *o = Owner::Elem(lbl);
                }
            }
            if !body_words.is_empty() {
                elems.push(PElem::new("LBody", Some(li)));
                let body = elems.len() - 1;
                for w in body_words {
                    if let Some(o) = word_owner.get_mut(w) {
                        *o = Owner::Elem(body);
                    }
                }
            }
            continue;
        }
        last_list = None;
        let sizes: Vec<f64> = ws
            .iter()
            .filter_map(|w| pm.words.get(*w).map(|x| x.size))
            .collect();
        let size = {
            let mut v = sizes.clone();
            v.sort_by(f64::total_cmp);
            v.get(v.len() / 2).copied().unwrap_or(0.0)
        };
        let role = match st.heading_level(size, &text, p.lines) {
            Some(l) => format!("H{l}"),
            None => "P".to_string(),
        };
        elems.push(PElem::new(&role, None));
        let e = elems.len() - 1;
        for w in ws {
            if let Some(o) = word_owner.get_mut(w) {
                *o = Owner::Elem(e);
            }
        }
    }

    // 3. Annotations: links take the words they cover; widgets and others by position.
    for a in annots(pdf, pm.page_id()) {
        if tagged_annots.contains(&a) {
            continue;
        }
        let Some((kind, hidden)) = annot_kind(pdf, a) else {
            continue;
        };
        if !annot_needs_tag(&kind, hidden) {
            continue;
        }
        let Some(r) = pdf.get_dict(a).and_then(|d| annot_rect(pdf, d)) else {
            continue;
        };
        let tl = pm.to_tl(&warraq_edit::geom::Rect::new(r[0], r[1], r[2], r[3]));
        match kind.as_str() {
            "Link" => {
                let covered: Vec<usize> = (0..nw)
                    .filter(|w| {
                        pm.words.get(*w).is_some_and(|x| {
                            let (cx, cy) = (x.bbox.cx(), x.bbox.cy());
                            cx >= tl.x0 - 1.0
                                && cx <= tl.x1 + 1.0
                                && cy >= tl.y0 - 1.0
                                && cy <= tl.y1 + 1.0
                        }) && matches!(word_owner.get(*w), Some(Owner::Elem(_)))
                    })
                    .collect();
                let mut votes: HashMap<usize, usize> = HashMap::new();
                for w in &covered {
                    if let Some(Owner::Elem(e)) = word_owner.get(*w) {
                        *votes.entry(*e).or_default() += 1;
                    }
                }
                let parent = votes
                    .into_iter()
                    .max_by_key(|(e, n)| (*n, usize::MAX - e))
                    .map(|(e, _)| e);
                let mut link = PElem::new("Link", parent);
                link.objr = Some(a);
                link.pos_rank = Some(pos_rank(pm, &tl));
                elems.push(link);
                let li = elems.len() - 1;
                for w in covered {
                    if word_owner.get(w) == parent.map(Owner::Elem).as_ref() {
                        if let Some(o) = word_owner.get_mut(w) {
                            *o = Owner::Elem(li);
                        }
                    }
                }
            }
            "Widget" => {
                let mut f = PElem::new("Form", None);
                f.objr = Some(a);
                f.pos_rank = Some(pos_rank(pm, &tl));
                elems.push(f);
            }
            _ => {
                let mut f = PElem::new("Annot", None);
                f.objr = Some(a);
                f.pos_rank = Some(pos_rank(pm, &tl));
                elems.push(f);
            }
        }
    }

    // 4. Language: element language from its words; other-script runs become Spans.
    let mut words_of: HashMap<usize, Vec<usize>> = HashMap::new();
    for (w, o) in word_owner.iter().enumerate() {
        if let Owner::Elem(e) = o {
            words_of.entry(*e).or_default().push(w);
        }
    }
    let mut leaves: Vec<usize> = words_of.keys().copied().collect();
    leaves.sort_unstable();
    for e in leaves {
        let ws = words_of.get(&e).cloned().unwrap_or_default();
        let el = lang_of_words(
            ws.iter()
                .filter_map(|w| pm.words.get(*w).map(|x| x.text.as_str())),
        );
        let Some(el) = el else { continue };
        if doc_lang.is_none_or(|d| !lang::same(d, el)) {
            if let Some(pe) = elems.get_mut(e) {
                pe.lang = Some(el.to_string());
            }
        }
        // Runs of other-language words (neutral words between two words of the run join it).
        let langs: Vec<Option<&'static str>> = ws
            .iter()
            .map(|w| pm.words.get(*w).and_then(|x| lang::detect(&x.text)))
            .collect();
        let mut k = 0usize;
        while k < ws.len() {
            let Some(Some(l)) = langs.get(k).copied() else {
                k += 1;
                continue;
            };
            if lang::same(l, el) {
                k += 1;
                continue;
            }
            // Extend the run over words of language `l` and neutral words followed by `l`.
            let mut end = k;
            let mut j = k + 1;
            while j < ws.len() {
                match langs.get(j).copied().flatten() {
                    Some(x) if x == l => {
                        end = j;
                        j += 1;
                    }
                    None => j += 1,
                    Some(_) => break,
                }
            }
            let mut span = PElem::new("Span", Some(e));
            span.lang = Some(l.to_string());
            elems.push(span);
            let si = elems.len() - 1;
            for w in ws.iter().take(end + 1).skip(k) {
                if let Some(o) = word_owner.get_mut(*w) {
                    *o = Owner::Elem(si);
                }
            }
            k = end + 1;
        }
    }

    // 5. Operations → units.
    let mut op_owner: Vec<Owner> = vec![Owner::Neutral; n];
    let mut units: Vec<Unit> = Vec::new();
    let mut path_start: Option<usize> = None;
    let mut orphan: Option<usize> = None;
    for (i, op) in ops.iter().enumerate() {
        let Some(m) = marks.get(i) else { break };
        let tagged = m.mcid.is_some() || m.artifact;
        if is_mc(op) {
            let opener = if op.is(b"EMC") {
                m.mc_match.and_then(|o| marks.get(o))
            } else {
                Some(m)
            };
            let structural = opener.is_none_or(|o| o.opens_mcid.is_some() || o.opens_artifact);
            if structural || tagged {
                set(&mut op_owner, i, Owner::Blocker);
            }
            path_start = None;
            continue;
        }
        if is_path_construct(op) {
            path_start.get_or_insert(i);
            continue;
        }
        if op.is(b"W") || op.is(b"W*") {
            continue;
        }
        if op.is(b"n") {
            path_start = None;
            continue;
        }
        if is_path_paint(op) {
            let s = path_start.take().unwrap_or(i);
            let own = if tagged {
                Owner::Blocker
            } else {
                Owner::Art(ArtKind::Layout)
            };
            for k in s..=i {
                set(&mut op_owner, k, own);
            }
            if !tagged {
                units.push(Unit {
                    s,
                    e: i,
                    owner: own,
                    rank: None,
                });
            }
            continue;
        }
        path_start = None;
        if let Some(Some(si)) = show_at.get(i) {
            if !pm.show_visible.get(*si).copied().unwrap_or(false) {
                continue;
            }
            if tagged {
                set(&mut op_owner, i, Owner::Blocker);
                continue;
            }
            let word = pm.show_word.get(*si).copied().flatten();
            let own = match word.and_then(|w| word_owner.get(w).copied()) {
                Some(o @ (Owner::Elem(_) | Owner::Art(_))) => o,
                _ if pm.show_blank.get(*si).copied().unwrap_or(false) => Owner::Absorb,
                Some(_) if word.is_some_and(|w| word_tagged.get(w).copied().unwrap_or(false)) => {
                    // The glyphs repeat a tagged word (e.g. a stroke over a filled copy).
                    Owner::Art(ArtKind::Layout)
                }
                _ => {
                    let o = *orphan.get_or_insert_with(|| {
                        let mut e = PElem::new("P", None);
                        e.pos_rank = Some(nw as f64 + 1.0);
                        elems.push(e);
                        elems.len() - 1
                    });
                    Owner::Elem(o)
                }
            };
            set(&mut op_owner, i, own);
            if own != Owner::Absorb {
                let r = match pm.show_votes.get(*si).map(Vec::as_slice) {
                    Some([first, .., last]) => Some((first.0 as f64, last.0 as f64)),
                    Some([one]) => Some((one.0 as f64, one.0 as f64)),
                    _ => None,
                };
                units.push(Unit {
                    s: i,
                    e: i,
                    owner: own,
                    rank: r,
                });
            }
            continue;
        }
        let picture = if let Some(Some(ii)) = image_at.get(i) {
            Some(*ii)
        } else {
            None
        };
        let kind = if picture.is_some() {
            Some("image")
        } else if op.is(b"Do") {
            xobject_kind(pdf, pm, i)
        } else {
            None
        };
        let own = if tagged && (kind.is_some() || op.is(b"sh")) {
            Some(Owner::Blocker)
        } else {
            match kind {
                Some("image") => {
                    let r = picture.and_then(|ii| pm.image_box(ii));
                    let mut e = PElem::new("Figure", None);
                    if let Some(b) = r {
                        e.pos_rank = Some(pos_rank(pm, &b));
                    }
                    if let Some(ii) = picture {
                        if let Some(im) = pm.scan.images.get(ii) {
                            let u = im
                                .ctm
                                .map_rect(&warraq_edit::geom::Rect::new(0.0, 0.0, 1.0, 1.0));
                            let mut a = Dictionary::new();
                            a.set("O", name("Layout"));
                            a.set("Placement", name("Block"));
                            a.set("BBox", rect_obj([u.x0, u.y0, u.x1, u.y1]));
                            e.attrs = Some(Object::Dictionary(a));
                        }
                    }
                    elems.push(e);
                    Some(Owner::Elem(elems.len() - 1))
                }
                Some("form") => {
                    let id = op
                        .operands
                        .first()
                        .and_then(|o| o.value.name())
                        .and_then(|nm| {
                            let res = resources(pdf, pm.page_id());
                            warraq_edit::page::resource(pdf, &res, b"XObject", nm)
                                .and_then(|(id, _)| id)
                        });
                    match form_class(pdf, id) {
                        FormClass::Artifact | FormClass::Tagged => None,
                        FormClass::Graphic => Some(Owner::Art(ArtKind::Layout)),
                        FormClass::Text => {
                            let mut e = PElem::new("Figure", None);
                            e.pos_rank = Some(nw as f64);
                            elems.push(e);
                            Some(Owner::Elem(elems.len() - 1))
                        }
                    }
                }
                _ if op.is(b"sh") => Some(Owner::Art(ArtKind::Layout)),
                _ => None,
            }
        };
        if let Some(o) = own {
            set(&mut op_owner, i, o);
            if o != Owner::Blocker {
                let r = match o {
                    Owner::Elem(e) => elems.get(e).and_then(|x| x.pos_rank).map(|r| (r, r)),
                    _ => None,
                };
                units.push(Unit {
                    s: i,
                    e: i,
                    owner: o,
                    rank: r,
                });
            }
        }
    }

    // 6. Units → marked-content sequences.
    let content = &pm.scan.content;
    let clean = |range: std::ops::Range<usize>, own: Owner, op_owner: &Vec<Owner>| -> bool {
        range.into_iter().all(|k| match op_owner.get(k) {
            Some(Owner::Neutral) | Some(Owner::Absorb) => true,
            Some(o) => *o == own,
            None => false,
        })
    };
    let mut seqs: Vec<Seq> = Vec::new();
    let mut floor: Option<usize> = None;
    let mut cur: Option<(Seq, usize, usize)> = None; // (seq, first unit start, last unit end)
    for u in units {
        if let Some((c, _, _)) = &mut cur {
            if u.s <= c.e && u.owner == c.owner {
                c.rank = union(c.rank, u.rank);
                continue;
            }
        }
        if let Some((c, first, last)) = &mut cur {
            let contiguous = match (c.rank, u.rank) {
                (Some((lo, hi)), Some((a, b))) => a <= hi + 1.0 && b >= lo - 1.0,
                _ => true,
            };
            if c.owner == u.owner
                && u.s > *last
                && contiguous
                && clean(*last + 1..u.s, u.owner, &op_owner)
            {
                if let Some((s2, e2)) = balance(content, marks, *first, u.e, floor) {
                    if clean(s2..*first, u.owner, &op_owner)
                        && clean(u.e + 1..e2 + 1, u.owner, &op_owner)
                    {
                        c.s = s2;
                        c.e = e2;
                        c.rank = union(c.rank, u.rank);
                        *last = u.e;
                        continue;
                    }
                }
            }
        }
        if let Some((c, _, _)) = cur.take() {
            floor = Some(c.e);
            seqs.push(c);
        }
        if floor.is_some_and(|f| u.s <= f) {
            continue; // inside an emitted sequence's wrapper (cannot happen for other owners)
        }
        if let Some((s2, e2)) = balance(content, marks, u.s, u.e, floor) {
            if clean(s2..u.s, u.owner, &op_owner) && clean(u.e + 1..e2 + 1, u.owner, &op_owner) {
                cur = Some((
                    Seq {
                        s: s2,
                        e: e2,
                        owner: u.owner,
                        rank: u.rank,
                    },
                    u.s,
                    u.e,
                ));
            }
        }
    }
    if let Some((c, _, _)) = cur.take() {
        seqs.push(c);
    }
    // Blank glyphs outside every sequence: artifacts on their own.
    let mut covered = vec![false; n];
    for s in &seqs {
        for k in s.s..=s.e {
            if let Some(c) = covered.get_mut(k) {
                *c = true;
            }
        }
    }
    let mut extra: Vec<Seq> = Vec::new();
    for (i, o) in op_owner.iter().enumerate() {
        if *o == Owner::Absorb && !covered.get(i).copied().unwrap_or(true) {
            extra.push(Seq {
                s: i,
                e: i,
                owner: Owner::Art(ArtKind::Layout),
                rank: None,
            });
        }
    }
    seqs.extend(extra);

    // 7. MCIDs and content insertions.
    let mut next = used_mcids.iter().copied().max().map_or(0, |m| m + 1);
    for m in &marks.ops {
        if let Some(x) = m.opens_mcid {
            next = next.max(x + 1);
        }
    }
    let mut ins = Insert::default();
    let mut mcids_of: HashMap<usize, Vec<(f64, i64)>> = HashMap::new();
    for s in &seqs {
        let (Some(a), Some(b)) = (content.ops.get(s.s), content.ops.get(s.e)) else {
            continue;
        };
        match s.owner {
            Owner::Elem(e) => {
                let role = elems
                    .get(e)
                    .map(|x| x.role.clone())
                    .unwrap_or_else(|| "Span".into());
                let lang = elems.get(e).and_then(|x| x.lang.clone());
                let mut props = format!("<</MCID {next}");
                if let (Some(l), "Span") = (&lang, role.as_str()) {
                    props.push_str(&format!(" /Lang ({l})"));
                }
                props.push_str(">>");
                ins.open(a.span.start, format!("/{role} {props} BDC"));
                ins.close(b.span.end);
                let r = s.rank.map_or(f64::MAX, |(lo, _)| lo);
                mcids_of.entry(e).or_default().push((r, next));
                next += 1;
                report.mcids += 1;
            }
            Owner::Art(k) => {
                let t = match k {
                    ArtKind::Layout => "/Artifact BMC".to_string(),
                    ArtKind::Header => {
                        "/Artifact <</Type /Pagination /Subtype /Header>> BDC".to_string()
                    }
                    ArtKind::Footer => {
                        "/Artifact <</Type /Pagination /Subtype /Footer>> BDC".to_string()
                    }
                };
                ins.open(a.span.start, t);
                ins.close(b.span.end);
                report.artifacts += 1;
            }
            _ => {}
        }
    }
    if !ins.is_empty() {
        let splices: Vec<Splice> = ins.splices();
        write(pdf, &pm.pc, &splices, None)?;
    }

    // 8. Structure: ranks bottom-up, empty elements dropped, kids in reading order.
    let ne = elems.len();
    let mut rank = vec![f64::MAX; ne];
    let mut alive = vec![false; ne];
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); ne];
    for (i, e) in elems.iter().enumerate() {
        if let Some(p) = e.parent {
            if let Some(c) = children.get_mut(p) {
                c.push(i);
            }
        }
    }
    for i in (0..ne).rev() {
        let Some(e) = elems.get(i) else { continue };
        // Content decides the rank; the position only places elements without content.
        let mut r = f64::MAX;
        let mut any = e.objr.is_some() || e.keep_empty;
        if let Some(ms) = mcids_of.get(&i) {
            any |= !ms.is_empty();
            for (mr, _) in ms {
                r = r.min(*mr);
            }
        }
        for c in children.get(i).cloned().unwrap_or_default() {
            if alive.get(c).copied().unwrap_or(false) {
                any = true;
                r = r.min(rank.get(c).copied().unwrap_or(f64::MAX));
            }
        }
        if r == f64::MAX {
            r = e.pos_rank.unwrap_or(f64::MAX);
        }
        if let Some(x) = rank.get_mut(i) {
            *x = r;
        }
        if let Some(x) = alive.get_mut(i) {
            *x = any;
        }
    }
    // A table whose cells are all empty is not kept.
    for (i, e) in elems.iter().enumerate() {
        if e.role == "Table" {
            let has_content = descendants(&children, i)
                .iter()
                .any(|d| mcids_of.get(d).is_some_and(|m| !m.is_empty()));
            if !has_content {
                for d in descendants(&children, i) {
                    if let Some(a) = alive.get_mut(d) {
                        *a = false;
                    }
                }
                if let Some(a) = alive.get_mut(i) {
                    *a = false;
                }
            }
        }
    }
    let page_id = pm.page_id();
    let mut tops: Vec<usize> = (0..ne)
        .filter(|i| {
            elems.get(*i).is_some_and(|e| e.parent.is_none())
                && alive.get(*i).copied().unwrap_or(false)
        })
        .collect();
    tops.sort_by(|a, b| {
        let ra = rank.get(*a).copied().unwrap_or(f64::MAX);
        let rb = rank.get(*b).copied().unwrap_or(f64::MAX);
        ra.total_cmp(&rb).then(a.cmp(b))
    });
    let plan = Materialize {
        elems: &elems,
        children: &children,
        alive: &alive,
        rank: &rank,
        mcids_of: &mcids_of,
        page_id,
    };
    for i in tops {
        plan.add(tree, i, container, 0, report);
    }
    Ok(())
}

/// Adds planned elements to the tree in reading order.
struct Materialize<'a> {
    elems: &'a [PElem],
    children: &'a [Vec<usize>],
    alive: &'a [bool],
    rank: &'a [f64],
    mcids_of: &'a HashMap<usize, Vec<(f64, i64)>>,
    page_id: ObjectId,
}

impl Materialize<'_> {
    fn add(
        &self,
        tree: &mut Tree,
        i: usize,
        parent: Option<usize>,
        depth: usize,
        report: &mut Report,
    ) {
        let Some(pe) = self.elems.get(i) else { return };
        if depth > 32 {
            return;
        }
        let mut el = Elem::new(&pe.role, parent, Some(self.page_id));
        el.lang = pe.lang.clone();
        if let Some(a) = &pe.attrs {
            el.dict.set("A", a.clone());
        }
        let ti = tree.add(el, parent);
        *report.elements.entry(pe.role.clone()).or_default() += 1;
        // MCIDs and child elements by (order key, rank).
        let mut kids: Vec<(f64, f64, Option<usize>, i64)> = Vec::new();
        for (r, m) in self.mcids_of.get(&i).cloned().unwrap_or_default() {
            kids.push((0.0, r, None, m));
        }
        for &c in self.children.get(i).map(Vec::as_slice).unwrap_or(&[]) {
            if !self.alive.get(c).copied().unwrap_or(false) {
                continue;
            }
            let key = self.elems.get(c).and_then(|x| x.order).unwrap_or(0.0);
            kids.push((
                key,
                self.rank.get(c).copied().unwrap_or(f64::MAX),
                Some(c),
                0,
            ));
        }
        kids.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
        for (_, _, child, m) in kids {
            match child {
                Some(c) => self.add(tree, c, Some(ti), depth + 1, report),
                None => {
                    if let Some(te) = tree.elems.get_mut(ti) {
                        te.kids.push(Kid::Mcr {
                            mcid: m,
                            page: None,
                            stm: None,
                        });
                    }
                }
            }
        }
        if let Some(a) = pe.objr {
            if let Some(te) = tree.elems.get_mut(ti) {
                te.kids.push(Kid::Objr {
                    obj: a,
                    page: Some(self.page_id),
                });
            }
        }
    }
}

fn descendants(children: &[Vec<usize>], i: usize) -> Vec<usize> {
    let mut out = Vec::new();
    let mut stack = children.get(i).cloned().unwrap_or_default();
    while let Some(c) = stack.pop() {
        out.push(c);
        if out.len() > 1_000_000 {
            break;
        }
        stack.extend(children.get(c).cloned().unwrap_or_default());
    }
    out
}

fn set(v: &mut [Owner], i: usize, o: Owner) {
    if let Some(x) = v.get_mut(i) {
        *x = o;
    }
}

fn union(a: Option<(f64, f64)>, b: Option<(f64, f64)>) -> Option<(f64, f64)> {
    match (a, b) {
        (Some((a0, a1)), Some((b0, b1))) => Some((a0.min(b0), a1.max(b1))),
        (x, None) | (None, x) => x,
    }
}

/// Reading rank of a box: just before the first paragraph that starts below its top edge.
fn pos_rank(pm: &PageMap, b: &Rect) -> f64 {
    for p in &pm.paras {
        if p.bbox.y0 >= b.y0 - 1.0 {
            return p.words.start as f64 - 0.5;
        }
    }
    pm.words.len() as f64 + 0.5
}
