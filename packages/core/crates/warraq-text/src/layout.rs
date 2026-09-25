//! Glyph units → words → lines → paragraphs → blocks, in logical reading order.
//!
//! 1. Units are grouped by writing angle; each group is laid out in its own frame (x along the
//!    baseline, y up).
//! 2. Combining-mark-only units are attached to the base they sit on.
//! 3. Regions are found by recursive **XY-cut**: vertical gutters (x-projection gaps that span
//!    the whole region) split columns, ordered right-to-left in RTL regions; horizontal gaps
//!    split bands top to bottom. Column sets of 3+ with aligned baselines and short lines are
//!    read as tables (row by row).
//! 4. Lines are chains of content-order units that stay on one baseline, merged by baseline.
//! 5. Words are content-order chains of touching units. **Nastaliq rule**: inside a word the
//!    content (glyph stream) order is kept even when x is not monotonic — stacked, kerned
//!    ligatures (lam-alef, kaf-taa in Amiri; Nastaliq cascades) overlap, so sorting by x would
//!    scramble them; words themselves are ordered by x.
//! 6. Each line is converted from visual to logical order with the bidi algorithm plus the
//!    W5 fix ([`crate::bidi`]), direction from the line's majority of strong characters.
//! 7. Paragraph breaks: line-spacing jumps, font-size changes, first-line indents, list
//!    markers, and short lines ending a sentence (`.` `؟` `?` `!` `۔` `:`).

use std::collections::HashMap;
use std::rc::Rc;

use unicode_bidi::{bidi_class, BidiClass};

use crate::bidi::{detect_direction, proxy_char, visual_to_logical, Dir};
use crate::geom::Rect;
use crate::interp::RawGlyph;
use crate::limits;
use crate::model::{Block, GlyphBox, Line, PageText, Paragraph, TextSpan, Word};
use crate::normalize::normalize_extracted;

/// Options for [`layout_page`].
#[derive(Debug, Clone, Copy)]
pub struct LayoutOptions {
    /// Emit per-glyph boxes in words.
    pub glyphs: bool,
    /// Include invisible (render mode 3) text.
    pub include_hidden: bool,
    /// Include `/Artifact` text (headers, footers, watermarks).
    pub include_artifacts: bool,
}

impl Default for LayoutOptions {
    fn default() -> Self {
        LayoutOptions {
            glyphs: false,
            include_hidden: true,
            include_artifacts: true,
        }
    }
}

#[derive(Debug, Clone)]
struct U {
    text: String,
    x0: f64,
    x1: f64,
    y0: f64,
    y1: f64,
    base: f64,
    size: f64,
    seq: usize,
    space: bool,
    mark: bool,
    bbox: Rect,
    hidden: bool,
    artifact: bool,
    bold: bool,
    lang: Option<Rc<str>>,
}

impl U {
    fn cx(&self) -> f64 {
        (self.x0 + self.x1) / 2.0
    }
    fn rtl(&self) -> bool {
        self.text.chars().find_map(crate::bidi::strong_dir) == Some(Dir::Rtl)
    }
}

fn median(mut v: Vec<f64>) -> f64 {
    v.retain(|x| x.is_finite());
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(f64::total_cmp);
    v.get(v.len() / 2).copied().unwrap_or(0.0)
}

fn is_mark_text(t: &str) -> bool {
    !t.is_empty() && t.chars().all(|c| bidi_class(c) == BidiClass::NSM)
}

fn gap(a: (f64, f64), b: (f64, f64)) -> f64 {
    (b.0 - a.1).max(a.0 - b.1)
}

