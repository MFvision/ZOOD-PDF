//! Document comparison.
//!
//! * **Text**: both documents are extracted in logical order (warraq-text), split into words and
//!   compared word by word. Keys are optionally normalised the Arabic way (tashkeel/tatweel
//!   dropped; optionally alef/yaa/taa-marbuta/digit forms unified). The diff is patience-style —
//!   words unique to both sides anchor the alignment (longest increasing subsequence) — with a
//!   bounded Myers O(ND) diff between anchors; beyond the bound a gap is reported as one
//!   replacement, so time and memory stay bounded on hostile or unrelated documents. Whitespace is
//!   never significant (the comparison is word-level).
//! * **Visual**: two RGBA rasters are compared pixel by pixel with a threshold; the result is an
//!   overlay PNG (page A faded, changed pixels red) and bounding boxes of the changed regions.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use warraq_text::geom::Rect;
use warraq_text::normalize::{is_tashkeel_or_tatweel, normalize_for_search};
use warraq_text::PageText;

use crate::error::{OfficeError, Result};
use crate::png;

/// Maximum words compared per document.
pub const MAX_WORDS: usize = 500_000;
/// Maximum edit distance explored by one Myers run.
const MAX_D: usize = 1_000;
/// Maximum recursion depth of the anchor refinement.
const MAX_DEPTH: usize = 48;
/// Maximum changes reported.
pub const MAX_CHANGES: usize = 20_000;

/// Normalisation options.
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TextOptions {
    /// Drop tashkeel (harakat) and tatweel before comparing.
    pub ignore_diacritics: bool,
    /// Unify alef/yaa/taa-marbuta/hamza forms and digits (search normalisation).
    pub normalize_letters: bool,
    pub ignore_case: bool,
}

impl Default for TextOptions {
    fn default() -> Self {
        TextOptions {
            ignore_diacritics: true,
            normalize_letters: false,
            ignore_case: false,
        }
    }
}

/// A rectangle on a page (0-based page index, points, top-left origin).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PageRect {
    pub page: usize,
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Inserted,
    Deleted,
    Changed,
}

/// One change between document A (old) and B (new).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub kind: ChangeKind,
    /// Old text (A), empty for insertions.
    pub old: String,
    /// New text (B), empty for deletions.
    pub new: String,
    /// Page in A where the change is (or where the insertion goes).
    pub page_a: usize,
    /// Page in B.
    pub page_b: usize,
    pub rects_a: Vec<PageRect>,
    pub rects_b: Vec<PageRect>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub inserted: usize,
    pub deleted: usize,
    pub changed: usize,
    pub words_a: usize,
    pub words_b: usize,
    pub pages_a: usize,
    pub pages_b: usize,
    /// More changes existed than [`MAX_CHANGES`].
    pub truncated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TextDiff {
    pub summary: Summary,
    pub changes: Vec<Change>,
}

struct Tok<'a> {
    text: &'a str,
    page: usize,
    bbox: Rect,
}

fn key(s: &str, o: &TextOptions) -> String {
    let mut k = if o.normalize_letters {
        normalize_for_search(s).0
    } else if o.ignore_diacritics {
        s.chars().filter(|c| !is_tashkeel_or_tatweel(*c)).collect()
    } else {
        s.to_string()
    };
    if o.ignore_case {
        k = k.to_lowercase();
    }
    k
}

fn tokens(pages: &[PageText]) -> Vec<Tok<'_>> {
    let mut out = Vec::new();
    for p in pages {
        for para in p.paragraphs() {
            for l in &para.lines {
                for w in &l.words {
                    if out.len() >= MAX_WORDS {
                        return out;
                    }
                    if !w.text.trim().is_empty() {
                        out.push(Tok {
                            text: &w.text,
                            page: p.page,
                            bbox: w.bbox,
                        });
                    }
                }
            }
        }
    }
    out
}

/// An edit operation on index ranges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Equal { a: usize, b: usize, len: usize },
    Delete { a: usize, len: usize },
    Insert { b: usize, len: usize },
}

