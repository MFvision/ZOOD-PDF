//! `redact.sanitize`: remove hidden information, then write the file whole (earlier revisions and
//! orphaned objects are dropped by the garbage-collecting rewrite).
//!
//! Classes: document info, XMP (catalog and every `/Metadata`), JavaScript (document-level names,
//! actions anywhere including `/Next` chains and additional-actions of fields), automatic actions
//! (`/OpenAction`, `/AA` on the document, pages, annotations and fields), attachments (embedded
//! files, file-attachment annotations, associated files), comments (markup annotations and their
//! pop-ups), form data (clear values or flatten appearances), hidden layers (optional content that
//! is OFF in the default configuration, honouring OCMD policies and `/VE` — its content is
//! removed from the page, not just hidden), bookmarks, page thumbnails, `/PieceInfo`, links, and
//! hidden text. Hidden-text heuristics (documented): text drawn invisibly (`Tr 3`/`7`, e.g. an
//! OCR layer), text whose glyph boxes lie entirely outside the page's crop box, and text smaller
//! than 1 pt. White-on-white text is *not* detected.

use std::collections::{HashSet, VecDeque};

use lopdf::{Dictionary, Object, ObjectId};
use serde::{Deserialize, Serialize};
use warraq_pdf::limits::decode_stream;
use warraq_pdf::{pages, revisions, Pdf, Protection};
use warraq_text::geom::{Matrix, Rect};
use warraq_text::DocSource;

use crate::content::{ContentReport, HiddenText, Rewriter};
use crate::error::Result;
use crate::ocg::OcState;
use crate::util::{flate_stream, name_of, number};

/// How form data is removed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum FormMode {
    /// Keep forms as they are.
    Keep,
    /// Remove values (and the appearances that show them); viewers regenerate empty fields.
    #[default]
    Clear,
    /// Draw the current appearances into the pages and remove the form.
    Flatten,
}

/// What to remove. Everything is on by default except links and bookmarks.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct SanitizeOptions {
    pub metadata: bool,
    pub xmp: bool,
    pub javascript: bool,
    pub actions: bool,
    pub attachments: bool,
    pub comments: bool,
    pub forms: FormMode,
    pub hidden_layers: bool,
    pub bookmarks: bool,
    pub thumbnails: bool,
    pub piece_info: bool,
    pub links: bool,
    pub hidden_text: bool,
}

impl Default for SanitizeOptions {
    fn default() -> Self {
        SanitizeOptions {
            metadata: true,
            xmp: true,
            javascript: true,
            actions: true,
            attachments: true,
            comments: true,
            forms: FormMode::Clear,
            hidden_layers: true,
            bookmarks: false,
            thumbnails: true,
            piece_info: true,
            links: false,
            hidden_text: true,
        }
    }
}

/// Counts of what was removed.
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SanitizeReport {
    pub metadata: usize,
    pub xmp: usize,
    pub javascript: usize,
    pub actions: usize,
    pub attachments: usize,
    pub comments: usize,
    pub form_fields: usize,
    pub hidden_layers: usize,
    pub bookmarks: usize,
    pub thumbnails: usize,
    pub piece_info: usize,
    pub links: usize,
    pub hidden_text: usize,
    pub earlier_revisions: usize,
    pub orphans: usize,
    pub content: ContentReport,
}

const MARKUP: &[&[u8]] = &[
    b"Text",
    b"FreeText",
    b"Line",
    b"Square",
    b"Circle",
    b"Polygon",
    b"PolyLine",
    b"Highlight",
    b"Underline",
    b"Squiggly",
    b"StrikeOut",
    b"Stamp",
    b"Caret",
    b"Ink",
    b"Sound",
    b"Redact",
    b"Popup",
];

/// Replace object `id`'s dictionary (keeping a stream's data).
fn put_dict(pdf: &mut Pdf, id: ObjectId, d: Dictionary) {
    match pdf.get(id) {
        Some(Object::Stream(s)) => {
            let mut s = s.clone();
            s.dict = d;
            pdf.set(id, Object::Stream(s));
        }
        _ => pdf.set(id, Object::Dictionary(d)),
    }
}

fn ids(pdf: &Pdf) -> Vec<ObjectId> {
    pdf.objects().keys().copied().collect()
}