/// Lay out one page.
pub fn layout_page(
    page: usize,
    glyphs: Vec<RawGlyph>,
    page_box: [f64; 4],
    opts: &LayoutOptions,
) -> PageText {
    let [bx0, by0, bx1, by1] = page_box;
    let to_tl = |r: &Rect| Rect::new(r.x0 - bx0, by1 - r.y1, r.x1 - bx0, by1 - r.y0).rounded();
    // Group by writing angle (degrees).
    let mut buckets: HashMap<i64, Vec<U>> = HashMap::new();
    for g in glyphs {
        if (g.hidden && !opts.include_hidden) || (g.artifact && !opts.include_artifacts) {
            continue;
        }
        let text = normalize_extracted(&g.text);
        if text.is_empty() {
            continue;
        }
        let mut ang = g.dir.1.atan2(g.dir.0).to_degrees().round() as i64;
        ang = ang.rem_euclid(360);
        if ang <= 2 || ang >= 358 {
            ang = 0;
        }
        let th = (ang as f64).to_radians();
        let (c, s) = (th.cos(), th.sin());
        let fx = g.origin.0 * c + g.origin.1 * s;
        let fy = -g.origin.0 * s + g.origin.1 * c;
        let size = g.size.max(0.01);
        let space = text.chars().all(char::is_whitespace);
        let (asc, desc) = if g.asc - g.desc > 0.05 * size {
            (g.asc, g.desc)
        } else {
            (0.8 * size, -0.2 * size)
        };
        buckets.entry(ang).or_default().push(U {
            mark: is_mark_text(&text),
            text,
            x0: fx,
            x1: fx + g.width.max(0.0),
            y0: fy + desc,
            y1: fy + asc,
            base: fy,
            size,
            seq: g.seq,
            space,
            bbox: g.bbox,
            hidden: g.hidden,
            artifact: g.artifact,
            bold: g.bold,
            lang: g.lang,
        });
    }
    let mut keys: Vec<i64> = buckets.keys().copied().collect();
    keys.sort_by_key(|k| {
        (
            i64::from(*k != 0),
            -(buckets.get(k).map_or(0, Vec::len) as i64),
            *k,
        )
    });

    let mut out = PageText {
        page,
        width: (bx1 - bx0).abs(),
        height: (by1 - by0).abs(),
        blocks: Vec::new(),
        plain: String::new(),
        spans: Vec::new(),
    };
    let mut plain_chars = 0usize;
    let mut line_no = 0usize;
    for k in keys {
        let Some(mut us) = buckets.remove(&k) else {
            continue;
        };
        attach_marks(&mut us);
        let idx: Vec<usize> = (0..us.len())
            .filter(|&i| us.get(i).is_some_and(|u| !u.space && !u.mark_attached()))
            .collect();
        let spaces: Vec<usize> = (0..us.len())
            .filter(|&i| us.get(i).is_some_and(|u| u.space))
            .collect();
        let ctx = PageCtx {
            dir: region_dir(&us, &idx),
            left: idx
                .iter()
                .filter_map(|&i| us.get(i))
                .map(|u| u.x0)
                .fold(f64::MAX, f64::min),
            right: idx
                .iter()
                .filter_map(|&i| us.get(i))
                .map(|u| u.x1)
                .fold(f64::MIN, f64::max),
        };
        let mut leaves = Vec::new();
        xy_cut(&us, idx, 0, &mut leaves);
        let leaf_boxes: Vec<Option<LeafBox>> = leaves.iter().map(|l| leaf_box(&us, l)).collect();
        let mut leaf_units: Vec<Vec<usize>> = leaves.clone();
        for s in spaces {
            let Some(u) = us.get(s) else { continue };
            let (cx, cy) = (u.cx(), (u.y0 + u.y1) / 2.0);
            if let Some(pos) = leaf_boxes.iter().position(|b| {
                b.is_some_and(|(x0, x1, y0, y1, m)| {
                    cx >= x0 - 0.2 * m && cx <= x1 + 0.2 * m && cy >= y0 && cy <= y1
                })
            }) {
                if let Some(l) = leaf_units.get_mut(pos) {
                    l.push(s);
                }
            }
        }
        for leaf in leaf_units {
            if let Some(block) = build_block(
                &us,
                &leaf,
                &ctx,
                opts,
                &to_tl,
                &mut out.plain,
                &mut plain_chars,
                &mut out.spans,
                &mut line_no,
            ) {
                out.blocks.push(block);
            }
        }
    }
    if out.plain.ends_with('\n') {
        out.plain.pop();
    }
    out
}

impl U {
    fn mark_attached(&self) -> bool {
        self.mark && self.text.is_empty()
    }
}

/// `(x0, x1, y0, y1, median size)` of a leaf.
type LeafBox = (f64, f64, f64, f64, f64);

fn leaf_box(us: &[U], leaf: &[usize]) -> Option<LeafBox> {
    let mut b: Option<(f64, f64, f64, f64)> = None;
    let mut sizes = Vec::new();
    for &i in leaf {
        let u = us.get(i)?;
        sizes.push(u.size);
        b = Some(match b {
            None => (u.x0, u.x1, u.y0, u.y1),
            Some((a, c, d, e)) => (a.min(u.x0), c.max(u.x1), d.min(u.y0), e.max(u.y1)),
        });
    }
    b.map(|(a, c, d, e)| (a, c, d, e, median(sizes)))
}

/// Attach combining-mark-only units to the base glyph under them (text appended to the base,
/// the mark unit emptied).
fn attach_marks(us: &mut [U]) {
    let mut by_seq: Vec<usize> = (0..us.len()).collect();
    by_seq.sort_by_key(|&i| us.get(i).map_or(0, |u| u.seq));
    for p in 0..by_seq.len() {
        let Some(&mi) = by_seq.get(p) else { continue };
        let Some(m) = us.get(mi).cloned() else {
            continue;
        };
        if !m.mark {
            continue;
        }
        let mut best: Option<(usize, usize)> = None; // (distance in seq, index)
        let lo = p.saturating_sub(16);
        let hi = (p + 16).min(by_seq.len().saturating_sub(1));
        for q in lo..=hi {
            let Some(&bi) = by_seq.get(q) else { continue };
            if bi == mi {
                continue;
            }
            let Some(b) = us.get(bi) else { continue };
            if b.mark || b.space {
                continue;
            }
            let tol = 0.15 * b.size;
            let inside = m.cx() >= b.x0 - tol && m.cx() <= b.x1 + tol;
            let near_y = (m.base - b.base).abs() < 1.2 * b.size.max(m.size);
            if inside && near_y {
                let d = q.abs_diff(p);
                // Prefer the base drawn before the mark.
                let d = if q < p { d * 2 } else { d * 2 + 1 };
                if best.is_none_or(|(bd, _)| d < bd) {
                    best = Some((d, bi));
                }
            }
        }
        if let Some((_, bi)) = best {
            if let Some(b) = us.get_mut(bi) {
                b.text.push_str(&m.text);
            }
            if let Some(mu) = us.get_mut(mi) {
                mu.text.clear();
            }
        } else if let Some(mu) = us.get_mut(mi) {
            // Stand-alone mark: keep as an ordinary unit.
            mu.mark = false;
        }
    }
}

fn count_lines(us: &[U], idx: &[usize], tol: f64) -> usize {
    let mut bases: Vec<f64> = idx
        .iter()
        .filter_map(|&i| us.get(i).map(|u| u.base))
        .collect();
    bases.sort_by(f64::total_cmp);
    let mut n = 0;
    let mut last: Option<f64> = None;
    for b in bases {
        if last.is_none_or(|l| b - l > tol) {
            n += 1;
            last = Some(b);
        }
    }
    n
}

