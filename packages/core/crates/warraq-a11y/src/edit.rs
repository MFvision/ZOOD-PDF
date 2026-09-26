//! Changes to an existing structure tree: reading order, element types, alt text, language,
//! decorative (→ artifact), merging and splitting paragraphs, document title and language.
//! Every function records changes on the [`Pdf`] (elements rewritten, `/ParentTree` rebuilt);
//! the caller commits one incremental update.

use std::collections::{HashMap, HashSet};

use lopdf::{Object, ObjectId, StringFormat};
use warraq_edit::page::{load, resources, write};
use warraq_pdf::{pages, Pdf};

use crate::autotag::{set_display_doc_title, set_title as write_title};
use crate::error::{A11yError, Result};
use crate::lang;
use crate::marked::{analyze, named_props};
use crate::rewrite::to_artifact;
use crate::tree::{Kid, Tree};

/// Types the UI may assign.
pub const ASSIGNABLE: &[&str] = &[
    "P",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "L",
    "LI",
    "Lbl",
    "LBody",
    "Table",
    "TR",
    "TH",
    "TD",
    "Figure",
    "Formula",
    "Caption",
    "Span",
    "Quote",
    "BlockQuote",
    "Note",
    "Code",
    "Div",
    "Sect",
    "Art",
    "Part",
    "TOC",
    "TOCI",
    "Link",
    "Artifact",
];

/// Maximum alt text length (characters).
pub const MAX_ALT: usize = 10_000;

fn open(pdf: &Pdf) -> Result<Tree> {
    let t = Tree::read(pdf);
    if !t.exists() {
        return Err(A11yError::NotTagged);
    }
    if t.truncated {
        return Err(A11yError::Limit(
            "the structure tree is too large or too deep to be edited".into(),
        ));
    }
    Ok(t)
}

fn find(t: &Tree, id: u32) -> Result<usize> {
    t.by_num(id)
        .ok_or_else(|| A11yError::NotFound(format!("structure element {id}")))
}

fn modify(pdf: &Pdf) -> Result<()> {
    pdf.require("changing the document's tags", |p| p.modify)?;
    Ok(())
}

/// Move element `id` to position `index` among its sibling elements.
pub fn move_to(pdf: &mut Pdf, id: u32, index: usize) -> Result<()> {
    modify(pdf)?;
    let mut t = open(pdf)?;
    let i = find(&t, id)?;
    let parent = t.elems.get(i).and_then(|e| e.parent);
    match parent {
        Some(p) => {
            let Some(pe) = t.elems.get_mut(p) else {
                return Err(A11yError::NotFound("parent".into()));
            };
            let Some(from) = pe.kids.iter().position(|k| *k == Kid::Elem(i)) else {
                return Err(A11yError::NotFound("element in its parent".into()));
            };
            let kid = pe.kids.remove(from);
            // Position among element kids → position in the full kid list.
            let elem_positions: Vec<usize> = pe
                .kids
                .iter()
                .enumerate()
                .filter(|(_, k)| matches!(k, Kid::Elem(_)))
                .map(|(j, _)| j)
                .collect();
            let at = elem_positions.get(index).copied().unwrap_or(pe.kids.len());
            pe.kids.insert(at, kid);
            pe.dirty = true;
        }
        None => {
            let Some(from) = t.top.iter().position(|x| *x == i) else {
                return Err(A11yError::NotFound("element".into()));
            };
            t.top.remove(from);
            let at = index.min(t.top.len());
            t.top.insert(at, i);
            t.root_dirty = true;
        }
    }
    t.write(pdf)
}

/// Change the structure type of element `id` (`Artifact` makes it decorative).
pub fn set_type(pdf: &mut Pdf, id: u32, ty: &str) -> Result<()> {
    if !ASSIGNABLE.contains(&ty) {
        return Err(A11yError::Params(format!("unknown structure type {ty:?}")));
    }
    if ty == "Artifact" {
        return decorative(pdf, id);
    }
    modify(pdf)?;
    let mut t = open(pdf)?;
    let i = find(&t, id)?;
    if let Some(e) = t.elems.get_mut(i) {
        e.s = ty.to_string();
        if ty == "TH" && !e.dict.has(b"A") {
            let mut a = lopdf::Dictionary::new();
            a.set("O", Object::Name(b"Table".to_vec()));
            a.set("Scope", Object::Name(b"Column".to_vec()));
            e.dict.set("A", Object::Dictionary(a));
        }
        e.dirty = true;
    }
    t.write(pdf)
}

