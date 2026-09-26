//! Link annotations: list, add, update and delete URI and go-to-page links.
//!
//! Every URI written goes through [`crate::url::check`]: `reject` verdicts are refused, `warn`
//! verdicts (look-alike hosts, credentials in the URL) need `confirm_host` equal to the displayed
//! host — the UI asks the person to type it.

use lopdf::{Dictionary, Object, ObjectId, StringFormat};
use serde::Serialize;
use warraq_pdf::{pages, Pdf};

use crate::error::{EditError, Result};
use crate::geom::Rect;
use crate::page::load;
use crate::url::{check, UrlCheck};

/// A link as listed (top-left page coordinates).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkInfo {
    pub id: usize,
    pub bbox: Rect,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    /// 0-based target page for go-to links.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check: Option<UrlCheck>,
}

/// Target of a link.
#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    Uri(String),
    Page(usize),
}

fn annots(pdf: &Pdf, page_id: ObjectId) -> Vec<Object> {
    let Some(d) = pdf.get_dict(page_id) else {
        return Vec::new();
    };
    match d.get(b"Annots").ok().and_then(|a| pdf.resolve(a)) {
        Some(Object::Array(a)) => a.iter().take(100_000).cloned().collect(),
        _ => Vec::new(),
    }
}

fn is_link(pdf: &Pdf, o: &Object) -> Option<Dictionary> {
    match pdf.resolve(o)? {
        Object::Dictionary(d) if matches!(d.get(b"Subtype"), Ok(Object::Name(n)) if n.as_slice() == b"Link") => {
            Some(d.clone())
        }
        _ => None,
    }
}

fn text_of(o: &Object) -> Option<String> {
    match o {
        Object::String(b, _) => Some(match std::str::from_utf8(b) {
            Ok(s) => s.to_string(),
            Err(_) => warraq_text::interp::decode_text_string(b),
        }),
        _ => None,
    }
}

fn num(pdf: &Pdf, o: &Object) -> Option<f64> {
    match pdf.resolve(o)? {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(f64::from(*r)),
        _ => None,
    }
}

/// Resolve a destination (array, or name/string via `/Dests` or the `/Names` tree) to a page index.
fn dest_page(pdf: &Pdf, dest: &Object, page_ids: &[ObjectId], depth: usize) -> Option<usize> {
    if depth > 8 {
        return None;
    }
    match pdf.resolve(dest)? {
        Object::Array(a) => match a.first()? {
            Object::Reference(id) => page_ids.iter().position(|p| p == id),
            Object::Integer(i) => usize::try_from(*i).ok(),
            _ => None,
        },
        Object::Dictionary(d) => dest_page(pdf, d.get(b"D").ok()?, page_ids, depth + 1),
        Object::Name(n) | Object::String(n, _) => {
            let cat = pdf.catalog().ok()?;
            if let Some(Object::Dictionary(dests)) =
                cat.get(b"Dests").ok().and_then(|o| pdf.resolve(o))
            {
                if let Ok(v) = dests.get(n) {
                    return dest_page(pdf, v, page_ids, depth + 1);
                }
            }
            let names = cat.get(b"Names").ok().and_then(|o| pdf.resolve(o))?;
            let Object::Dictionary(names) = names else {
                return None;
            };
            let tree = names.get(b"Dests").ok()?;
            let mut stack = vec![(tree.clone(), 0usize)];
            let mut steps = 0;
            while let Some((node, lvl)) = stack.pop() {
                steps += 1;
                if steps > 10_000 || lvl > 32 {
                    return None;
                }
                let Some(Object::Dictionary(nd)) = pdf.resolve(&node) else {
                    continue;
                };
                if let Ok(Object::Array(pairs)) = nd.get(b"Names") {
                    for pair in pairs.chunks(2) {
                        if let [Object::String(k, _), v] = pair {
                            if k == n {
                                return dest_page(pdf, v, page_ids, depth + 1);
                            }
                        }
                    }
                }
                if let Some(Object::Array(kids)) = nd.get(b"Kids").ok().and_then(|k| pdf.resolve(k))
                {
                    for k in kids.iter().take(10_000) {
                        stack.push((k.clone(), lvl + 1));
                    }
                }
            }
            None
        }
        _ => None,
    }
}