fn cluster_bases(us: &[U], idx: &[usize], tol: f64) -> Vec<f64> {
    let mut bases: Vec<f64> = idx
        .iter()
        .filter_map(|&i| us.get(i).map(|u| u.base))
        .collect();
    bases.sort_by(|a, b| b.total_cmp(a));
    let mut out: Vec<f64> = Vec::new();
    for b in bases {
        match out.last() {
            Some(l) if (l - b).abs() <= tol => {}
            _ => out.push(b),
        }
    }
    out
}

fn intervals_gaps(mut iv: Vec<(f64, f64)>, min_gap: f64) -> Vec<(f64, f64)> {
    iv.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut gaps = Vec::new();
    let mut end: Option<f64> = None;
    for (a, b) in iv {
        match end {
            None => end = Some(b),
            Some(e) => {
                if a - e >= min_gap {
                    gaps.push((e, a));
                }
                end = Some(e.max(b));
            }
        }
    }
    gaps
}

fn region_dir(us: &[U], idx: &[usize]) -> Dir {
    detect_direction(
        idx.iter()
            .filter_map(|&i| us.get(i).map(|u| u.text.as_str())),
    )
}

fn xy_cut(us: &[U], idx: Vec<usize>, depth: usize, out: &mut Vec<Vec<usize>>) {
    if idx.len() <= 1 || depth >= limits::MAX_LAYOUT_DEPTH {
        if !idx.is_empty() {
            out.push(idx);
        }
        return;
    }
    let med = median(
        idx.iter()
            .filter_map(|&i| us.get(i).map(|u| u.size))
            .collect(),
    )
    .max(0.5);
    // Vertical gutters.
    let xiv: Vec<(f64, f64)> = idx
        .iter()
        .filter_map(|&i| us.get(i).map(|u| (u.x0, u.x1)))
        .collect();
    let vgaps: Vec<(f64, f64)> = intervals_gaps(xiv, 0.9 * med)
        .into_iter()
        .filter(|&(a, b)| {
            let left: Vec<usize> = idx
                .iter()
                .copied()
                .filter(|&i| us.get(i).is_some_and(|u| u.x1 <= a + 1e-6))
                .collect();
            let right: Vec<usize> = idx
                .iter()
                .copied()
                .filter(|&i| us.get(i).is_some_and(|u| u.x0 >= b - 1e-6))
                .collect();
            let (nl, nr) = (
                count_lines(us, &left, 0.5 * med),
                count_lines(us, &right, 0.5 * med),
            );
            // Columns sit side by side: their vertical extents must overlap.
            let ext = |g: &[usize]| {
                let y0 = g
                    .iter()
                    .filter_map(|&i| us.get(i))
                    .map(|u| u.y0)
                    .fold(f64::MAX, f64::min);
                let y1 = g
                    .iter()
                    .filter_map(|&i| us.get(i))
                    .map(|u| u.y1)
                    .fold(f64::MIN, f64::max);
                (y0, y1)
            };
            let (l0, l1) = ext(&left);
            let (r0, r1) = ext(&right);
            let overlap = (l1.min(r1) - l0.max(r0)).max(0.0);
            let side_by_side = overlap >= 0.5 * (l1 - l0).min(r1 - r0).max(1e-6);
            side_by_side && ((nl >= 2 && nr >= 2) || (b - a) >= 2.5 * med)
        })
        .collect();
    if !vgaps.is_empty() {
        let mut groups: Vec<Vec<usize>> = vec![Vec::new(); vgaps.len() + 1];
        for &i in &idx {
            let Some(u) = us.get(i) else { continue };
            let g = vgaps.iter().filter(|&&(a, _)| u.cx() > a).count();
            if let Some(v) = groups.get_mut(g) {
                v.push(i);
            }
        }
        groups.retain(|g| !g.is_empty());
        if groups.len() >= 2 {
            let dir = region_dir(us, &idx);
            if dir == Dir::Rtl {
                groups.reverse();
            }
            if groups.len() >= 3 && looks_like_table(us, &groups, med) {
                emit_table(us, &groups, med, out);
                return;
            }
            for g in groups {
                xy_cut(us, g, depth + 1, out);
            }
            return;
        }
    }
    // Horizontal bands.
    let yiv: Vec<(f64, f64)> = idx
        .iter()
        .filter_map(|&i| us.get(i).map(|u| (u.y0, u.y1)))
        .collect();
    let hgaps = intervals_gaps(yiv, 0.6 * med);
    if !hgaps.is_empty() {
        let mut groups: Vec<Vec<usize>> = vec![Vec::new(); hgaps.len() + 1];
        for &i in &idx {
            let Some(u) = us.get(i) else { continue };
            let cy = (u.y0 + u.y1) / 2.0;
            let g = hgaps.iter().filter(|&&(a, _)| cy > a).count();
            if let Some(v) = groups.get_mut(g) {
                v.push(i);
            }
        }
        groups.retain(|g| !g.is_empty());
        if groups.len() >= 2 {
            groups.reverse(); // top (largest y) first
            for g in groups {
                xy_cut(us, g, depth + 1, out);
            }
            return;
        }
    }
    out.push(idx);
}