/// Remove `key` from every dictionary (and stream dictionary) of the document. Returns count.
fn strip_key_everywhere(pdf: &mut Pdf, key: &[u8]) -> usize {
    let mut n = 0;
    for id in ids(pdf) {
        let Some(d) = pdf.get_dict(id) else { continue };
        if d.has(key) {
            let mut d = d.clone();
            d.remove(key);
            put_dict(pdf, id, d);
            n += 1;
        }
    }
    n
}

fn is_js_action(pdf: &Pdf, a: &Object) -> bool {
    pdf.resolve(a)
        .and_then(|o| o.as_dict().ok())
        .is_some_and(|d| name_of(d, b"S") == Some(b"JavaScript"))
}

/// Clean an action (chain): JavaScript actions are spliced out of `/Next` chains. Returns the
/// replacement (`None` = remove the entry) and counts removed actions.
fn clean_action(
    pdf: &mut Pdf,
    a: &Object,
    depth: usize,
    count: &mut usize,
    seen: &mut HashSet<ObjectId>,
) -> Option<Object> {
    if depth > 64 {
        return None;
    }
    if let Object::Reference(id) = a {
        if !seen.insert(*id) {
            return Some(a.clone()); // cycle: leave as is (already visited)
        }
    }
    let d = pdf.resolve(a).and_then(|o| o.as_dict().ok())?.clone();
    let next = d.get(b"Next").ok().cloned();
    let cleaned_next: Option<Object> = match &next {
        None => None,
        Some(Object::Array(items)) => {
            let v: Vec<Object> = items
                .iter()
                .take(1024)
                .filter_map(|x| clean_action(pdf, x, depth + 1, count, seen))
                .flat_map(|x| match x {
                    Object::Array(inner) => inner,
                    o => vec![o],
                })
                .collect();
            if v.is_empty() {
                None
            } else if v.len() == 1 {
                v.into_iter().next()
            } else {
                Some(Object::Array(v))
            }
        }
        Some(x) => clean_action(pdf, x, depth + 1, count, seen),
    };
    if name_of(&d, b"S") == Some(b"JavaScript") {
        *count += 1;
        return cleaned_next;
    }
    let mut nd = d.clone();
    let mut changed = false;
    if nd.remove(b"JS").is_some() {
        // Rendition actions may carry a script.
        *count += 1;
        changed = true;
    }
    if next.is_some() {
        match &cleaned_next {
            Some(n) if Some(n) != next.as_ref() => {
                nd.set("Next", n.clone());
                changed = true;
            }
            None => {
                nd.remove(b"Next");
                changed = true;
            }
            _ => {}
        }
    }
    if !changed {
        return Some(a.clone());
    }
    match a {
        Object::Reference(id) => {
            put_dict(pdf, *id, nd);
            Some(a.clone())
        }
        _ => Some(Object::Dictionary(nd)),
    }
}

fn remove_javascript(pdf: &mut Pdf, count: &mut usize) -> Result<()> {
    // Document-level scripts in the names tree.
    let root = pdf.root_id()?;
    if let Some(cat) = pdf.get_dict(root).cloned() {
        match cat.get(b"Names").ok().cloned() {
            Some(Object::Reference(nid)) => {
                if let Some(nd) = pdf.get_dict(nid).cloned() {
                    if nd.has(b"JavaScript") {
                        let mut nd = nd;
                        nd.remove(b"JavaScript");
                        put_dict(pdf, nid, nd);
                        *count += 1;
                    }
                }
            }
            Some(Object::Dictionary(nd)) if nd.has(b"JavaScript") => {
                let mut nd = nd;
                nd.remove(b"JavaScript");
                let mut c = cat.clone();
                c.set("Names", Object::Dictionary(nd));
                put_dict(pdf, root, c);
                *count += 1;
            }
            _ => {}
        }
    }
    // Actions everywhere: /A, /OpenAction, every /AA entry.
    let mut seen = HashSet::new();
    for id in ids(pdf) {
        let Some(d) = pdf.get_dict(id).cloned() else {
            continue;
        };
        let mut nd = d.clone();
        let mut changed = false;
        for key in [&b"A"[..], b"OpenAction", b"PA"] {
            if let Ok(a) = d.get(key) {
                if matches!(pdf.resolve(a), Some(Object::Dictionary(_))) {
                    match clean_action(pdf, a, 0, count, &mut seen) {
                        Some(n) if &n == a => {}
                        Some(n) => {
                            nd.set(key.to_vec(), n);
                            changed = true;
                        }
                        None => {
                            nd.remove(key);
                            changed = true;
                        }
                    }
                }
            }
        }
        if let Ok(aa) = d.get(b"AA") {
            let aa_ref = aa.as_reference().ok();
            if let Some(aad) = pdf.resolve(aa).and_then(|o| o.as_dict().ok()).cloned() {
                let mut naa = aad.clone();
                let mut aa_changed = false;
                for (k, v) in aad.iter() {
                    match clean_action(pdf, v, 0, count, &mut seen) {
                        Some(n) if &n == v => {}
                        Some(n) => {
                            naa.set(k.clone(), n);
                            aa_changed = true;
                        }
                        None => {
                            naa.remove(k);
                            aa_changed = true;
                        }
                    }
                }
                if aa_changed {
                    match aa_ref {
                        Some(r) => put_dict(pdf, r, naa),
                        None => {
                            if naa.is_empty() {
                                nd.remove(b"AA");
                            } else {
                                nd.set("AA", Object::Dictionary(naa));
                            }
                            changed = true;
                        }
                    }
                }
            }
        }
        if changed {
            // Re-read in case clean_action rewrote this very object.
            let mut cur = pdf.get_dict(id).cloned().unwrap_or_default();
            for (k, v) in nd.iter() {
                cur.set(k.clone(), v.clone());
            }
            for k in [&b"A"[..], b"OpenAction", b"PA", b"AA"] {
                if !nd.has(k) {
                    cur.remove(k);
                }
            }
            put_dict(pdf, id, cur);
        }
    }
    // Calculation order refers to scripted fields.
    let _ = seen;
    Ok(())
}

