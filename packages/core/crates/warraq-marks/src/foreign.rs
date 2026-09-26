//! Page marks made by other applications: `/Artifact` marked content with a pagination
//! `/Subtype` (`/Watermark`, `/Header`, `/Footer`, or `/Type /Pagination`) and form XObjects
//! tagged the Acrobat way (`/PieceInfo << /ADBE_CompoundType << /Private /Watermark >> >>`),
//! found in the page content (not inside other forms).
//!
//! A region is **removable** only when taking it out cannot change how the rest of the page is
//! drawn: every operator directly inside it (outside nested `q … Q`) leaves the graphics state
//! alone (`q`, `Q`, `Do`, marked content), or the whole region is enclosed by its own `q … Q`
//! pair (which is removed with it); and it lies within one content stream. Removal goes through
//! warraq-edit's byte-faithful rewriter: only the affected streams are replaced, every other
//! byte stays as it was.

use std::collections::BTreeMap;
use std::ops::Range;

use lopdf::Object;
use serde::Serialize;
use warraq_edit::content::{parse, Op, Splice, Value};
use warraq_edit::page::{self, PageContent};
use warraq_pdf::Pdf;

use crate::error::Result;
use crate::store::{classify, Item};

/// Kind of a foreign mark.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ForeignKind {
    Watermark,
    Header,
    Footer,
    /// `/Type /Pagination` without one of the above subtypes (page numbers, Bates, …).
    Pagination,
}

impl ForeignKind {
    pub fn parse(s: &str) -> Option<ForeignKind> {
        match s {
            "watermark" => Some(ForeignKind::Watermark),
            "header" => Some(ForeignKind::Header),
            "footer" => Some(ForeignKind::Footer),
            "pagination" => Some(ForeignKind::Pagination),
            _ => None,
        }
    }

    fn from_subtype(n: &[u8]) -> Option<ForeignKind> {
        match n {
            b"Watermark" => Some(ForeignKind::Watermark),
            b"Header" => Some(ForeignKind::Header),
            b"Footer" => Some(ForeignKind::Footer),
            _ => None,
        }
    }
}

/// A foreign mark region in a page's (joined) content.
#[derive(Debug, Clone, PartialEq)]
pub struct Region {
    pub kind: ForeignKind,
    pub range: Range<usize>,
    pub removable: bool,
    /// Found through Acrobat's `/ADBE_CompoundType` (else a tagged artifact).
    pub acrobat: bool,
}

/// Summary per kind for `marks.list`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForeignMark {
    pub id: String,
    pub kind: ForeignKind,
    pub pages: Vec<usize>,
    pub regions: usize,
    /// Every region can be removed safely.
    pub removable: bool,
    pub acrobat: bool,
}

fn name(v: Option<&Value>) -> Option<&[u8]> {
    v.and_then(Value::name)
}

/// Resolve a BDC property operand (inline dictionary or `/Properties` resource name) to
/// `(Type, Subtype, ours)`.
fn props(pdf: &Pdf, res: &lopdf::Dictionary, v: &Value) -> (Vec<u8>, Vec<u8>, bool) {
    match v {
        Value::Dict(_) => (
            name(v.get(b"Type")).unwrap_or_default().to_vec(),
            name(v.get(b"Subtype")).unwrap_or_default().to_vec(),
            v.get(crate::store::KEY).is_some(),
        ),
        Value::Name(n) => match page::resource(pdf, res, b"Properties", n) {
            Some((_, Object::Dictionary(d))) => {
                let get = |k: &[u8]| match d.get(k).ok().and_then(|o| pdf.resolve(o)) {
                    Some(Object::Name(n)) => n.clone(),
                    _ => Vec::new(),
                };
                (get(b"Type"), get(b"Subtype"), d.has(crate::store::KEY))
            }
            _ => (Vec::new(), Vec::new(), false),
        },
        _ => (Vec::new(), Vec::new(), false),
    }
}