fn looks_like_table(us: &[U], groups: &[Vec<usize>], med: f64) -> bool {
    let tol = 0.35 * med;
    let bases: Vec<Vec<f64>> = groups.iter().map(|g| cluster_bases(us, g, tol)).collect();
    if bases.iter().any(|b| b.len() < 2) {
        return false;
    }
    let total: usize = bases.iter().map(Vec::len).sum();
    let mut matched = 0usize;
    for (gi, bs) in bases.iter().enumerate() {
        for b in bs {
            if bases
                .iter()
                .enumerate()
                .any(|(gj, o)| gj != gi && o.iter().any(|x| (x - b).abs() <= tol))
            {
                matched += 1;
            }
        }
    }
    if (matched as f64) < 0.7 * total as f64 {
        return false;
    }
    // Prose columns are filled edge to edge; table cells are not.
    let mut full = 0usize;
    let mut lines = 0usize;
    for g in groups {
        let Some((x0, x1, _, _, _)) = leaf_box(us, g) else {
            continue;
        };
        let w = (x1 - x0).max(1e-6);
        for b in cluster_bases(us, g, tol) {
            let row: Vec<&U> = g
                .iter()
                .filter_map(|&i| us.get(i))
                .filter(|u| (u.base - b).abs() <= tol)
                .collect();
            let lx0 = row.iter().map(|u| u.x0).fold(f64::MAX, f64::min);
            let lx1 = row.iter().map(|u| u.x1).fold(f64::MIN, f64::max);
            lines += 1;
            if lx1 - lx0 >= 0.85 * w {
                full += 1;
            }
        }
    }
    (full as f64) < 0.6 * lines as f64
}

fn emit_table(us: &[U], groups: &[Vec<usize>], med: f64, out: &mut Vec<Vec<usize>>) {
    let tol = 0.35 * med;
    let all: Vec<usize> = groups.iter().flatten().copied().collect();
    let rows = cluster_bases(us, &all, tol);
    for r in rows {
        for g in groups {
            let cell: Vec<usize> = g
                .iter()
                .copied()
                .filter(|&i| us.get(i).is_some_and(|u| (u.base - r).abs() <= tol))
                .collect();
            if !cell.is_empty() {
                out.push(cell);
            }
        }
    }
}

/// Split a leaf into lines (each a list of unit indices, spaces included).
fn build_lines(us: &[U], leaf: &[usize]) -> Vec<Vec<usize>> {
    let mut order: Vec<usize> = leaf.to_vec();
    order.sort_by_key(|&i| us.get(i).map_or(0, |u| u.seq));
    let mut frags: Vec<Vec<usize>> = Vec::new();
    let mut cur: Vec<usize> = Vec::new();
    for i in order {
        let Some(u) = us.get(i) else { continue };
        if let Some(p) = cur.last().and_then(|&l| us.get(l)) {
            let s = p.size.max(u.size);
            let hg = gap((p.x0, p.x1), (u.x0, u.x1));
            let yo = (p.y1.min(u.y1) - p.y0.max(u.y0)).max(0.0);
            let h = (p.y1 - p.y0).min(u.y1 - u.y0).max(1e-6);
            if ((u.base - p.base).abs() > 0.8 * s && yo < 0.5 * h) || hg > 2.5 * s {
                frags.push(std::mem::take(&mut cur));
            }
        }
        cur.push(i);
    }
    if !cur.is_empty() {
        frags.push(cur);
    }
    // Merge fragments by baseline.
    struct F {
        idx: Vec<usize>,
        base: f64,
        size: f64,
        y0: f64,
        y1: f64,
    }
    let mut fs: Vec<F> = frags
        .into_iter()
        .map(|f| {
            let solid: Vec<f64> = f
                .iter()
                .filter_map(|&i| us.get(i))
                .filter(|u| !u.space)
                .map(|u| u.base)
                .collect();
            let base = if solid.is_empty() {
                median(
                    f.iter()
                        .filter_map(|&i| us.get(i).map(|u| u.base))
                        .collect(),
                )
            } else {
                median(solid)
            };
            let size = median(
                f.iter()
                    .filter_map(|&i| us.get(i).map(|u| u.size))
                    .collect(),
            );
            // Core band: the middle of the glyph boxes (robust to a few tall glyphs).
            let y0 = median(f.iter().filter_map(|&i| us.get(i).map(|u| u.y0)).collect());
            let y1 = median(f.iter().filter_map(|&i| us.get(i).map(|u| u.y1)).collect());
            F {
                idx: f,
                base,
                size,
                y0,
                y1,
            }
        })
        .collect();
    fs.sort_by(|a, b| b.base.total_cmp(&a.base));
    let mut lines: Vec<F> = Vec::new();
    for f in fs {
        let target = lines.iter_mut().find(|l| {
            let yo = (l.y1.min(f.y1) - l.y0.max(f.y0)).max(0.0);
            let h = (l.y1 - l.y0).min(f.y1 - f.y0).max(1e-6);
            (l.base - f.base).abs() <= 0.5 * l.size.max(f.size) || yo >= 0.6 * h
        });
        match target {
            Some(l) => {
                l.idx.extend(f.idx);
                l.y0 = l.y0.min(f.y0);
                l.y1 = l.y1.max(f.y1);
            }
            None => lines.push(f),
        }
    }
    lines.sort_by(|a, b| b.base.total_cmp(&a.base));
    lines
        .into_iter()
        .map(|l| l.idx)
        .filter(|l| l.iter().any(|&i| us.get(i).is_some_and(|u| !u.space)))
        .collect()
}

/// Item of a line in visual order.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Item {
    Unit(usize),
    Space,
}

