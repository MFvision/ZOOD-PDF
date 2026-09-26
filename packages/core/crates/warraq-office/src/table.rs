//! Table detection.
//!
//! 1. **Ruled tables**: horizontal and vertical ruling segments ([`crate::rules`]) that touch
//!    each other form connected components; a component with at least two distinct x and two
//!    distinct y lines is a grid. A missing rule between two grid cells merges them (row/column
//!    spans).
//! 2. **Aligned tables** (no rules): at least three consecutive visual rows that split into the
//!    same number (≥ 2) of word chunks separated by wide gaps, with the gaps lining up from row to
//!    row and short chunks (so two columns of prose are not taken for a table).
//!
//! Grids are in page coordinates (top-left origin, y down), columns in *visual* order (left to
//! right); the writers turn them into logical order for right-to-left tables.

use warraq_text::geom::Rect;

use crate::rules::Segment;

/// Tolerance for "same line" / "touching" (points).
const TOL: f64 = 2.0;
/// Maximum grids per page.
const MAX_GRIDS: usize = 64;
/// Maximum rows/columns of a grid.
const MAX_LINES: usize = 500;

/// A merged cell of a grid (visual column order).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GridCell {
    pub row: usize,
    pub col: usize,
    pub rowspan: usize,
    pub colspan: usize,
}

/// A detected table grid.
#[derive(Debug, Clone, PartialEq)]
pub struct Grid {
    /// Column boundaries, left to right (`cols + 1` values).
    pub xs: Vec<f64>,
    /// Row boundaries, top to bottom (`rows + 1` values).
    pub ys: Vec<f64>,
    pub cells: Vec<GridCell>,
    /// Drawn with rules (vs. inferred from alignment).
    pub ruled: bool,
}

impl Grid {
    pub fn rows(&self) -> usize {
        self.ys.len().saturating_sub(1)
    }
    pub fn cols(&self) -> usize {
        self.xs.len().saturating_sub(1)
    }
    pub fn bbox(&self) -> Rect {
        let f = |v: &[f64]| {
            (
                v.first().copied().unwrap_or(0.0),
                v.last().copied().unwrap_or(0.0),
            )
        };
        let (x0, x1) = f(&self.xs);
        let (y0, y1) = f(&self.ys);
        Rect::new(x0, y0, x1, y1)
    }
    /// Index into `cells` of the cell containing the point, if inside the grid.
    pub fn cell_at(&self, x: f64, y: f64) -> Option<usize> {
        let c = band(&self.xs, x)?;
        let r = band(&self.ys, y)?;
        self.cells.iter().position(|k| {
            (k.row..k.row + k.rowspan).contains(&r) && (k.col..k.col + k.colspan).contains(&c)
        })
    }
    /// Rectangle of a cell.
    pub fn cell_rect(&self, k: &GridCell) -> Rect {
        let g = |v: &[f64], i: usize| v.get(i).copied().unwrap_or(0.0);
        Rect::new(
            g(&self.xs, k.col),
            g(&self.ys, k.row),
            g(&self.xs, k.col + k.colspan),
            g(&self.ys, k.row + k.rowspan),
        )
    }
}

/// Index `i` with `v[i] ≤ p < v[i+1]`.
fn band(v: &[f64], p: f64) -> Option<usize> {
    v.windows(2).position(|w| match w {
        [a, b] => p >= *a && p < *b,
        _ => false,
    })
}

/// Merge collinear, overlapping or nearly touching segments of the same orientation.
fn merge(mut segs: Vec<Segment>) -> Vec<Segment> {
    segs.sort_by(|a, b| a.pos.total_cmp(&b.pos).then(a.a0.total_cmp(&b.a0)));
    let mut out: Vec<Segment> = Vec::new();
    for s in segs {
        // Find a segment on the same line that overlaps (search back over the same pos band).
        let mut merged = false;
        for o in out.iter_mut().rev().take(64) {
            if (o.pos - s.pos).abs() > TOL {
                break;
            }
            if s.a0 <= o.a1 + TOL && s.a1 >= o.a0 - TOL {
                o.a0 = o.a0.min(s.a0);
                o.a1 = o.a1.max(s.a1);
                merged = true;
                break;
            }
        }
        if !merged {
            out.push(s);
        }
    }
    out
}