/// Word-level diff of two id sequences (bounded; see module docs).
pub fn diff_ids(a: &[u32], b: &[u32]) -> Vec<Op> {
    let mut out = Vec::new();
    rec(a, b, 0, 0, 0, &mut out);
    // Merge adjacent ops of the same kind.
    let mut merged: Vec<Op> = Vec::with_capacity(out.len());
    for op in out {
        match (merged.last_mut(), op) {
            (
                Some(Op::Equal { a, b, len }),
                Op::Equal {
                    a: a2,
                    b: b2,
                    len: l2,
                },
            ) if *a + *len == a2 && *b + *len == b2 => *len += l2,
            (Some(Op::Delete { a, len }), Op::Delete { a: a2, len: l2 }) if *a + *len == a2 => {
                *len += l2
            }
            (Some(Op::Insert { b, len }), Op::Insert { b: b2, len: l2 }) if *b + *len == b2 => {
                *len += l2
            }
            _ => merged.push(op),
        }
    }
    merged
}

fn rec(a: &[u32], b: &[u32], ao: usize, bo: usize, depth: usize, out: &mut Vec<Op>) {
    // Common prefix / suffix.
    let pre = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let (a1, b1) = (a.get(pre..).unwrap_or(&[]), b.get(pre..).unwrap_or(&[]));
    let suf = a1
        .iter()
        .rev()
        .zip(b1.iter().rev())
        .take_while(|(x, y)| x == y)
        .count();
    let (am, bm) = (
        a1.get(..a1.len() - suf).unwrap_or(&[]),
        b1.get(..b1.len() - suf).unwrap_or(&[]),
    );
    if pre > 0 {
        out.push(Op::Equal {
            a: ao,
            b: bo,
            len: pre,
        });
    }
    let (ao2, bo2) = (ao + pre, bo + pre);
    if am.is_empty() && !bm.is_empty() {
        out.push(Op::Insert {
            b: bo2,
            len: bm.len(),
        });
    } else if bm.is_empty() && !am.is_empty() {
        out.push(Op::Delete {
            a: ao2,
            len: am.len(),
        });
    } else if !am.is_empty() {
        middle(am, bm, ao2, bo2, depth, out);
    }
    if suf > 0 {
        out.push(Op::Equal {
            a: ao + a.len() - suf,
            b: bo + b.len() - suf,
            len: suf,
        });
    }
}

fn middle(a: &[u32], b: &[u32], ao: usize, bo: usize, depth: usize, out: &mut Vec<Op>) {
    if depth < MAX_DEPTH {
        let anchors = unique_lcs(a, b);
        if !anchors.is_empty() {
            let (mut pa, mut pb) = (0usize, 0usize);
            for (ia, ib) in anchors {
                rec(
                    a.get(pa..ia).unwrap_or(&[]),
                    b.get(pb..ib).unwrap_or(&[]),
                    ao + pa,
                    bo + pb,
                    depth + 1,
                    out,
                );
                out.push(Op::Equal {
                    a: ao + ia,
                    b: bo + ib,
                    len: 1,
                });
                pa = ia + 1;
                pb = ib + 1;
            }
            rec(
                a.get(pa..).unwrap_or(&[]),
                b.get(pb..).unwrap_or(&[]),
                ao + pa,
                bo + pb,
                depth + 1,
                out,
            );
            return;
        }
    }
    match myers(a, b) {
        Some(ops) => {
            for op in ops {
                out.push(match op {
                    Op::Equal { a, b, len } => Op::Equal {
                        a: a + ao,
                        b: b + bo,
                        len,
                    },
                    Op::Delete { a, len } => Op::Delete { a: a + ao, len },
                    Op::Insert { b, len } => Op::Insert { b: b + bo, len },
                });
            }
        }
        None => {
            out.push(Op::Delete {
                a: ao,
                len: a.len(),
            });
            out.push(Op::Insert {
                b: bo,
                len: b.len(),
            });
        }
    }
}

/// Anchors: elements occurring exactly once in both, longest increasing subsequence by position.
fn unique_lcs(a: &[u32], b: &[u32]) -> Vec<(usize, usize)> {
    let mut count: HashMap<u32, (u32, usize, u32, usize)> = HashMap::new();
    for (i, x) in a.iter().enumerate() {
        let e = count.entry(*x).or_insert((0, i, 0, 0));
        e.0 += 1;
    }
    for (j, x) in b.iter().enumerate() {
        if let Some(e) = count.get_mut(x) {
            e.2 += 1;
            e.3 = j;
        }
    }
    let mut pairs: Vec<(usize, usize)> = count
        .values()
        .filter(|e| e.0 == 1 && e.2 == 1)
        .map(|e| (e.1, e.3))
        .collect();
    pairs.sort_unstable();
    // Patience LIS on the b positions.
    let mut tails: Vec<usize> = Vec::new(); // indices into pairs
    let mut prev: Vec<Option<usize>> = vec![None; pairs.len()];
    for (i, p) in pairs.iter().enumerate() {
        let pos = tails.partition_point(|&t| pairs.get(t).is_some_and(|q| q.1 < p.1));
        if pos > 0 {
            if let Some(slot) = prev.get_mut(i) {
                *slot = tails.get(pos - 1).copied();
            }
        }
        if pos == tails.len() {
            tails.push(i);
        } else if let Some(t) = tails.get_mut(pos) {
            *t = i;
        }
    }
    let mut out = Vec::with_capacity(tails.len());
    let mut cur = tails.last().copied();
    while let Some(i) = cur {
        if let Some(p) = pairs.get(i) {
            out.push(*p);
        }
        cur = prev.get(i).copied().flatten();
        if out.len() > pairs.len() {
            break;
        }
    }
    out.reverse();
    out
}