fn catalog_remove(pdf: &mut Pdf, key: &[u8]) -> Result<bool> {
    let root = pdf.root_id()?;
    let Some(mut cat) = pdf.get_dict(root).cloned() else {
        return Ok(false);
    };
    if cat.remove(key).is_some() {
        put_dict(pdf, root, cat);
        return Ok(true);
    }
    Ok(false)
}

fn names_remove(pdf: &mut Pdf, key: &[u8]) -> Result<bool> {
    let root = pdf.root_id()?;
    let Some(cat) = pdf.get_dict(root).cloned() else {
        return Ok(false);
    };
    match cat.get(b"Names").ok().cloned() {
        Some(Object::Reference(nid)) => {
            if let Some(mut nd) = pdf.get_dict(nid).cloned() {
                if nd.remove(key).is_some() {
                    put_dict(pdf, nid, nd);
                    return Ok(true);
                }
            }
        }
        Some(Object::Dictionary(mut nd)) => {
            if nd.remove(key).is_some() {
                let mut c = cat.clone();
                c.set("Names", Object::Dictionary(nd));
                put_dict(pdf, root, c);
                return Ok(true);
            }
        }
        _ => {}
    }
    Ok(false)
}

/// Filter page annotations with `drop(dict) -> bool`; pop-ups of dropped annotations go too.
fn filter_annots(
    pdf: &mut Pdf,
    drop: &dyn Fn(&Pdf, &Dictionary) -> bool,
) -> Result<(usize, HashSet<ObjectId>)> {
    let list = pages::flatten(pdf)?;
    let mut count = 0;
    let mut removed = HashSet::new();
    for p in &list {
        let Some(pd) = pdf.get_dict(p.id).cloned() else {
            continue;
        };
        let annots_obj = match pd.get(b"Annots").ok() {
            Some(o) => o.clone(),
            None => continue,
        };
        let Some(Object::Array(annots)) = pdf.resolve(&annots_obj).cloned() else {
            continue;
        };
        let mut drop_ids: HashSet<ObjectId> = HashSet::new();
        let mut drop_idx: HashSet<usize> = HashSet::new();
        for (i, a) in annots.iter().enumerate() {
            let Some(d) = pdf.resolve(a).and_then(|o| o.as_dict().ok()) else {
                continue;
            };
            if drop(pdf, d) {
                drop_idx.insert(i);
                if let Object::Reference(id) = a {
                    drop_ids.insert(*id);
                }
                if let Ok(Object::Reference(pp)) = d.get(b"Popup") {
                    drop_ids.insert(*pp);
                }
                if name_of(d, b"Subtype") != Some(b"Popup") {
                    count += 1;
                }
            }
        }
        if drop_idx.is_empty() {
            continue;
        }
        let keep: Vec<Object> = annots
            .iter()
            .enumerate()
            .filter(|(i, a)| {
                if drop_idx.contains(i) {
                    return false;
                }
                let id = a.as_reference().ok();
                let parent_dropped = pdf
                    .resolve(a)
                    .and_then(|o| o.as_dict().ok())
                    .and_then(|d| d.get(b"Parent").ok())
                    .and_then(|x| x.as_reference().ok())
                    .is_some_and(|x| drop_ids.contains(&x));
                !(id.is_some_and(|x| drop_ids.contains(&x)) || parent_dropped)
            })
            .map(|(_, a)| a.clone())
            .collect();
        removed.extend(drop_ids);
        let mut pd = pd;
        pd.set("Annots", Object::Array(keep));
        put_dict(pdf, p.id, pd);
    }
    Ok((count, removed))
}