/// Cluster sorted values closer than `TOL` into their mean.
fn cluster(mut v: Vec<f64>) -> Vec<f64> {
    v.sort_by(f64::total_cmp);
    let mut out: Vec<(f64, usize)> = Vec::new();
    for x in v {
        match out.last_mut() {
            Some((m, n)) if (x - *m / *n as f64).abs() <= TOL => {
                *m += x;
                *n += 1;
            }
            _ => out.push((x, 1)),
        }
    }
    out.into_iter().map(|(m, n)| m / n as f64).collect()
}

fn find(parent: &mut [usize], mut i: usize) -> usize {
    for _ in 0..parent.len() {
        let p = parent.get(i).copied().unwrap_or(i);
        if p == i {
            return i;
        }
        let gp = parent.get(p).copied().unwrap_or(p);
        if let Some(slot) = parent.get_mut(i) {
            *slot = gp;
        }
        i = p;
    }
    i
}

/// Grids from ruling segments.
pub fn ruled_grids(segs: &[Segment]) -> Vec<Grid> {
    let h = merge(segs.iter().filter(|s| s.horizontal).copied().collect());
    let v = merge(segs.iter().filter(|s| !s.horizontal).copied().collect());
    if h.len() < 2 || v.len() < 2 || h.len() * v.len() > 4_000_000 {
        return Vec::new();
    }
    // Union-find over segments: h indices 0..h.len(), v indices after.
    let n = h.len() + v.len();
    let mut parent: Vec<usize> = (0..n).collect();
    for (i, hs) in h.iter().enumerate() {
        for (j, vs) in v.iter().enumerate() {
            let touch = vs.pos >= hs.a0 - TOL
                && vs.pos <= hs.a1 + TOL
                && hs.pos >= vs.a0 - TOL
                && hs.pos <= vs.a1 + TOL;
            if touch {
                let (a, b) = (find(&mut parent, i), find(&mut parent, h.len() + j));
                if a != b {
                    if let Some(p) = parent.get_mut(a) {
                        *p = b;
                    }
                }
            }
        }
    }
    let mut comps: std::collections::BTreeMap<usize, (Vec<Segment>, Vec<Segment>)> =
        Default::default();
    for i in 0..n {
        let root = find(&mut parent, i);
        let e = comps.entry(root).or_default();
        if i < h.len() {
            if let Some(s) = h.get(i) {
                e.0.push(*s);
            }
        } else if let Some(s) = v.get(i - h.len()) {
            e.1.push(*s);
        }
    }
    let mut grids = Vec::new();
    for (_, (hs, vs)) in comps {
        if hs.len() < 2 || vs.len() < 2 || grids.len() >= MAX_GRIDS {
            continue;
        }
        if let Some(g) = grid_from(&hs, &vs) {
            grids.push(g);
        }
    }
    grids
}

fn covers(segs: &[Segment], pos: f64, a0: f64, a1: f64) -> bool {
    // Is the stretch [a0,a1] at `pos` (mostly) drawn? Check its middle point.
    let mid = (a0 + a1) / 2.0;
    segs.iter()
        .any(|s| (s.pos - pos).abs() <= TOL && s.a0 <= mid + TOL && s.a1 >= mid - TOL)
}