/// The Acrobat compound type of the XObject `n` (`/PieceInfo /ADBE_CompoundType /Private`).
fn acrobat_kind(pdf: &Pdf, res: &lopdf::Dictionary, n: &[u8]) -> Option<ForeignKind> {
    let (_, obj) = page::resource(pdf, res, b"XObject", n)?;
    let Object::Stream(s) = obj else { return None };
    if s.dict.has(crate::store::KEY) {
        return None;
    }
    let pi = pdf
        .resolve(s.dict.get(b"PieceInfo").ok()?)?
        .as_dict()
        .ok()?;
    let ct = pdf
        .resolve(pi.get(b"ADBE_CompoundType").ok()?)?
        .as_dict()
        .ok()?;
    match pdf.resolve(ct.get(b"Private").ok()?)? {
        Object::Name(p) => ForeignKind::from_subtype(p),
        _ => None,
    }
}

fn changes_state(op: &Op) -> bool {
    !matches!(
        op.operator.as_slice(),
        b"q" | b"Q" | b"Do" | b"BMC" | b"BDC" | b"EMC" | b"MP" | b"DP"
    )
}

/// Can ops `a..=b` (indices; the BDC and its EMC) be removed without changing the rest of the
/// page? Returns the byte range to remove.
fn removable_range(ops: &[Op], a: usize, b: usize) -> Option<Range<usize>> {
    let (first, last) = (ops.get(a)?, ops.get(b)?);
    let mut depth = 0i64;
    let mut clean = true;
    for op in ops.get(a + 1..b)? {
        match op.operator.as_slice() {
            b"q" => depth += 1,
            b"Q" => {
                depth -= 1;
                if depth < 0 {
                    return None;
                }
            }
            _ if depth == 0 && changes_state(op) => clean = false,
            _ => {}
        }
    }
    if depth != 0 {
        return None;
    }
    if clean {
        return Some(first.span.start..last.span.end);
    }
    // Enclosed by its own q … Q.
    let before = a.checked_sub(1).and_then(|i| ops.get(i))?;
    let after = ops.get(b + 1)?;
    (before.is(b"q") && after.is(b"Q")).then_some(before.span.start..after.span.end)
}

fn within_one_segment(pc: &PageContent, r: &Range<usize>) -> bool {
    pc.segments
        .iter()
        .any(|s| s.range.start <= r.start && r.end <= s.range.end)
}

/// Bytes of the page's content that belong to our own mark streams (never scanned).
fn ours(pdf: &Pdf, pc: &PageContent) -> Vec<Range<usize>> {
    pc.segments
        .iter()
        .filter(|s| {
            s.stream
                .is_some_and(|id| !matches!(classify(pdf, &Object::Reference(id)), Item::Original))
        })
        .map(|s| s.range.clone())
        .collect()
}