/// Myers O(ND) with edit distance ≤ [`MAX_D`]; `None` when the bound is exceeded.
fn myers(a: &[u32], b: &[u32]) -> Option<Vec<Op>> {
    let (n, m) = (a.len() as isize, b.len() as isize);
    let max = (n + m).min(MAX_D as isize);
    let off = max + 1;
    let mut v = vec![0isize; (2 * max + 3) as usize];
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let get = |v: &[isize], k: isize| v.get((k + off) as usize).copied().unwrap_or(0);
    let mut found = None;
    'outer: for d in 0..=max {
        // Keep only the diagonals -d..=d of the previous V for backtracking (O(D²) memory).
        let snapshot: Vec<isize> = (-d..=d).map(|k| get(&v, k)).collect();
        trace.push(snapshot);
        let mut k = -d;
        while k <= d {
            let mut x = if k == -d || (k != d && get(&v, k - 1) < get(&v, k + 1)) {
                get(&v, k + 1)
            } else {
                get(&v, k - 1) + 1
            };
            let mut y = x - k;
            while x < n && y < m && a.get(x as usize) == b.get(y as usize) {
                x += 1;
                y += 1;
            }
            if let Some(slot) = v.get_mut((k + off) as usize) {
                *slot = x;
            }
            if x >= n && y >= m {
                found = Some(d);
                break 'outer;
            }
            k += 2;
        }
    }
    let dmax = found?;
    // Backtrack.
    let mut ops_rev: Vec<Op> = Vec::new();
    let (mut x, mut y) = (n, m);
    for d in (0..=dmax).rev() {
        let vd = trace.get(d as usize)?;
        let at = |k: isize| -> isize {
            if k < -d || k > d {
                -1
            } else {
                vd.get((k + d) as usize).copied().unwrap_or(0)
            }
        };
        let k = x - y;
        if d == 0 {
            if x > 0 {
                ops_rev.push(Op::Equal {
                    a: 0,
                    b: 0,
                    len: x as usize,
                });
            }
            break;
        }
        // `vd` holds V after step d-1, i.e. the state the step-d move started from.
        let prev_k = if k == -d || (k != d && at(k - 1) < at(k + 1)) {
            k + 1
        } else {
            k - 1
        };
        let prev_x = at(prev_k);
        let prev_y = prev_x - prev_k;
        let (sx, sy) = if prev_k == k + 1 {
            (prev_x, prev_y + 1) // insertion (down)
        } else {
            (prev_x + 1, prev_y) // deletion (right)
        };
        let snake = x - sx;
        if snake > 0 {
            ops_rev.push(Op::Equal {
                a: sx as usize,
                b: sy as usize,
                len: snake as usize,
            });
        }
        if prev_k == k + 1 {
            ops_rev.push(Op::Insert {
                b: prev_y as usize,
                len: 1,
            });
        } else {
            ops_rev.push(Op::Delete {
                a: prev_x as usize,
                len: 1,
            });
        }
        x = prev_x;
        y = prev_y;
    }
    ops_rev.reverse();
    Some(ops_rev)
}

fn rects(toks: &[Tok], range: std::ops::Range<usize>) -> Vec<PageRect> {
    let mut out: Vec<PageRect> = Vec::new();
    for t in toks.get(range).unwrap_or(&[]) {
        let b = t.bbox;
        match out.last_mut() {
            Some(r)
                if r.page == t.page
                    && (r.y0.max(b.y0) < r.y1.min(b.y1))
                    && ((r.y1.min(b.y1) - r.y0.max(b.y0))
                        >= 0.5 * (b.y1 - b.y0).min(r.y1 - r.y0))
                    && (b.x0 - r.x1).max(r.x0 - b.x1) < 3.0 * (b.y1 - b.y0).max(1.0) =>
            {
                r.x0 = r.x0.min(b.x0);
                r.y0 = r.y0.min(b.y0);
                r.x1 = r.x1.max(b.x1);
                r.y1 = r.y1.max(b.y1);
            }
            _ => {
                if out.len() < 256 {
                    out.push(PageRect {
                        page: t.page,
                        x0: b.x0,
                        y0: b.y0,
                        x1: b.x1,
                        y1: b.y1,
                    })
                }
            }
        }
    }
    out
}