/// Build visual-order items of a line: content-order word chains (Nastaliq rule), words by x.
fn visual_items(us: &[U], line: &[usize]) -> Vec<Item> {
    let mut order: Vec<usize> = line.to_vec();
    order.sort_by_key(|&i| us.get(i).map_or(0, |u| u.seq));
    // Producers that draw space glyphs draw all of them: then only spaces (or a very wide gap)
    // separate words, and cursive/kerned positioning gaps inside words are ignored.
    let explicit_spaces = line.iter().any(|&i| us.get(i).is_some_and(|u| u.space));
    let word_gap = if explicit_spaces { 0.8 } else { 0.12 };
    // Chains of touching units in content order.
    let mut chains: Vec<Vec<usize>> = Vec::new();
    let mut cur: Vec<usize> = Vec::new();
    let mut spaces: Vec<f64> = Vec::new();
    for i in order {
        let Some(u) = us.get(i) else { continue };
        if u.space {
            spaces.push(u.cx());
            if !cur.is_empty() {
                chains.push(std::mem::take(&mut cur));
            }
            continue;
        }
        if let Some(p) = cur.last().and_then(|&l| us.get(l)) {
            let wg = word_gap * p.size.max(u.size);
            if gap((p.x0, p.x1), (u.x0, u.x1)) > wg {
                chains.push(std::mem::take(&mut cur));
            }
        }
        cur.push(i);
    }
    if !cur.is_empty() {
        chains.push(cur);
    }
    // Orient each chain left-to-right (visual).
    struct C {
        units: Vec<usize>,
        x0: f64,
        x1: f64,
        size: f64,
    }
    let mut cs: Vec<C> = chains
        .into_iter()
        .map(|mut c| {
            if let (Some(f), Some(l)) = (
                c.first().and_then(|&i| us.get(i)),
                c.last().and_then(|&i| us.get(i)),
            ) {
                if l.cx() < f.cx() - 0.05 * f.size.max(l.size) {
                    c.reverse();
                }
            }
            let x0 = c
                .iter()
                .filter_map(|&i| us.get(i))
                .map(|u| u.x0)
                .fold(f64::MAX, f64::min);
            let x1 = c
                .iter()
                .filter_map(|&i| us.get(i))
                .map(|u| u.x1)
                .fold(f64::MIN, f64::max);
            let size = c
                .iter()
                .filter_map(|&i| us.get(i))
                .map(|u| u.size)
                .fold(0.0, f64::max);
            C {
                units: c,
                x0,
                x1,
                size,
            }
        })
        .collect();
    cs.sort_by(|a, b| (a.x0 + a.x1).total_cmp(&(b.x0 + b.x1)));
    // Merge neighbouring chains that touch with no space between (scrambled content order).
    let mut merged: Vec<C> = Vec::new();
    for c in cs {
        if let Some(m) = merged.last_mut() {
            let wg = word_gap * m.size.max(c.size);
            let g = gap((m.x0, m.x1), (c.x0, c.x1));
            let space_between = spaces
                .iter()
                .any(|&s| s > m.x1.min(c.x0) - 1e-6 && s < m.x1.max(c.x0) + 1e-6);
            if g <= wg && !space_between {
                m.units.extend(c.units);
                m.x0 = m.x0.min(c.x0);
                m.x1 = m.x1.max(c.x1);
                m.size = m.size.max(c.size);
                continue;
            }
        }
        merged.push(c);
    }
    let mut items = Vec::new();
    for (k, c) in merged.into_iter().enumerate() {
        if k > 0 {
            items.push(Item::Space);
        }
        items.extend(c.units.into_iter().map(Item::Unit));
    }
    items
}

struct LineOut {
    line: Line,
    /// Units in logical order with their char offsets inside `line.text`.
    units: Vec<(usize, usize, usize)>,
    x0: f64,
    x1: f64,
    base: f64,
    size: f64,
}

/// Page-level context for paragraph direction.
struct PageCtx {
    dir: Dir,
    left: f64,
    right: f64,
}

/// Paragraph direction of a line: majority of strong characters; mixed lines take the block
/// direction. A minority-script line that is flush with the page's start edge for the *page*
/// direction and ragged on the other side (e.g. a Latin list item inside an RTL page, whose
/// marker sits on the right) takes the page direction.
fn line_dir(us: &[U], line: &[usize], block_dir: Dir, ctx: &PageCtx) -> Dir {
    let d = line_majority_dir(us, line, block_dir);
    if d == ctx.dir {
        return d;
    }
    let solid: Vec<&U> = line
        .iter()
        .filter_map(|&i| us.get(i))
        .filter(|u| !u.space)
        .collect();
    let x0 = solid.iter().map(|u| u.x0).fold(f64::MAX, f64::min);
    let x1 = solid.iter().map(|u| u.x1).fold(f64::MIN, f64::max);
    let size = median(solid.iter().map(|u| u.size).collect()).max(0.5);
    let (start_gap, end_gap) = match ctx.dir {
        Dir::Rtl => (ctx.right - x1, x0 - ctx.left),
        Dir::Ltr => (x0 - ctx.left, ctx.right - x1),
    };
    if start_gap < 2.5 * size && end_gap > 2.0 * start_gap + 3.0 * size {
        ctx.dir
    } else {
        d
    }
}

fn line_majority_dir(us: &[U], line: &[usize], block_dir: Dir) -> Dir {
    let (mut l, mut r) = (0usize, 0usize);
    for u in line.iter().filter_map(|&i| us.get(i)) {
        for c in u.text.chars() {
            match crate::bidi::strong_dir(c) {
                Some(Dir::Ltr) => l += 1,
                Some(Dir::Rtl) => r += 1,
                None => {}
            }
        }
    }
    let t = l + r;
    if t == 0 {
        return block_dir;
    }
    let rf = r as f64 / t as f64;
    if rf >= 0.65 {
        Dir::Rtl
    } else if rf <= 0.35 {
        Dir::Ltr
    } else {
        block_dir
    }
}