/// Foreign mark regions of page `index`.
pub fn scan(pdf: &Pdf, index: usize) -> Result<(PageContent, Vec<Region>)> {
    let pc = page::load(pdf, index)?;
    let c = parse(&pc.data)?;
    let res = page::resources(pdf, pc.page_id);
    let skip = ours(pdf, &pc);
    let in_ours = |op: &Op| skip.iter().any(|r| r.contains(&op.span.start));
    let mut out: Vec<Region> = Vec::new();
    // Stack of open marked content: (op index, foreign kind if it is a pagination artifact).
    let mut stack: Vec<(usize, Option<ForeignKind>)> = Vec::new();
    for (i, op) in c.ops.iter().enumerate() {
        match op.operator.as_slice() {
            b"BMC" => stack.push((i, None)),
            b"BDC" => {
                let tag = op.operands.first().and_then(|o| o.value.name());
                let kind = if tag == Some(b"Artifact".as_slice()) && !in_ours(op) {
                    let (ty, sub, mine) = op
                        .operands
                        .get(1)
                        .map(|o| props(pdf, &res, &o.value))
                        .unwrap_or_default();
                    if mine {
                        None
                    } else {
                        ForeignKind::from_subtype(&sub)
                            .or((ty.as_slice() == b"Pagination").then_some(ForeignKind::Pagination))
                    }
                } else {
                    None
                };
                stack.push((i, kind));
                if stack.len() > 256 {
                    break;
                }
            }
            b"EMC" => {
                if let Some((start, Some(kind))) = stack.pop() {
                    // Only the outermost foreign region counts.
                    if stack.iter().any(|(_, k)| k.is_some()) {
                        continue;
                    }
                    let whole = c.ops.get(start).map_or(0, |o| o.span.start)..op.span.end;
                    let (range, removable) = match removable_range(&c.ops, start, i) {
                        Some(r) if within_one_segment(&pc, &r) => (r, true),
                        _ => (whole, false),
                    };
                    out.retain(|r| !(range.start <= r.range.start && r.range.end <= range.end));
                    out.push(Region {
                        kind,
                        range,
                        removable,
                        acrobat: false,
                    });
                }
            }
            b"Do" if !in_ours(op) && !stack.iter().any(|(_, k)| k.is_some()) => {
                let Some(n) = op.operands.first().and_then(|o| o.value.name()) else {
                    continue;
                };
                if let Some(kind) = acrobat_kind(pdf, &res, n) {
                    // The Do (with its own q … Q around it when there is one: Acrobat writes
                    // `q … cm /Fm0 Do Q`).
                    let mut range = op.span.clone();
                    let mut removable = true;
                    // Walk back to an enclosing q whose Q follows the Do.
                    if let Some(qi) = c
                        .ops
                        .get(..i)
                        .and_then(|b| b.iter().rposition(|o| o.is(b"q")))
                    {
                        let between_ok = c.ops.get(qi + 1..i).is_some_and(|b| {
                            b.iter().all(|o| !o.is(b"q") && !o.is(b"Q") && !o.is(b"BT"))
                        });
                        if between_ok && c.ops.get(i + 1).is_some_and(|o| o.is(b"Q")) {
                            if let (Some(a), Some(z)) = (c.ops.get(qi), c.ops.get(i + 1)) {
                                range = a.span.start..z.span.end;
                            }
                        }
                    }
                    if !within_one_segment(&pc, &range) {
                        removable = false;
                    }
                    out.push(Region {
                        kind,
                        range,
                        removable,
                        acrobat: true,
                    });
                }
            }
            _ => {}
        }
    }
    // Artifact regions that draw an Acrobat form are Acrobat's.
    for r in &mut out {
        if !r.acrobat {
            let slice = pc.data.get(r.range.clone()).unwrap_or(&[]);
            if let Ok(inner) = parse(slice) {
                r.acrobat = inner.ops.iter().any(|o| {
                    o.is(b"Do")
                        && o.operands
                            .first()
                            .and_then(|x| x.value.name())
                            .is_some_and(|n| acrobat_kind(pdf, &res, n).is_some())
                });
            }
        }
    }
    Ok((pc, out))
}

/// Every foreign mark, grouped by kind.
pub fn list(pdf: &Pdf) -> Result<Vec<ForeignMark>> {
    let n = page::page_count(pdf)?;
    let mut by: BTreeMap<ForeignKind, ForeignMark> = BTreeMap::new();
    for i in 0..n {
        let Ok((_, regions)) = scan(pdf, i) else {
            continue;
        };
        for r in regions {
            let e = by.entry(r.kind).or_insert_with(|| ForeignMark {
                id: format!(
                    "foreign:{}",
                    serde_json::to_value(r.kind)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_string))
                        .unwrap_or_default()
                ),
                kind: r.kind,
                pages: Vec::new(),
                regions: 0,
                removable: true,
                acrobat: false,
            });
            if e.pages.last() != Some(&i) {
                e.pages.push(i);
            }
            e.regions += 1;
            e.removable &= r.removable;
            e.acrobat |= r.acrobat;
        }
    }
    Ok(by.into_values().collect())
}

/// Remove every removable region of `kind`. Returns (removed, left because unsafe).
pub fn remove(pdf: &mut Pdf, kind: ForeignKind) -> Result<(usize, usize)> {
    let n = page::page_count(pdf)?;
    let (mut removed, mut left) = (0, 0);
    for i in 0..n {
        let (pc, regions) = scan(pdf, i)?;
        let splices: Vec<Splice> = regions
            .iter()
            .filter(|r| r.kind == kind)
            .filter_map(|r| {
                if r.removable {
                    removed += 1;
                    Some(Splice {
                        range: r.range.clone(),
                        with: Vec::new(),
                    })
                } else {
                    left += 1;
                    None
                }
            })
            .collect();
        if !splices.is_empty() {
            page::write(pdf, &pc, &splices, None)?;
        }
    }
    Ok((removed, left))
}