fn join(toks: &[Tok], range: std::ops::Range<usize>) -> String {
    let mut s = String::new();
    for t in toks.get(range).unwrap_or(&[]) {
        if !s.is_empty() {
            s.push(' ');
        }
        if s.len() > 4000 {
            s.push('…');
            break;
        }
        s.push_str(t.text);
    }
    s
}

/// Compare the extracted pages of A (old) and B (new).
pub fn compare_text(a: &[PageText], b: &[PageText], o: &TextOptions) -> TextDiff {
    let ta = tokens(a);
    let tb = tokens(b);
    let mut ids: HashMap<String, u32> = HashMap::new();
    let mut id = |s: &str| -> u32 {
        let k = key(s, o);
        let n = ids.len() as u32;
        *ids.entry(k).or_insert(n)
    };
    let ia: Vec<u32> = ta.iter().map(|t| id(t.text)).collect();
    let ib: Vec<u32> = tb.iter().map(|t| id(t.text)).collect();
    let ops = diff_ids(&ia, &ib);

    let mut summary = Summary {
        words_a: ta.len(),
        words_b: tb.len(),
        pages_a: a.len(),
        pages_b: b.len(),
        ..Summary::default()
    };
    let page_of = |toks: &[Tok], i: usize, pages: &[PageText]| -> usize {
        toks.get(i)
            .or_else(|| i.checked_sub(1).and_then(|j| toks.get(j)))
            .or(toks.last())
            .map_or(pages.first().map_or(0, |p| p.page), |t| t.page)
    };
    let mut changes = Vec::new();
    let (mut pa, mut pb) = (0usize, 0usize); // cursors
    let mut i = 0;
    while i < ops.len() {
        match ops.get(i) {
            Some(Op::Equal { a, b, len }) => {
                pa = a + len;
                pb = b + len;
                i += 1;
            }
            Some(_) => {
                let (mut da, mut db) = (pa..pa, pb..pb);
                while let Some(op) = ops.get(i) {
                    match *op {
                        Op::Delete { a, len } => da = da.start.min(a)..(a + len).max(da.end),
                        Op::Insert { b, len } => db = db.start.min(b)..(b + len).max(db.end),
                        Op::Equal { .. } => break,
                    }
                    i += 1;
                }
                let kind = match (da.is_empty(), db.is_empty()) {
                    (false, false) => ChangeKind::Changed,
                    (true, false) => ChangeKind::Inserted,
                    _ => ChangeKind::Deleted,
                };
                match kind {
                    ChangeKind::Changed => summary.changed += 1,
                    ChangeKind::Inserted => summary.inserted += 1,
                    ChangeKind::Deleted => summary.deleted += 1,
                }
                if changes.len() >= MAX_CHANGES {
                    summary.truncated = true;
                } else {
                    changes.push(Change {
                        kind,
                        old: join(&ta, da.clone()),
                        new: join(&tb, db.clone()),
                        page_a: page_of(&ta, da.start, a),
                        page_b: page_of(&tb, db.start, b),
                        rects_a: rects(&ta, da.clone()),
                        rects_b: rects(&tb, db.clone()),
                    });
                }
                pa = da.end;
                pb = db.end;
            }
            None => break,
        }
    }
    TextDiff { summary, changes }
}

/// Result of a visual comparison.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualDiff {
    pub width: u32,
    pub height: u32,
    pub changed_pixels: usize,
    /// Changed fraction of the page (0..1).
    pub ratio: f64,
    /// Bounding boxes of changed regions in pixels: `[x, y, w, h]`.
    pub boxes: Vec<[u32; 4]>,
    #[serde(skip)]
    pub overlay_png: Vec<u8>,
}

/// An RGBA raster.
pub struct Raster<'a> {
    pub width: u32,
    pub height: u32,
    pub rgba: &'a [u8],
}