/// All field dictionaries (ids) of the AcroForm tree.
fn field_ids(pdf: &Pdf) -> Result<Vec<ObjectId>> {
    let cat = pdf.catalog()?;
    let Some(acro) = cat
        .get(b"AcroForm")
        .ok()
        .and_then(|o| pdf.resolve(o))
        .and_then(|o| o.as_dict().ok())
    else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut q: VecDeque<(ObjectId, usize)> = VecDeque::new();
    if let Some(Object::Array(f)) = acro.get(b"Fields").ok().and_then(|o| pdf.resolve(o)) {
        for x in f.iter().take(100_000) {
            if let Object::Reference(id) = x {
                q.push_back((*id, 0));
            }
        }
    }
    while let Some((id, depth)) = q.pop_front() {
        if depth > 64 || !seen.insert(id) || out.len() > 1_000_000 {
            continue;
        }
        out.push(id);
        if let Some(Object::Array(k)) = pdf
            .get_dict(id)
            .and_then(|d| d.get(b"Kids").ok())
            .and_then(|o| pdf.resolve(o))
        {
            for x in k.iter().take(100_000) {
                if let Object::Reference(kid) = x {
                    q.push_back((*kid, depth + 1));
                }
            }
        }
    }
    Ok(out)
}

fn acro_update(pdf: &mut Pdf, f: impl FnOnce(&mut Dictionary)) -> Result<()> {
    let root = pdf.root_id()?;
    let Some(cat) = pdf.get_dict(root).cloned() else {
        return Ok(());
    };
    match cat.get(b"AcroForm").ok().cloned() {
        Some(Object::Reference(aid)) => {
            if let Some(mut a) = pdf.get_dict(aid).cloned() {
                f(&mut a);
                put_dict(pdf, aid, a);
            }
        }
        Some(Object::Dictionary(mut a)) => {
            f(&mut a);
            let mut c = cat;
            c.set("AcroForm", Object::Dictionary(a));
            put_dict(pdf, root, c);
        }
        _ => {}
    }
    Ok(())
}

fn clear_forms(pdf: &mut Pdf) -> Result<usize> {
    let fields = field_ids(pdf)?;
    let mut n = 0;
    for id in fields {
        let Some(d) = pdf.get_dict(id).cloned() else {
            continue;
        };
        let mut nd = d.clone();
        let mut changed = false;
        for k in [&b"V"[..], b"DV", b"RV"] {
            if nd.remove(k).is_some() {
                changed = true;
            }
        }
        if nd.remove(b"AP").is_some() {
            changed = true;
        }
        if nd.has(b"AS") {
            nd.set("AS", Object::Name(b"Off".to_vec()));
            changed = true;
        }
        if changed {
            put_dict(pdf, id, nd);
            n += 1;
        }
    }
    acro_update(pdf, |a| {
        a.remove(b"XFA");
        a.set("NeedAppearances", Object::Boolean(true));
    })?;
    Ok(n)
}

fn matrix_of(pdf: &Pdf, d: &Dictionary, key: &[u8]) -> Matrix {
    match d.get(key).ok().and_then(|o| pdf.resolve(o)) {
        Some(Object::Array(a)) => {
            let v: Vec<f64> = a
                .iter()
                .filter_map(|x| pdf.resolve(x).and_then(number))
                .collect();
            match v.as_slice() {
                [a, b, c, dd, e, f] => Matrix::new(*a, *b, *c, *dd, *e, *f),
                _ => Matrix::IDENTITY,
            }
        }
        _ => Matrix::IDENTITY,
    }
}

fn rect_of(pdf: &Pdf, d: &Dictionary, key: &[u8]) -> Option<Rect> {
    match d.get(key).ok().and_then(|o| pdf.resolve(o)) {
        Some(Object::Array(a)) => {
            let v: Vec<f64> = a
                .iter()
                .filter_map(|x| pdf.resolve(x).and_then(number))
                .collect();
            match v.as_slice() {
                [a, b, c, e] => Some(Rect::new(*a, *b, *c, *e)),
                _ => None,
            }
        }
        _ => None,
    }
}