fn page_ids(pdf: &Pdf) -> Result<Vec<ObjectId>> {
    Ok(pages::flatten(pdf)?.into_iter().map(|p| p.id).collect())
}

/// List the links of page `index`.
pub fn list(pdf: &Pdf, index: usize) -> Result<Vec<LinkInfo>> {
    let pc = load(pdf, index)?;
    let ids = page_ids(pdf)?;
    let mut out = Vec::new();
    for o in annots(pdf, pc.page_id) {
        let Some(d) = is_link(pdf, &o) else { continue };
        let rect = match d.get(b"Rect").ok().and_then(|r| pdf.resolve(r)) {
            Some(Object::Array(a)) if a.len() == 4 => {
                let v: Vec<f64> = a.iter().filter_map(|x| num(pdf, x)).collect();
                match v.as_slice() {
                    [a, b, c, e] => Rect::new(*a, *b, *c, *e),
                    _ => continue,
                }
            }
            _ => continue,
        };
        let mut uri = None;
        let mut page = None;
        if let Some(Object::Dictionary(a)) = d.get(b"A").ok().and_then(|a| pdf.resolve(a)) {
            match a.get(b"S") {
                Ok(Object::Name(s)) if s.as_slice() == b"URI" => {
                    uri = a
                        .get(b"URI")
                        .ok()
                        .and_then(|u| pdf.resolve(u))
                        .and_then(text_of);
                }
                Ok(Object::Name(s)) if s.as_slice() == b"GoTo" => {
                    page = a.get(b"D").ok().and_then(|x| dest_page(pdf, x, &ids, 0));
                }
                _ => {}
            }
        } else if let Ok(dest) = d.get(b"Dest") {
            page = dest_page(pdf, dest, &ids, 0);
        }
        out.push(LinkInfo {
            id: out.len(),
            bbox: pc.space.rect_to_tl(&rect).rounded(),
            check: uri.as_deref().map(check),
            uri,
            page,
        });
    }
    Ok(out)
}

fn validate(pdf: &Pdf, target: &Target, confirm_host: Option<&str>) -> Result<Object> {
    match target {
        Target::Uri(u) => {
            let c = check(u);
            match c.verdict {
                "reject" => Err(EditError::UrlRefused(c.problems.join(","))),
                "warn" if confirm_host.map(|h| h.trim().to_lowercase()) != Some(c.host.clone()) => {
                    Err(EditError::UrlRefused(format!(
                        "confirm_host:{}",
                        c.problems.join(",")
                    )))
                }
                _ => {
                    let mut a = Dictionary::new();
                    a.set("S", Object::Name(b"URI".to_vec()));
                    a.set(
                        "URI",
                        Object::String(c.url.into_bytes(), StringFormat::Literal),
                    );
                    Ok(Object::Dictionary(a))
                }
            }
        }
        Target::Page(p) => {
            let ids = page_ids(pdf)?;
            let id = ids.get(*p).ok_or(EditError::PageOutOfRange(*p))?;
            let mut a = Dictionary::new();
            a.set("S", Object::Name(b"GoTo".to_vec()));
            a.set(
                "D",
                Object::Array(vec![
                    Object::Reference(*id),
                    Object::Name(b"XYZ".to_vec()),
                    Object::Null,
                    Object::Null,
                    Object::Null,
                ]),
            );
            Ok(Object::Dictionary(a))
        }
    }
}

fn rect_obj(r: &Rect) -> Object {
    Object::Array(
        r.to_array()
            .iter()
            .map(|v| Object::Real(*v as f32))
            .collect(),
    )
}