fn build_line<F: Fn(&Rect) -> Rect>(
    us: &[U],
    line: &[usize],
    block_dir: Dir,
    ctx: &PageCtx,
    opts: &LayoutOptions,
    to_tl: &F,
) -> Option<LineOut> {
    let items = visual_items(us, line);
    let dir = line_dir(us, line, block_dir, ctx);
    let proxies: Vec<char> = items
        .iter()
        .map(|it| match it {
            Item::Space => ' ',
            Item::Unit(i) => us.get(*i).map_or(' ', |u| proxy_char(&u.text)),
        })
        .collect();
    let order = visual_to_logical(&proxies, dir);
    let logical: Vec<Item> = order
        .iter()
        .filter_map(|&k| items.get(k).copied())
        .collect();
    // Words.
    let mut words: Vec<Word> = Vec::new();
    let mut unit_offsets: Vec<(usize, usize, usize)> = Vec::new();
    let mut text = String::new();
    let mut chars = 0usize;
    let mut cur: Vec<usize> = Vec::new();
    let flush = |cur: &mut Vec<usize>,
                 words: &mut Vec<Word>,
                 text: &mut String,
                 chars: &mut usize,
                 offs: &mut Vec<(usize, usize, usize)>| {
        if cur.is_empty() {
            return;
        }
        if !words.is_empty() {
            text.push(' ');
            *chars += 1;
        }
        let mut wtext = String::new();
        let mut bbox: Option<Rect> = None;
        let mut glyphs = Vec::new();
        let (mut hidden, mut artifact, mut bold) = (true, true, false);
        let mut lang = None;
        let mut sizes = Vec::new();
        for &i in cur.iter() {
            let Some(u) = us.get(i) else { continue };
            let n = u.text.chars().count();
            offs.push((i, *chars, *chars + n));
            *chars += n;
            wtext.push_str(&u.text);
            bbox = Some(bbox.map_or(u.bbox, |b| b.union(&u.bbox)));
            hidden &= u.hidden;
            artifact &= u.artifact;
            bold |= u.bold;
            if lang.is_none() {
                lang = u.lang.as_ref().map(|l| l.to_string());
            }
            sizes.push(u.size);
            if opts.glyphs {
                glyphs.push(GlyphBox {
                    text: u.text.clone(),
                    bbox: to_tl(&u.bbox),
                });
            }
        }
        text.push_str(&wtext);
        let wdir = detect_direction([wtext.as_str()]);
        words.push(Word {
            text: wtext,
            bbox: to_tl(&bbox.unwrap_or_default()),
            dir: wdir,
            hidden,
            artifact,
            bold,
            lang,
            size: (median(sizes) * 100.0).round() / 100.0,
            glyphs,
        });
        cur.clear();
    };
    for it in logical {
        match it {
            Item::Space => flush(
                &mut cur,
                &mut words,
                &mut text,
                &mut chars,
                &mut unit_offsets,
            ),
            Item::Unit(i) => cur.push(i),
        }
    }
    flush(
        &mut cur,
        &mut words,
        &mut text,
        &mut chars,
        &mut unit_offsets,
    );
    if words.is_empty() {
        return None;
    }
    let solid: Vec<&U> = line
        .iter()
        .filter_map(|&i| us.get(i))
        .filter(|u| !u.space)
        .collect();
    let x0 = solid.iter().map(|u| u.x0).fold(f64::MAX, f64::min);
    let x1 = solid.iter().map(|u| u.x1).fold(f64::MIN, f64::max);
    let base = median(solid.iter().map(|u| u.base).collect());
    let size = median(solid.iter().map(|u| u.size).collect());
    let bbox = solid
        .iter()
        .map(|u| u.bbox)
        .reduce(|a, b| a.union(&b))
        .unwrap_or_default();
    Some(LineOut {
        line: Line {
            text,
            bbox: to_tl(&bbox),
            dir,
            words,
        },
        units: unit_offsets,
        x0,
        x1,
        base,
        size,
    })
}

fn starts_list_item(t: &str) -> bool {
    let mut it = t.chars();
    let Some(c0) = it.next() else { return false };
    if matches!(c0, '•' | '▪' | '‣' | '◦' | '●' | '■' | '–' | '—' | '*') {
        return true;
    }
    if c0 == '-' {
        return it.next() == Some(' ');
    }
    // "1." "١-" "۲)" "12)" …
    let digits: String = t.chars().take_while(|c| c.is_numeric()).collect();
    if digits.is_empty() || digits.chars().count() > 3 {
        return false;
    }
    let rest = t.get(digits.len()..).unwrap_or("");
    let mut r = rest.chars();
    matches!(r.next(), Some('.' | ')' | '-' | '،' | '٫')) && matches!(r.next(), Some(' ') | None)
}

fn ends_sentence(t: &str) -> bool {
    let t = t.trim_end_matches(|c: char| {
        c.is_whitespace() || matches!(c, '"' | '»' | '«' | ')' | '(' | '”' | '’')
    });
    t.ends_with(['.', '؟', '?', '!', '۔', ':', '\u{06D4}'])
}