fn flatten_forms(pdf: &mut Pdf) -> Result<usize> {
    let list = pages::flatten(pdf)?;
    let mut n = 0;
    for p in &list {
        let Some(pd) = pdf.get_dict(p.id).cloned() else {
            continue;
        };
        let Some(Object::Array(annots)) =
            pd.get(b"Annots").ok().and_then(|o| pdf.resolve(o)).cloned()
        else {
            continue;
        };
        let mut ops = String::new();
        let mut res = p
            .resources
            .as_ref()
            .and_then(|o| pdf.resolve(o))
            .and_then(|o| o.as_dict().ok())
            .cloned()
            .unwrap_or_default();
        let mut xo = res
            .get(b"XObject")
            .ok()
            .and_then(|o| pdf.resolve(o))
            .and_then(|o| o.as_dict().ok())
            .cloned()
            .unwrap_or_default();
        let mut keep = Vec::new();
        for (i, a) in annots.iter().enumerate() {
            let Some(d) = pdf.resolve(a).and_then(|o| o.as_dict().ok()).cloned() else {
                keep.push(a.clone());
                continue;
            };
            if name_of(&d, b"Subtype") != Some(b"Widget") {
                keep.push(a.clone());
                continue;
            }
            n += 1;
            let flags = d
                .get(b"F")
                .ok()
                .and_then(|o| pdf.resolve(o))
                .and_then(number)
                .unwrap_or(0.0) as i64;
            if flags & 2 != 0 {
                continue; // hidden widget
            }
            let ap = d
                .get(b"AP")
                .ok()
                .and_then(|o| pdf.resolve(o))
                .and_then(|o| o.as_dict().ok())
                .cloned();
            let normal = ap.as_ref().and_then(|ap| ap.get(b"N").ok()).cloned();
            let stream_ref = match normal.as_ref().and_then(|o| pdf.resolve(o)) {
                Some(Object::Stream(_)) => normal.clone(),
                Some(Object::Dictionary(states)) => {
                    let st = match d.get(b"AS") {
                        Ok(Object::Name(s)) => s.clone(),
                        _ => b"Off".to_vec(),
                    };
                    states.get(&st).ok().cloned()
                }
                _ => None,
            };
            let Some(sref) = stream_ref else { continue };
            let Some(Object::Stream(s)) = pdf.resolve(&sref).cloned() else {
                continue;
            };
            let Some(rect) = rect_of(pdf, &d, b"Rect") else {
                continue;
            };
            let bbox = rect_of(pdf, &s.dict, b"BBox").unwrap_or(Rect::new(
                0.0,
                0.0,
                rect.width(),
                rect.height(),
            ));
            let m = matrix_of(pdf, &s.dict, b"Matrix");
            let t = crate::util::transform_rect(&m, &bbox);
            if t.width() <= 0.0 || t.height() <= 0.0 {
                continue;
            }
            let sx = rect.width() / t.width();
            let sy = rect.height() / t.height();
            let place = Matrix::new(sx, 0.0, 0.0, sy, rect.x0 - t.x0 * sx, rect.y0 - t.y0 * sy);
            let name = format!("WqFl{i}");
            let xref = match sref {
                Object::Reference(r) => Object::Reference(r),
                _ => Object::Reference(pdf.add(Object::Stream(s.clone()))),
            };
            let mut fs = s.clone();
            if !fs.dict.has(b"Subtype") {
                fs.dict.set("Subtype", Object::Name(b"Form".to_vec()));
            }
            let _ = fs;
            xo.set(name.as_bytes().to_vec(), xref);
            ops.push_str(&format!(
                "q {} cm /{name} Do Q\n",
                crate::util::matrix_ops(&place)
            ));
        }
        if keep.len() == annots.len() {
            continue;
        }
        res.set("XObject", Object::Dictionary(xo));
        let mut pd = pd;
        pd.set("Resources", Object::Dictionary(res));
        pd.set("Annots", Object::Array(keep));
        if !ops.is_empty() {
            let content = {
                let mut all = b"q\n".to_vec();
                let items: Vec<Object> = match pd.get(b"Contents").ok().and_then(|o| pdf.resolve(o))
                {
                    Some(Object::Array(a)) => a.clone(),
                    Some(_) => pd.get(b"Contents").ok().cloned().into_iter().collect(),
                    None => Vec::new(),
                };
                for it in &items {
                    if let Some(Object::Stream(cs)) = pdf.resolve(it) {
                        all.extend(decode_stream(cs, pdf.limits())?);
                        all.push(b'\n');
                    }
                }
                all.extend_from_slice(b"Q\n");
                all.extend_from_slice(ops.as_bytes());
                all
            };
            let cid = pdf.add(Object::Stream(flate_stream(Dictionary::new(), &content)));
            pd.set("Contents", Object::Reference(cid));
        }
        put_dict(pdf, p.id, pd);
    }
    catalog_remove(pdf, b"AcroForm")?;
    Ok(n)
}