/// Set (or clear with an empty string) the alternate text of element `id`, optionally with the
/// language it is written in.
pub fn set_alt(pdf: &mut Pdf, id: u32, alt: &str, alt_lang: Option<&str>) -> Result<()> {
    modify(pdf)?;
    if alt.chars().count() > MAX_ALT {
        return Err(A11yError::Params("alternate text too long".into()));
    }
    if alt.chars().any(|c| c.is_control() && c != '\n') {
        return Err(A11yError::Params(
            "control characters in alternate text".into(),
        ));
    }
    if let Some(l) = alt_lang {
        if !lang::valid_tag(l) {
            return Err(A11yError::Params(format!("bad language tag {l:?}")));
        }
    }
    let mut t = open(pdf)?;
    let i = find(&t, id)?;
    if let Some(e) = t.elems.get_mut(i) {
        let a = alt.trim();
        e.alt = (!a.is_empty()).then(|| a.to_string());
        if let Some(l) = alt_lang {
            e.lang = Some(l.to_string());
        }
        e.dirty = true;
    }
    t.write(pdf)
}

/// Set (Some) or remove (None) the `/Lang` of element `id`.
pub fn set_lang(pdf: &mut Pdf, id: u32, l: Option<&str>) -> Result<()> {
    modify(pdf)?;
    if let Some(l) = l {
        if !lang::valid_tag(l) {
            return Err(A11yError::Params(format!("bad language tag {l:?}")));
        }
    }
    let mut t = open(pdf)?;
    let i = find(&t, id)?;
    if let Some(e) = t.elems.get_mut(i) {
        e.lang = l.map(str::to_string);
        e.dirty = true;
    }
    t.write(pdf)
}

/// MCIDs of an element's subtree per page (page content only).
fn subtree_mcids(t: &Tree, i: usize) -> Result<(HashMap<ObjectId, HashSet<i64>>, bool)> {
    let mut out: HashMap<ObjectId, HashSet<i64>> = HashMap::new();
    let mut annots = false;
    let mut stack = vec![i];
    let mut seen = HashSet::new();
    while let Some(x) = stack.pop() {
        if !seen.insert(x) || seen.len() > crate::tree::MAX_ELEMS {
            continue;
        }
        let Some(e) = t.elems.get(x) else { continue };
        for k in &e.kids {
            match k {
                Kid::Mcr { mcid, page, stm } => {
                    if stm.is_some() {
                        return Err(A11yError::NotPossible(
                            "the element's content is inside a form XObject".into(),
                        ));
                    }
                    if let Some(p) = page.or(e.page) {
                        out.entry(p).or_default().insert(*mcid);
                    }
                }
                Kid::Objr { .. } => annots = true,
                Kid::Elem(c) => stack.push(*c),
                Kid::Other(_) => {}
            }
        }
    }
    Ok((out, annots))
}

/// Make element `id` decorative: its content becomes `/Artifact` and it leaves the tree.
pub fn decorative(pdf: &mut Pdf, id: u32) -> Result<()> {
    modify(pdf)?;
    let mut t = open(pdf)?;
    let i = find(&t, id)?;
    let (by_page, annots) = subtree_mcids(&t, i)?;
    if annots {
        return Err(A11yError::NotPossible(
            "annotations cannot be marked decorative".into(),
        ));
    }
    let list = pages::flatten(pdf)?;
    for (index, p) in list.iter().enumerate() {
        let Some(set) = by_page.get(&p.id) else {
            continue;
        };
        let pc = load(pdf, index)?;
        let c = warraq_edit::content::parse(&pc.data)?;
        let res = resources(pdf, pc.page_id);
        let splices = {
            let named = named_props(pdf, &res);
            let m = analyze(&c, &named);
            to_artifact(&c, &m, set)
        };
        if !splices.is_empty() {
            write(pdf, &pc, &splices, None)?;
        }
    }
    t.remove(i);
    t.write(pdf)
}

/// Merge element `id` with its next sibling element (the sibling's kids move into it).
pub fn merge_next(pdf: &mut Pdf, id: u32) -> Result<()> {
    modify(pdf)?;
    let mut t = open(pdf)?;
    let i = find(&t, id)?;
    let sib = t.siblings(i);
    let pos = sib.iter().position(|x| *x == i).unwrap_or(usize::MAX);
    let Some(&j) = sib.get(pos.wrapping_add(1)) else {
        return Err(A11yError::NotPossible(
            "there is no next element to merge with".into(),
        ));
    };
    let a_page = t.elems.get(i).and_then(|e| e.page);
    let (b_page, b_kids) = match t.elems.get(j) {
        Some(b) => (b.page, b.kids.clone()),
        None => return Err(A11yError::NotFound("next element".into())),
    };
    // B's MCIDs name their page explicitly when it is not A's.
    let moved: Vec<Kid> = b_kids
        .into_iter()
        .map(|k| match k {
            Kid::Mcr { mcid, page, stm } => {
                let eff = page.or(b_page);
                Kid::Mcr {
                    mcid,
                    page: if eff == a_page { None } else { eff },
                    stm,
                }
            }
            other => other,
        })
        .collect();
    for k in &moved {
        if let Kid::Elem(c) = k {
            if let Some(ce) = t.elems.get_mut(*c) {
                ce.parent = Some(i);
                ce.dirty = true;
            }
        }
    }
    if let Some(a) = t.elems.get_mut(i) {
        a.kids.extend(moved);
        a.dirty = true;
    }
    // Detach B.
    let parent = t.elems.get(j).and_then(|e| e.parent);
    match parent {
        Some(p) => {
            if let Some(pe) = t.elems.get_mut(p) {
                pe.kids.retain(|k| *k != Kid::Elem(j));
                pe.dirty = true;
            }
        }
        None => {
            t.top.retain(|x| *x != j);
            t.root_dirty = true;
        }
    }
    if let Some(b) = t.elems.get_mut(j) {
        b.kids.clear();
        b.removed = true;
    }
    t.write(pdf)
}