impl Raster<'_> {
    /// Pixel composited over white, or white outside the raster.
    fn px(&self, x: u32, y: u32) -> [u8; 3] {
        if x >= self.width || y >= self.height {
            return [255, 255, 255];
        }
        let i = (y as usize * self.width as usize + x as usize) * 4;
        match self.rgba.get(i..i + 4) {
            Some(&[r, g, b, a]) => {
                let over = |c: u8| -> u8 {
                    ((u32::from(c) * u32::from(a) + 255 * (255 - u32::from(a))) / 255) as u8
                };
                [over(r), over(g), over(b)]
            }
            _ => [255, 255, 255],
        }
    }
}

const CELL: u32 = 8;
const MAX_BOXES: usize = 500;

/// Compare two rasters. `threshold`: per-channel difference (0–255) above which a pixel counts
/// as changed.
pub fn compare_visual(a: &Raster, b: &Raster, threshold: u8) -> Result<VisualDiff> {
    for r in [a, b] {
        let need = (r.width as usize)
            .checked_mul(r.height as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or(OfficeError::Limit("raster size"))?;
        if r.rgba.len() != need {
            return Err(OfficeError::Params(
                "rgba length does not match width × height × 4".into(),
            ));
        }
    }
    let (w, h) = (a.width.max(b.width), a.height.max(b.height));
    if w == 0 || h == 0 || (w as usize) * (h as usize) > png::MAX_PIXELS {
        return Err(OfficeError::Limit("raster size"));
    }
    let (cw, ch) = (w.div_ceil(CELL), h.div_ceil(CELL));
    let mut cells = vec![false; cw as usize * ch as usize];
    let mut overlay = Vec::with_capacity(w as usize * h as usize * 4);
    let mut changed = 0usize;
    for y in 0..h {
        for x in 0..w {
            let pa = a.px(x, y);
            let pb = b.px(x, y);
            let d = pa
                .iter()
                .zip(pb.iter())
                .map(|(p, q)| p.abs_diff(*q))
                .max()
                .unwrap_or(0);
            if d > threshold {
                changed += 1;
                if let Some(c) = cells.get_mut(((y / CELL) * cw + x / CELL) as usize) {
                    *c = true;
                }
                overlay.extend_from_slice(&[255, 45, 85, 255]);
            } else {
                let lum = (u32::from(pa[0]) * 3 + u32::from(pa[1]) * 6 + u32::from(pa[2])) / 10;
                let g = (170 + lum / 3).min(255) as u8;
                overlay.extend_from_slice(&[g, g, g, 255]);
            }
        }
    }
    // Connected regions of changed cells (8-connected, bridging one empty cell).
    let mut seen = vec![false; cells.len()];
    let mut boxes = Vec::new();
    let idx = |x: u32, y: u32| (y * cw + x) as usize;
    for cy in 0..ch {
        for cx in 0..cw {
            if !cells.get(idx(cx, cy)).copied().unwrap_or(false)
                || seen.get(idx(cx, cy)).copied().unwrap_or(true)
            {
                continue;
            }
            let (mut x0, mut y0, mut x1, mut y1) = (cx, cy, cx, cy);
            let mut stack = vec![(cx, cy)];
            if let Some(s) = seen.get_mut(idx(cx, cy)) {
                *s = true;
            }
            while let Some((x, y)) = stack.pop() {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
                for ny in y.saturating_sub(2)..=(y + 2).min(ch - 1) {
                    for nx in x.saturating_sub(2)..=(x + 2).min(cw - 1) {
                        let k = idx(nx, ny);
                        if cells.get(k).copied().unwrap_or(false)
                            && !seen.get(k).copied().unwrap_or(true)
                        {
                            if let Some(s) = seen.get_mut(k) {
                                *s = true;
                            }
                            stack.push((nx, ny));
                        }
                    }
                }
            }
            if boxes.len() < MAX_BOXES {
                let bx = x0 * CELL;
                let by = y0 * CELL;
                boxes.push([
                    bx,
                    by,
                    ((x1 + 1) * CELL).min(w) - bx,
                    ((y1 + 1) * CELL).min(h) - by,
                ]);
            }
        }
    }
    let overlay_png = png::encode(w, h, 4, &overlay)?;
    Ok(VisualDiff {
        width: w,
        height: h,
        changed_pixels: changed,
        ratio: changed as f64 / (f64::from(w) * f64::from(h)),
        boxes,
        overlay_png,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn apply(a: &[u32], b: &[u32], ops: &[Op]) -> Vec<u32> {
        // Rebuild b from a + ops and check the equal ranges really are equal.
        let mut out = vec![];
        let mut ca = 0;
        for op in ops {
            match *op {
                Op::Equal { a: ia, b: ib, len } => {
                    assert_eq!(ia, ca, "{ops:?}");
                    assert_eq!(&a[ia..ia + len], &b[ib..ib + len]);
                    out.extend_from_slice(&a[ia..ia + len]);
                    ca = ia + len;
                }
                Op::Delete { a: ia, len } => {
                    assert_eq!(ia, ca);
                    ca += len;
                }
                Op::Insert { b: ib, len } => out.extend_from_slice(&b[ib..ib + len]),
            }
        }
        assert_eq!(ca, a.len());
        out
    }

    #[test]
    fn diff_rebuilds_the_target() {
        let cases: Vec<(Vec<u32>, Vec<u32>)> = vec![
            (vec![1, 2, 3, 4, 5], vec![1, 2, 9, 4, 5]),
            (vec![], vec![1, 2]),
            (vec![1, 2], vec![]),
            (vec![1, 1, 1, 2], vec![1, 2, 1, 1]),
            (vec![5, 6, 7, 1, 2, 3], vec![1, 2, 3, 5, 6, 7]),
            (
                (0..300).map(|x| x % 7).collect(),
                (0..310).map(|x| (x * 3) % 7).collect(),
            ),
        ];
        for (a, b) in cases {
            let ops = diff_ids(&a, &b);
            assert_eq!(apply(&a, &b, &ops), b);
        }
    }

    #[test]
    fn myers_is_minimal_on_small_cases() {
        let ops = myers(&[1, 2, 3], &[1, 3]).unwrap();
        let dels: usize = ops
            .iter()
            .map(|o| {
                if let Op::Delete { len, .. } = o {
                    *len
                } else {
                    0
                }
            })
            .sum();
        let ins: usize = ops
            .iter()
            .map(|o| {
                if let Op::Insert { len, .. } = o {
                    *len
                } else {
                    0
                }
            })
            .sum();
        assert_eq!((dels, ins), (1, 0));
    }

    #[test]
    fn unrelated_large_inputs_stay_bounded() {
        let a: Vec<u32> = (0..50_000).map(|x| x % 3).collect();
        let b: Vec<u32> = (0..50_000).map(|x| 3 + x % 5).collect();
        let t = std::time::Instant::now();
        let ops = diff_ids(&a, &b);
        assert!(t.elapsed().as_secs() < 20);
        assert_eq!(apply(&a, &b, &ops), b);
    }

    #[test]
    fn arabic_keys_ignore_tashkeel() {
        let o = TextOptions::default();
        assert_eq!(key("كَتَبَ", &o), key("كتب", &o));
        let strict = TextOptions {
            ignore_diacritics: false,
            ..o
        };
        assert_ne!(key("كَتَبَ", &strict), key("كتب", &strict));
        let loose = TextOptions {
            normalize_letters: true,
            ..o
        };
        assert_eq!(key("أحمد", &loose), key("احمد", &loose));
    }

    #[test]
    fn visual_diff_finds_the_changed_region() {
        let (w, h) = (64u32, 48u32);
        let white = vec![255u8; (w * h * 4) as usize];
        let mut b = white.clone();
        for y in 10..20 {
            for x in 30..40 {
                let i = ((y * w + x) * 4) as usize;
                b[i..i + 3].copy_from_slice(&[0, 0, 0]);
            }
        }
        let r = compare_visual(
            &Raster {
                width: w,
                height: h,
                rgba: &white,
            },
            &Raster {
                width: w,
                height: h,
                rgba: &b,
            },
            32,
        )
        .unwrap();
        assert_eq!(r.changed_pixels, 100);
        assert_eq!(r.boxes.len(), 1);
        let [x, y, bw, bh] = r.boxes[0];
        assert!(x <= 30 && y <= 10 && x + bw >= 40 && y + bh >= 20);
        assert!(r.overlay_png.starts_with(b"\x89PNG"));
        let same = compare_visual(
            &Raster {
                width: w,
                height: h,
                rgba: &white,
            },
            &Raster {
                width: w,
                height: h,
                rgba: &white,
            },
            32,
        )
        .unwrap();
        assert_eq!(same.changed_pixels, 0);
        assert!(same.boxes.is_empty());
        assert!(compare_visual(
            &Raster {
                width: 2,
                height: 2,
                rgba: &[0; 3]
            },
            &Raster {
                width: 2,
                height: 2,
                rgba: &[0; 16]
            },
            1
        )
        .is_err());
    }
}