/// Rewrite page contents for hidden layers / hidden text.
fn rewrite_pages(pdf: &mut Pdf, oc: Option<OcState>, hidden_text: bool) -> Result<ContentReport> {
    let list = pages::flatten(pdf)?;
    type Plan = (
        ObjectId,
        Vec<u8>,
        usize,
        Vec<(Vec<u8>, ObjectId)>,
        HashSet<Vec<u8>>,
        HashSet<Vec<u8>>,
        Dictionary,
    );
    let mut plans: Vec<Plan> = Vec::new();
    let (new_objects, report) = {
        let src = DocSource::borrowed(pdf.document());
        let mut rw = Rewriter::new(&src, pdf.next_number());
        rw.set_oc(oc);
        for p in &list {
            let Some(pd) = pdf.get_dict(p.id) else {
                continue;
            };
            let items: Vec<Object> = match pd.get(b"Contents").ok() {
                Some(Object::Array(a)) => a.clone(),
                Some(o) => match pdf.resolve(o) {
                    Some(Object::Array(a)) => a.clone(),
                    _ => vec![o.clone()],
                },
                None => Vec::new(),
            };
            let mut content = Vec::new();
            for it in items.iter().take(100_000) {
                if let Some(Object::Stream(s)) = pdf.resolve(it) {
                    content.extend(decode_stream(s, pdf.limits())?);
                    content.push(b'\n');
                }
            }
            let vb = p.visible_box();
            rw.set_hidden_text(hidden_text.then_some(HiddenText {
                page_box: Rect::new(vb[0], vb[1], vb[2], vb[3]),
                min_size: 1.0,
            }));
            let res = p
                .resources
                .as_ref()
                .and_then(|o| pdf.resolve(o))
                .and_then(|o| o.as_dict().ok())
                .cloned()
                .unwrap_or_default();
            let out = rw.rewrite(&content, &res, Matrix::IDENTITY);
            if out.changed {
                plans.push((
                    p.id,
                    out.content,
                    out.open_q,
                    out.additions,
                    out.used,
                    out.used_props,
                    res,
                ));
            }
        }
        (std::mem::take(&mut rw.new_objects), rw.report.clone())
    };
    for (id, o) in new_objects {
        pdf.set(id, o);
    }
    for (pid, content, open_q, additions, used, used_props, mut res) in plans {
        let Some(mut pd) = pdf.get_dict(pid).cloned() else {
            continue;
        };
        if res.has(b"Properties") {
            let mut props = res
                .get(b"Properties")
                .ok()
                .and_then(|o| pdf.resolve(o))
                .and_then(|o| o.as_dict().ok())
                .cloned()
                .unwrap_or_default();
            crate::content::prune_xobjects(&mut props, &used_props);
            res.set("Properties", Object::Dictionary(props));
            pd.set("Resources", Object::Dictionary(res.clone()));
        }
        if res.has(b"XObject") || !additions.is_empty() {
            let mut x = res
                .get(b"XObject")
                .ok()
                .and_then(|o| pdf.resolve(o))
                .and_then(|o| o.as_dict().ok())
                .cloned()
                .unwrap_or_default();
            for (n, id) in additions {
                x.set(n, Object::Reference(id));
            }
            crate::content::prune_xobjects(&mut x, &used);
            res.set("XObject", Object::Dictionary(x));
            pd.set("Resources", Object::Dictionary(res));
        }
        let mut c = content;
        for _ in 0..open_q.min(1 << 16) {
            c.extend_from_slice(b"\nQ");
        }
        let cid = pdf.add(Object::Stream(flate_stream(Dictionary::new(), &c)));
        pd.set("Contents", Object::Reference(cid));
        put_dict(pdf, pid, pd);
    }
    Ok(report)
}