#[allow(clippy::too_many_arguments)]
fn build_block<F: Fn(&Rect) -> Rect>(
    us: &[U],
    leaf: &[usize],
    ctx: &PageCtx,
    opts: &LayoutOptions,
    to_tl: &F,
    plain: &mut String,
    plain_chars: &mut usize,
    spans: &mut Vec<TextSpan>,
    line_no: &mut usize,
) -> Option<Block> {
    let solid: Vec<usize> = leaf
        .iter()
        .copied()
        .filter(|&i| us.get(i).is_some_and(|u| !u.space))
        .collect();
    let block_dir = region_dir(us, &solid);
    let lines: Vec<LineOut> = build_lines(us, leaf)
        .iter()
        .filter_map(|l| build_line(us, l, block_dir, ctx, opts, to_tl))
        .collect();
    if lines.is_empty() {
        return None;
    }
    let left = lines.iter().map(|l| l.x0).fold(f64::MAX, f64::min);
    let right = lines.iter().map(|l| l.x1).fold(f64::MIN, f64::max);
    let width = (right - left).max(1e-6);
    let deltas: Vec<f64> = lines
        .windows(2)
        .filter_map(|w| match w {
            [a, b] => Some(a.base - b.base),
            _ => None,
        })
        .collect();
    let typical = median(deltas.clone());
    let start_off = |l: &LineOut| {
        if block_dir == Dir::Rtl {
            right - l.x1
        } else {
            l.x0 - left
        }
    };
    let end_gap = |l: &LineOut| {
        if block_dir == Dir::Rtl {
            l.x0 - left
        } else {
            right - l.x1
        }
    };
    let mut paras: Vec<Vec<LineOut>> = Vec::new();
    let mut prev: Option<&LineOut> = None;
    let mut breaks = vec![false; lines.len()];
    for (k, l) in lines.iter().enumerate() {
        if let Some(p) = prev {
            let s = p.size.max(l.size);
            let d = p.base - l.base;
            let size_change = (l.size / p.size.max(1e-6) - 1.0).abs() > 0.18;
            let spacing = (deltas.len() >= 2 && d > 1.35 * typical && d > 0.5 * s) || d > 2.2 * s;
            let indent = start_off(l) > start_off(p) + 1.0 * s && start_off(l) < 0.5 * width;
            let short_end = ends_sentence(&p.line.text) && end_gap(p) > (2.0 * s).max(0.1 * width);
            let list = starts_list_item(&l.line.text);
            if let Some(b) = breaks.get_mut(k) {
                *b = size_change || spacing || indent || short_end || list;
            }
        }
        prev = Some(l);
    }
    for (k, l) in lines.into_iter().enumerate() {
        if breaks.get(k).copied().unwrap_or(false) || paras.is_empty() {
            paras.push(Vec::new());
        }
        if let Some(p) = paras.last_mut() {
            p.push(l);
        }
    }
    let mut out_paras = Vec::new();
    let mut bbox_all: Option<Rect> = None;
    for p in paras {
        let mut text = String::new();
        let mut bbox: Option<Rect> = None;
        let mut out_lines = Vec::new();
        for (k, lo) in p.into_iter().enumerate() {
            if k > 0 {
                text.push(' ');
                plain.push(' ');
                *plain_chars += 1;
            }
            for (ui, s, e) in &lo.units {
                if let Some(u) = us.get(*ui) {
                    spans.push(TextSpan {
                        start: *plain_chars + s,
                        end: *plain_chars + e,
                        bbox: to_tl(&u.bbox),
                        rtl: u.rtl(),
                        line: *line_no,
                    });
                }
            }
            *line_no += 1;
            *plain_chars += lo.line.text.chars().count();
            plain.push_str(&lo.line.text);
            text.push_str(&lo.line.text);
            bbox = Some(bbox.map_or(lo.line.bbox, |b| b.union(&lo.line.bbox)));
            out_lines.push(lo.line);
        }
        plain.push('\n');
        *plain_chars += 1;
        let bbox = bbox.unwrap_or_default();
        bbox_all = Some(bbox_all.map_or(bbox, |b| b.union(&bbox)));
        let dir = detect_direction([text.as_str()]);
        out_paras.push(Paragraph {
            text,
            bbox,
            dir,
            lines: out_lines,
        });
    }
    Some(Block {
        bbox: bbox_all.unwrap_or_default(),
        dir: block_dir,
        paragraphs: out_paras,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    /// A glyph at (x, y) with width w, size 10.
    fn g(text: &str, x: f64, y: f64, w: f64, seq: usize) -> RawGlyph {
        RawGlyph {
            text: text.to_string(),
            bbox: Rect::new(x, y - 2.0, x + w, y + 8.0),
            origin: (x, y),
            dir: (1.0, 0.0),
            width: w,
            asc: 8.0,
            desc: -2.0,
            size: 10.0,
            seq,
            hidden: false,
            artifact: false,
            actual_text: false,
            reversed: false,
            lang: None,
            font: None,
            bold: false,
        }
    }

    /// Lay out an RTL string drawn visually left-to-right (Chrome style), one glyph per char.
    fn visual_run(logical: &str, x: f64, y: f64, seq0: usize) -> Vec<RawGlyph> {
        let visual = crate::bidi::logical_to_visual(logical, Some(Dir::Rtl));
        visual
            .chars()
            .enumerate()
            .map(|(k, c)| g(&c.to_string(), x + 5.0 * k as f64, y, 5.0, seq0 + k))
            .collect()
    }

    fn plain(glyphs: Vec<RawGlyph>) -> String {
        layout_page(
            0,
            glyphs,
            [0.0, 0.0, 600.0, 800.0],
            &LayoutOptions::default(),
        )
        .plain
    }

    #[test]
    fn visual_rtl_line_becomes_logical() {
        assert_eq!(
            plain(visual_run("مرحبا بالعالم", 100.0, 700.0, 0)),
            "مرحبا بالعالم"
        );
    }

    #[test]
    fn logical_order_drawn_right_to_left() {
        // Word-style: glyphs emitted in logical order, x decreasing, no spaces (gap only).
        let mut v = Vec::new();
        let mut x = 300.0;
        let mut seq = 0;
        for w in ["سلام", "عليكم"] {
            for c in w.chars() {
                x -= 5.0;
                v.push(g(&c.to_string(), x, 700.0, 5.0, seq));
                seq += 1;
            }
            x -= 4.0;
        }
        assert_eq!(plain(v), "سلام عليكم");
    }

    #[test]
    fn nastaliq_rule_keeps_stream_order_for_stacked_glyphs() {
        // Word "لکھا" drawn visually (left→right) by the shaper but with a kerned, stacked
        // pair whose x centres are out of order.
        let mut v = vec![
            g("ا", 100.0, 700.0, 4.0, 0),
            g("ھ", 103.0, 703.0, 5.0, 1),
            g("ک", 101.0, 706.0, 7.0, 2), // overlaps previous, centre left of it
            g("ل", 107.0, 709.0, 3.0, 3),
        ];
        // stream order is visual order here; sorting by x would put ک before ھ
        assert_eq!(plain(v.clone()), "لکھا");
        // A space and a second word further right still order words by x.
        v.push(g(" ", 110.0, 700.0, 2.0, 4));
        v.extend(visual_run("میں", 112.0, 700.0, 5));
        // Nastaliq fonts have tall ascent/descent.
        for x in v.iter_mut() {
            x.asc = 20.0;
            x.desc = -10.0;
        }
        assert_eq!(plain(v), "میں لکھا");
    }

    #[test]
    fn marks_attach_to_their_base() {
        // "بَ" drawn visually: base then zero-width fatha over it, then alef to the left.
        let v = vec![
            g("ا", 90.0, 700.0, 5.0, 0),
            g("ب", 95.0, 700.0, 6.0, 1),
            g("\u{064E}", 97.0, 700.0, 0.0, 2),
        ];
        assert_eq!(plain(v), "بَا");
    }

    #[test]
    fn two_columns_rtl_read_right_column_first() {
        let mut v = Vec::new();
        let mut seq = 0;
        // right column (x 320..) lines, left column (x 50..)
        for (k, t) in ["العمود الأول سطر", "العمود الأول ثان"].iter().enumerate()
        {
            let run = visual_run(t, 320.0, 700.0 - 14.0 * k as f64, seq);
            seq += run.len();
            v.extend(run);
        }
        for (k, t) in ["العمود الثاني سطر", "العمود الثاني ثان"]
            .iter()
            .enumerate()
        {
            let run = visual_run(t, 50.0, 700.0 - 14.0 * k as f64, seq);
            seq += run.len();
            v.extend(run);
        }
        let p = plain(v);
        assert!(p.find("الأول").unwrap() < p.find("الثاني").unwrap(), "{p}");
        assert!(p.contains("العمود الأول سطر العمود الأول ثان"), "{p}");
    }

    #[test]
    fn paragraphs_split_on_spacing_and_sentence_end() {
        let mut v = Vec::new();
        let mut seq = 0;
        let lines = [
            ("هذا سطر طويل جدا من النص العربي", 700.0),
            ("نهاية.", 686.0),
            ("فقرة جديدة هنا", 672.0),
        ];
        for (t, y) in lines {
            // right-aligned block ending at x=400
            let n = t.chars().count() as f64;
            let run = visual_run(t, 400.0 - 5.0 * n, y, seq);
            seq += run.len();
            v.extend(run);
        }
        let p = plain(v);
        assert_eq!(p, "هذا سطر طويل جدا من النص العربي نهاية.\nفقرة جديدة هنا");
    }

    #[test]
    fn rtl_table_is_read_row_by_row() {
        let mut v = Vec::new();
        let mut seq = 0;
        let rows = [
            ["المنتج", "الكمية", "السعر"],
            ["حاسوب", "3", "4500"],
            ["طابعة", "2", "1200"],
        ];
        for (r, row) in rows.iter().enumerate() {
            // columns at x = 400 (first, rightmost), 250, 100
            for (c, cell) in row.iter().enumerate() {
                let x = 400.0 - 150.0 * c as f64;
                let run = visual_run(cell, x, 700.0 - 20.0 * r as f64, seq);
                seq += run.len();
                v.extend(run);
            }
        }
        let p = plain(v);
        assert_eq!(
            p.split_whitespace().collect::<Vec<_>>().join(" "),
            "المنتج الكمية السعر حاسوب 3 4500 طابعة 2 1200"
        );
    }

    #[test]
    fn heading_above_two_columns() {
        let mut v = Vec::new();
        let mut seq = 0;
        let mut add = |t: &str, x: f64, y: f64| {
            let run = visual_run(t, x, y, seq);
            seq += run.len();
            v.extend(run);
        };
        add("عنوان يمتد فوق العمودين معا في الصفحة", 150.0, 760.0);
        for k in 0..3 {
            add("نص العمود الأيمن هنا", 330.0, 720.0 - 14.0 * k as f64);
            add("نص العمود الأيسر هنا", 60.0, 720.0 - 14.0 * k as f64);
        }
        let p = plain(v);
        let h = p.find("عنوان").unwrap();
        let r = p.find("الأيمن").unwrap();
        let l = p.find("الأيسر").unwrap();
        assert!(h < r && r < l, "{p}");
    }

    #[test]
    fn list_markers() {
        assert!(starts_list_item("١. البند"));
        assert!(starts_list_item("• item"));
        assert!(starts_list_item("12) x"));
        assert!(!starts_list_item("2024 كان"));
        assert!(ends_sentence("نهاية؟"));
        assert!(ends_sentence("end.)"));
    }

    #[test]
    fn mixed_numbers_in_rtl_line() {
        let logical = "ارتفع بنسبة 35% في عام 2024";
        let p = plain(visual_run(logical, 50.0, 700.0, 0));
        assert_eq!(p, logical);
    }

    #[test]
    fn spans_map_plain_text_to_boxes() {
        let page = layout_page(
            0,
            visual_run("سلام", 100.0, 700.0, 0),
            [0.0, 0.0, 600.0, 800.0],
            &LayoutOptions::default(),
        );
        assert_eq!(page.plain, "سلام");
        assert_eq!(page.spans.len(), 4);
        // first logical char "س" is the rightmost glyph
        let s0 = &page.spans[0];
        assert!(s0.bbox.x0 > page.spans[3].bbox.x0);
        // y is top-left based
        assert!((s0.bbox.y0 - (800.0 - 708.0)).abs() < 1e-6);
    }
}