/// Split element `id` into two siblings of the same type before kid `at` (default: at the middle
/// marked-content boundary). Returns the new element's object number.
pub fn split(pdf: &mut Pdf, id: u32, at: Option<usize>) -> Result<u32> {
    modify(pdf)?;
    let mut t = open(pdf)?;
    let i = find(&t, id)?;
    let (kids, s, lang, page, parent) = match t.elems.get(i) {
        Some(e) => (
            e.kids.clone(),
            e.s.clone(),
            e.lang.clone(),
            e.page,
            e.parent,
        ),
        None => return Err(A11yError::NotFound("element".into())),
    };
    let content: Vec<usize> = kids
        .iter()
        .enumerate()
        .filter(|(_, k)| matches!(k, Kid::Mcr { .. } | Kid::Elem(_)))
        .map(|(j, _)| j)
        .collect();
    if content.len() < 2 {
        return Err(A11yError::NotPossible(
            "the element has only one piece of content; it cannot be split".into(),
        ));
    }
    let cut = match at {
        Some(a) if a > 0 && a < kids.len() => a,
        Some(_) => return Err(A11yError::Params("split position out of range".into())),
        None => content.get(content.len() / 2).copied().unwrap_or(1),
    };
    let tail: Vec<Kid> = kids.get(cut..).map(<[Kid]>::to_vec).unwrap_or_default();
    let head: Vec<Kid> = kids.get(..cut).map(<[Kid]>::to_vec).unwrap_or_default();
    let mut ne = crate::tree::Elem::new(&s, parent, page);
    ne.lang = lang;
    ne.kids = tail.clone();
    t.elems.push(ne);
    let ni = t.elems.len() - 1;
    for k in &tail {
        if let Kid::Elem(c) = k {
            if let Some(ce) = t.elems.get_mut(*c) {
                ce.parent = Some(ni);
                ce.dirty = true;
            }
        }
    }
    if let Some(a) = t.elems.get_mut(i) {
        a.kids = head;
        a.dirty = true;
    }
    // Insert after the original.
    match parent {
        Some(p) => {
            if let Some(pe) = t.elems.get_mut(p) {
                let pos = pe
                    .kids
                    .iter()
                    .position(|k| *k == Kid::Elem(i))
                    .map_or(pe.kids.len(), |x| x + 1);
                pe.kids.insert(pos, Kid::Elem(ni));
                pe.dirty = true;
            }
        }
        None => {
            let pos = t
                .top
                .iter()
                .position(|x| *x == i)
                .map_or(t.top.len(), |x| x + 1);
            t.top.insert(pos, ni);
            t.root_dirty = true;
        }
    }
    t.write(pdf)?;
    t.elems
        .get(ni)
        .and_then(|e| e.id)
        .map(|(n, _)| n)
        .ok_or_else(|| A11yError::NotFound("new element".into()))
}

/// Set the document title (Info, XMP) and show it in the window title.
pub fn set_title(pdf: &mut Pdf, title: &str) -> Result<()> {
    modify(pdf)?;
    let t = title.trim();
    if t.is_empty() {
        return Err(A11yError::Params("the title is empty".into()));
    }
    if t.chars().any(char::is_control) {
        return Err(A11yError::Params("control characters in the title".into()));
    }
    write_title(pdf, t)?;
    set_display_doc_title(pdf)
}

/// Set the document language (catalog `/Lang`).
pub fn set_doc_lang(pdf: &mut Pdf, l: &str) -> Result<()> {
    modify(pdf)?;
    if !lang::valid_tag(l) {
        return Err(A11yError::Params(format!("bad language tag {l:?}")));
    }
    let id = pdf.root_id()?;
    let mut cat = pdf.catalog()?.clone();
    cat.set(
        "Lang",
        Object::String(l.as_bytes().to_vec(), StringFormat::Literal),
    );
    pdf.set(id, Object::Dictionary(cat));
    Ok(())
}