/// OCG ids referenced from anywhere except the catalog's `/OCProperties`.
fn referenced_outside_ocproperties(pdf: &Pdf, candidates: &HashSet<ObjectId>) -> HashSet<ObjectId> {
    fn scan(o: &Object, c: &HashSet<ObjectId>, out: &mut HashSet<ObjectId>, depth: usize) {
        if depth > 64 {
            return;
        }
        match o {
            Object::Reference(r) if c.contains(r) => {
                out.insert(*r);
            }
            Object::Array(a) => a.iter().for_each(|x| scan(x, c, out, depth + 1)),
            Object::Dictionary(d) => d.iter().for_each(|(_, v)| scan(v, c, out, depth + 1)),
            Object::Stream(s) => s.dict.iter().for_each(|(_, v)| scan(v, c, out, depth + 1)),
            _ => {}
        }
    }
    let root = pdf.root_id().ok();
    let props_id = pdf
        .catalog()
        .ok()
        .and_then(|c| c.get(b"OCProperties").ok())
        .and_then(|o| o.as_reference().ok());
    let mut out = HashSet::new();
    for (id, o) in pdf.objects() {
        if Some(*id) == props_id || candidates.contains(id) {
            continue;
        }
        if Some(*id) == root {
            if let Object::Dictionary(d) = o {
                for (k, v) in d.iter() {
                    if k.as_slice() != b"OCProperties" {
                        scan(v, candidates, &mut out, 0);
                    }
                }
            }
            continue;
        }
        scan(o, candidates, &mut out, 0);
    }
    out
}

fn remove_hidden_ocgs(pdf: &mut Pdf, hidden: &HashSet<ObjectId>) -> Result<()> {
    // An OCG still used by a remaining OCMD (e.g. /VE [/Not hidden]) must stay declared, or the
    // expression would change meaning.
    let still = referenced_outside_ocproperties(pdf, hidden);
    let hidden: HashSet<ObjectId> = hidden.difference(&still).copied().collect();
    let hidden = &hidden;
    if hidden.is_empty() {
        return Ok(());
    }
    fn filter(o: &Object, hidden: &HashSet<ObjectId>, depth: usize) -> Object {
        if depth > 32 {
            return o.clone();
        }
        match o {
            Object::Array(a) => Object::Array(
                a.iter()
                    .filter(|x| !matches!(x, Object::Reference(r) if hidden.contains(r)))
                    .map(|x| filter(x, hidden, depth + 1))
                    .collect(),
            ),
            Object::Dictionary(d) => {
                let mut nd = Dictionary::new();
                for (k, v) in d.iter() {
                    nd.set(k.clone(), filter(v, hidden, depth + 1));
                }
                Object::Dictionary(nd)
            }
            other => other.clone(),
        }
    }
    let root = pdf.root_id()?;
    let Some(cat) = pdf.get_dict(root).cloned() else {
        return Ok(());
    };
    let Some(props) = cat.get(b"OCProperties").ok().cloned() else {
        return Ok(());
    };
    match &props {
        Object::Reference(pid) => {
            if let Some(d) = pdf.get_dict(*pid).cloned() {
                if let Object::Dictionary(nd) = filter(&Object::Dictionary(d), hidden, 0) {
                    put_dict(pdf, *pid, nd);
                }
            }
        }
        Object::Dictionary(_) => {
            let mut c = cat.clone();
            c.set("OCProperties", filter(&props, hidden, 0));
            put_dict(pdf, root, c);
        }
        _ => {}
    }
    // The /D config's lists may be indirect too.
    for id in ids(pdf) {
        let Some(Object::Array(a)) = pdf.get(id).cloned() else {
            continue;
        };
        if a.iter()
            .any(|x| matches!(x, Object::Reference(r) if hidden.contains(r)))
        {
            pdf.set(id, filter(&Object::Array(a), hidden, 0));
        }
    }
    Ok(())
}