fn grid_from(hs: &[Segment], vs: &[Segment]) -> Option<Grid> {
    let ys = cluster(hs.iter().map(|s| s.pos).collect());
    let xs = cluster(vs.iter().map(|s| s.pos).collect());
    if xs.len() < 2 || ys.len() < 2 || xs.len() > MAX_LINES || ys.len() > MAX_LINES {
        return None;
    }
    let (rows, cols) = (ys.len() - 1, xs.len() - 1);
    // Too thin to hold text: underlines, frames around nothing.
    let bbox_w = xs.last()? - xs.first()?;
    let bbox_h = ys.last()? - ys.first()?;
    if bbox_w < 10.0 || bbox_h < 6.0 {
        return None;
    }
    let at = |v: &[f64], i: usize| v.get(i).copied().unwrap_or(0.0);
    // Boundary present between column c and c+1 in row r?
    let vbound = |r: usize, c: usize| covers(vs, at(&xs, c + 1), at(&ys, r), at(&ys, r + 1));
    // Boundary present between row r and r+1 in column c?
    let hbound = |r: usize, c: usize| covers(hs, at(&ys, r + 1), at(&xs, c), at(&xs, c + 1));
    let mut taken = vec![false; rows * cols];
    let mut cells = Vec::new();
    for r in 0..rows {
        for c in 0..cols {
            if taken.get(r * cols + c).copied().unwrap_or(true) {
                continue;
            }
            let mut cs = 1;
            while c + cs < cols
                && !vbound(r, c + cs - 1)
                && !taken.get(r * cols + c + cs).copied().unwrap_or(true)
            {
                cs += 1;
            }
            let mut rs = 1;
            while r + rs < rows
                && (c..c + cs).all(|k| !hbound(r + rs - 1, k))
                && (c..c + cs).all(|k| !taken.get((r + rs) * cols + k).copied().unwrap_or(true))
            {
                rs += 1;
            }
            for rr in r..r + rs {
                for cc in c..c + cs {
                    if let Some(t) = taken.get_mut(rr * cols + cc) {
                        *t = true;
                    }
                }
            }
            cells.push(GridCell {
                row: r,
                col: c,
                rowspan: rs,
                colspan: cs,
            });
        }
    }
    // A single box (1×1) is a frame, not a table.
    if cells.len() < 2 {
        return None;
    }
    Some(Grid {
        xs,
        ys,
        cells,
        ruled: true,
    })
}

/// A positioned word for alignment detection.
#[derive(Debug, Clone, Copy)]
pub struct WordBox {
    pub bbox: Rect,
    pub size: f64,
    /// Words-per-chunk accounting uses this weight (1 per word).
    pub id: usize,
}

struct Row {
    bbox: Rect,
    /// Chunks: (x0, x1, word count)
    chunks: Vec<(f64, f64, usize)>,
}