fn set_annots(pdf: &mut Pdf, page_id: ObjectId, list: Vec<Object>) -> Result<()> {
    let mut d = pdf
        .get_dict(page_id)
        .cloned()
        .ok_or_else(|| EditError::NotFound("page".into()))?;
    // Annots held in a separate array object: update that object (it belongs to this page).
    if let Ok(Object::Reference(aid)) = d.get(b"Annots") {
        let aid = *aid;
        if matches!(pdf.get(aid), Some(Object::Array(_))) {
            pdf.set(aid, Object::Array(list));
            return Ok(());
        }
    }
    d.set("Annots", Object::Array(list));
    pdf.set(page_id, Object::Dictionary(d));
    Ok(())
}

/// Position of link `id` in the page's `/Annots`.
fn slot(pdf: &Pdf, page_id: ObjectId, id: usize) -> Result<(Vec<Object>, usize)> {
    let all = annots(pdf, page_id);
    let pos = all
        .iter()
        .enumerate()
        .filter(|(_, o)| is_link(pdf, o).is_some())
        .nth(id)
        .map(|(i, _)| i)
        .ok_or_else(|| EditError::NotFound(format!("link {id}")))?;
    Ok((all, pos))
}

/// Add a link over `bbox` (top-left coordinates).
pub fn add(
    pdf: &mut Pdf,
    index: usize,
    bbox: Rect,
    target: &Target,
    confirm_host: Option<&str>,
) -> Result<()> {
    let pc = load(pdf, index)?;
    if !bbox.is_finite() || bbox.width() < 1.0 || bbox.height() < 1.0 {
        return Err(EditError::Params("link box too small".into()));
    }
    let action = validate(pdf, target, confirm_host)?;
    let mut d = Dictionary::new();
    d.set("Type", Object::Name(b"Annot".to_vec()));
    d.set("Subtype", Object::Name(b"Link".to_vec()));
    d.set("Rect", rect_obj(&pc.space.rect_to_user(&bbox)));
    d.set("Border", Object::Array(vec![0.into(), 0.into(), 0.into()]));
    d.set("F", 4);
    d.set("P", Object::Reference(pc.page_id));
    d.set("A", action);
    let id = pdf.add(Object::Dictionary(d));
    let mut all = annots(pdf, pc.page_id);
    all.push(Object::Reference(id));
    set_annots(pdf, pc.page_id, all)
}

/// Change link `id`: its box and/or target.
pub fn update(
    pdf: &mut Pdf,
    index: usize,
    id: usize,
    bbox: Option<Rect>,
    target: Option<&Target>,
    confirm_host: Option<&str>,
) -> Result<()> {
    let pc = load(pdf, index)?;
    let (mut all, pos) = slot(pdf, pc.page_id, id)?;
    let obj = all
        .get(pos)
        .cloned()
        .ok_or_else(|| EditError::NotFound(format!("link {id}")))?;
    let mut d = is_link(pdf, &obj).ok_or_else(|| EditError::NotFound(format!("link {id}")))?;
    if let Some(b) = bbox {
        if !b.is_finite() || b.width() < 1.0 || b.height() < 1.0 {
            return Err(EditError::Params("link box too small".into()));
        }
        d.set("Rect", rect_obj(&pc.space.rect_to_user(&b)));
    }
    if let Some(t) = target {
        let a = validate(pdf, t, confirm_host)?;
        d.remove(b"Dest");
        d.set("A", a);
    }
    match obj {
        Object::Reference(oid) => pdf.set(oid, Object::Dictionary(d)),
        _ => {
            if let Some(slot) = all.get_mut(pos) {
                *slot = Object::Dictionary(d);
            }
            set_annots(pdf, pc.page_id, all)?;
        }
    }
    Ok(())
}

/// Delete link `id`.
pub fn delete(pdf: &mut Pdf, index: usize, id: usize) -> Result<()> {
    let pc = load(pdf, index)?;
    let (mut all, pos) = slot(pdf, pc.page_id, id)?;
    let removed = all.remove(pos);
    set_annots(pdf, pc.page_id, all)?;
    if let Object::Reference(oid) = removed {
        pdf.delete(oid);
    }
    Ok(())
}