/// Remove hidden information in memory; [`sanitize_and_rewrite`] returns the bytes.
pub fn sanitize(pdf: &mut Pdf, o: &SanitizeOptions) -> Result<SanitizeReport> {
    pdf.require("removing hidden information", |p| p.modify)?;
    let mut r = SanitizeReport {
        earlier_revisions: revisions::revisions(pdf.bytes(), pdf.limits())
            .len()
            .saturating_sub(1),
        ..Default::default()
    };
    let reachable = pdf.reachable()?.len();
    r.orphans = pdf.objects().len().saturating_sub(reachable);

    if o.metadata && pdf.trailer().has(b"Info") {
        pdf.set_trailer("Info", Object::Null);
        r.metadata = 1;
    }
    if o.xmp {
        r.xmp = strip_key_everywhere(pdf, b"Metadata");
    }
    if o.actions {
        r.actions += usize::from(catalog_remove(pdf, b"OpenAction")?);
        r.actions += strip_key_everywhere(pdf, b"AA");
    }
    if o.javascript {
        let mut n = 0;
        remove_javascript(pdf, &mut n)?;
        r.javascript = n;
    }
    if o.attachments {
        r.attachments += usize::from(names_remove(pdf, b"EmbeddedFiles")?);
        r.attachments += usize::from(catalog_remove(pdf, b"Collection")?);
        r.attachments += strip_key_everywhere(pdf, b"AF");
        let (n, _) = filter_annots(pdf, &|_, d| {
            name_of(d, b"Subtype") == Some(b"FileAttachment")
        })?;
        r.attachments += n;
    }
    if o.comments {
        let (n, _) = filter_annots(pdf, &|_, d| {
            name_of(d, b"Subtype").is_some_and(|s| MARKUP.contains(&s))
        })?;
        r.comments = n;
    }
    if o.links {
        let (n, _) = filter_annots(pdf, &|_, d| name_of(d, b"Subtype") == Some(b"Link"))?;
        r.links = n;
    }
    match o.forms {
        FormMode::Keep => {}
        FormMode::Clear => r.form_fields = clear_forms(pdf)?,
        FormMode::Flatten => r.form_fields = flatten_forms(pdf)?,
    }
    // Hidden layers and hidden text: content rewrite.
    let oc = if o.hidden_layers {
        let src = DocSource::borrowed(pdf.document());
        pdf.catalog()
            .ok()
            .and_then(|c| OcState::from_catalog(&src, c))
    } else {
        None
    };
    let hidden_ocgs: HashSet<ObjectId> = oc.as_ref().map(|s| s.hidden.clone()).unwrap_or_default();
    if !hidden_ocgs.is_empty() {
        // Annotations in hidden layers.
        let st = oc.clone().unwrap_or_default();
        let (n, _) = {
            let st2 = st.clone();
            filter_annots(pdf, &move |pdf, d| {
                let src = DocSource::borrowed(pdf.document());
                d.get(b"OC").is_ok_and(|x| st2.is_hidden(&src, x))
            })?
        };
        r.hidden_layers += n;
    }
    if !hidden_ocgs.is_empty() || o.hidden_text {
        let rep = rewrite_pages(pdf, oc.filter(|s| !s.hidden.is_empty()), o.hidden_text)?;
        r.hidden_text = rep.hidden_glyphs_removed;
        r.hidden_layers += rep.hidden_layer_items_removed;
        r.content = rep;
    }
    if !hidden_ocgs.is_empty() {
        remove_hidden_ocgs(pdf, &hidden_ocgs)?;
        r.hidden_layers += hidden_ocgs.len();
    }
    if o.bookmarks && catalog_remove(pdf, b"Outlines")? {
        r.bookmarks = 1;
        let root = pdf.root_id()?;
        if let Some(mut c) = pdf.get_dict(root).cloned() {
            if name_of(&c, b"PageMode") == Some(b"UseOutlines") {
                c.set("PageMode", Object::Name(b"UseNone".to_vec()));
                put_dict(pdf, root, c);
            }
        }
    }
    if o.thumbnails {
        r.thumbnails = strip_key_everywhere(pdf, b"Thumb");
    }
    if o.piece_info {
        r.piece_info = strip_key_everywhere(pdf, b"PieceInfo");
    }
    Ok(r)
}

/// Sanitize and write the whole file (single revision, orphans collected, protection kept).
pub fn sanitize_and_rewrite(
    pdf: &mut Pdf,
    o: &SanitizeOptions,
) -> Result<(Vec<u8>, SanitizeReport)> {
    let r = sanitize(pdf, o)?;
    let bytes = pdf.write_full(Protection::Keep)?;
    Ok((bytes, r))
}

/// Is any JavaScript action left (used by tests and the report)?
pub fn has_javascript(pdf: &Pdf) -> bool {
    pdf.objects().values().any(|o| match o {
        Object::Dictionary(d) => name_of(d, b"S") == Some(b"JavaScript") || d.has(b"JS"),
        _ => false,
    }) || is_js_action(pdf, &Object::Null)
}