/// Tables inferred from column alignment of words that are not inside `exclude` rectangles.
pub fn aligned_grids(words: &[WordBox], exclude: &[Rect]) -> Vec<Grid> {
    let mut ws: Vec<&WordBox> = words
        .iter()
        .filter(|w| {
            let (cx, cy) = (w.bbox.cx(), w.bbox.cy());
            w.bbox.height() > 0.0
                && !exclude
                    .iter()
                    .any(|r| cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1)
        })
        .collect();
    if ws.len() < 6 || ws.len() > 200_000 {
        return Vec::new();
    }
    ws.sort_by(|a, b| a.bbox.cy().total_cmp(&b.bbox.cy()));
    // Visual rows.
    let mut rows: Vec<(Rect, Vec<&WordBox>)> = Vec::new();
    for w in ws {
        match rows.last_mut() {
            Some((r, v)) if r.y_overlap(&w.bbox) >= 0.5 * r.height().min(w.bbox.height()) => {
                *r = r.union(&w.bbox);
                v.push(w);
            }
            _ => rows.push((w.bbox, vec![w])),
        }
    }
    let rows: Vec<Row> = rows
        .into_iter()
        .map(|(bbox, mut v)| {
            v.sort_by(|a, b| a.bbox.x0.total_cmp(&b.bbox.x0));
            let mut sizes: Vec<f64> = v.iter().map(|w| w.size).collect();
            sizes.sort_by(f64::total_cmp);
            let size = sizes.get(sizes.len() / 2).copied().unwrap_or(10.0).max(1.0);
            let mut chunks: Vec<(f64, f64, usize)> = Vec::new();
            for w in v {
                match chunks.last_mut() {
                    Some(c) if w.bbox.x0 - c.1 <= 1.2 * size => {
                        c.1 = c.1.max(w.bbox.x1);
                        c.2 += 1;
                    }
                    _ => chunks.push((w.bbox.x0, w.bbox.x1, 1)),
                }
            }
            Row { bbox, chunks }
        })
        .collect();
    // Runs of compatible rows.
    let compatible = |a: &Row, b: &Row| -> bool {
        if a.chunks.len() != b.chunks.len() || a.chunks.len() < 2 {
            return false;
        }
        let gap = b.bbox.y0 - a.bbox.y1;
        if gap > 2.5 * a.bbox.height().max(b.bbox.height()) {
            return false;
        }
        // Gaps between chunks must overlap from row to row.
        a.chunks
            .windows(2)
            .zip(b.chunks.windows(2))
            .all(|(ga, gb)| match (ga, gb) {
                ([a0, a1], [b0, b1]) => a0.1.max(b0.1) < a1.0.min(b1.0),
                _ => false,
            })
    };
    let mut grids = Vec::new();
    let mut i = 0;
    while i < rows.len() && grids.len() < MAX_GRIDS {
        let mut j = i + 1;
        while j < rows.len()
            && rows
                .get(j - 1)
                .zip(rows.get(j))
                .is_some_and(|(a, b)| compatible(a, b))
        {
            j += 1;
        }
        let run = rows.get(i..j).unwrap_or(&[]);
        let n = run.len();
        if n >= 3 {
            let cols = run.first().map_or(0, |r| r.chunks.len());
            let words: usize = run.iter().flat_map(|r| r.chunks.iter().map(|c| c.2)).sum();
            let short = (words as f64) / ((n * cols) as f64) <= 4.0;
            if short {
                // Column boundaries: middle of the common gap.
                let mut xs = vec![run.iter().map(|r| r.bbox.x0).fold(f64::MAX, f64::min) - 1.0];
                for k in 0..cols - 1 {
                    let lo = run
                        .iter()
                        .filter_map(|r| r.chunks.get(k).map(|c| c.1))
                        .fold(f64::MIN, f64::max);
                    let hi = run
                        .iter()
                        .filter_map(|r| r.chunks.get(k + 1).map(|c| c.0))
                        .fold(f64::MAX, f64::min);
                    xs.push((lo + hi) / 2.0);
                }
                xs.push(run.iter().map(|r| r.bbox.x1).fold(f64::MIN, f64::max) + 1.0);
                let mut ys = vec![run.first().map_or(0.0, |r| r.bbox.y0) - 1.0];
                for w in run.windows(2) {
                    if let [a, b] = w {
                        ys.push((a.bbox.y1 + b.bbox.y0) / 2.0);
                    }
                }
                ys.push(run.last().map_or(0.0, |r| r.bbox.y1) + 1.0);
                let cells = (0..n)
                    .flat_map(|r| {
                        (0..cols).map(move |c| GridCell {
                            row: r,
                            col: c,
                            rowspan: 1,
                            colspan: 1,
                        })
                    })
                    .collect();
                grids.push(Grid {
                    xs,
                    ys,
                    cells,
                    ruled: false,
                });
            }
            i = j;
        } else {
            i += 1;
        }
    }
    grids
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn h(y: f64, x0: f64, x1: f64) -> Segment {
        Segment {
            horizontal: true,
            pos: y,
            a0: x0,
            a1: x1,
        }
    }
    fn v(x: f64, y0: f64, y1: f64) -> Segment {
        Segment {
            horizontal: false,
            pos: x,
            a0: y0,
            a1: y1,
        }
    }

    #[test]
    fn full_grid_three_by_two() {
        let mut s = vec![];
        for y in [100.0, 120.0, 140.0, 160.0] {
            s.push(h(y, 50.0, 250.0));
        }
        for x in [50.0, 150.0, 250.0] {
            s.push(v(x, 100.0, 160.0));
        }
        let g = ruled_grids(&s);
        assert_eq!(g.len(), 1);
        assert_eq!((g[0].rows(), g[0].cols()), (3, 2));
        assert_eq!(g[0].cells.len(), 6);
        assert_eq!(g[0].cell_at(60.0, 130.0), Some(2));
    }

    #[test]
    fn missing_rules_become_spans() {
        // Row 0: one cell across both columns (no vertical rule between them in row 0).
        // Column 0: rows 1-2 merged (no horizontal rule between row 1 and 2 in column 0).
        let s = vec![
            h(100.0, 50.0, 250.0),
            h(120.0, 50.0, 250.0),
            h(140.0, 150.0, 250.0),
            h(160.0, 50.0, 250.0),
            v(50.0, 100.0, 160.0),
            v(250.0, 100.0, 160.0),
            v(150.0, 120.0, 160.0),
        ];
        let g = &ruled_grids(&s)[0];
        let spans: Vec<(usize, usize, usize, usize)> = g
            .cells
            .iter()
            .map(|c| (c.row, c.col, c.rowspan, c.colspan))
            .collect();
        assert_eq!(
            spans,
            vec![(0, 0, 1, 2), (1, 0, 2, 1), (1, 1, 1, 1), (2, 1, 1, 1)]
        );
    }

    #[test]
    fn a_single_box_or_underline_is_not_a_table() {
        let frame = vec![
            h(100.0, 50.0, 250.0),
            h(300.0, 50.0, 250.0),
            v(50.0, 100.0, 300.0),
            v(250.0, 100.0, 300.0),
        ];
        assert!(ruled_grids(&frame).is_empty());
        assert!(ruled_grids(&[h(100.0, 50.0, 250.0)]).is_empty());
    }

    #[test]
    fn two_separate_tables() {
        let mut s = vec![];
        for base in [100.0, 400.0] {
            for y in [base, base + 20.0, base + 40.0] {
                s.push(h(y, 50.0, 250.0));
            }
            for x in [50.0, 150.0, 250.0] {
                s.push(v(x, base, base + 40.0));
            }
        }
        assert_eq!(ruled_grids(&s).len(), 2);
    }

    fn wb(x0: f64, y0: f64, x1: f64, id: usize) -> WordBox {
        WordBox {
            bbox: Rect::new(x0, y0, x1, y0 + 10.0),
            size: 10.0,
            id,
        }
    }

    #[test]
    fn aligned_columns_without_rules() {
        let mut w = vec![];
        for r in 0..4 {
            let y = 100.0 + 16.0 * r as f64;
            w.push(wb(50.0, y, 90.0, w.len()));
            w.push(wb(200.0, y, 230.0, w.len()));
            w.push(wb(350.0, y, 380.0, w.len()));
        }
        let g = aligned_grids(&w, &[]);
        assert_eq!(g.len(), 1);
        assert_eq!((g[0].rows(), g[0].cols()), (4, 3));
        assert!(!g[0].ruled);
    }

    #[test]
    fn prose_columns_are_not_tables() {
        // Two columns of long lines (many words per chunk).
        let mut w = vec![];
        for r in 0..6 {
            let y = 100.0 + 14.0 * r as f64;
            for k in 0..8 {
                w.push(wb(
                    50.0 + 25.0 * k as f64,
                    y,
                    70.0 + 25.0 * k as f64,
                    w.len(),
                ));
                w.push(wb(
                    320.0 + 25.0 * k as f64,
                    y,
                    340.0 + 25.0 * k as f64,
                    w.len(),
                ));
            }
        }
        assert!(aligned_grids(&w, &[]).is_empty());
    }
}
