//! Tables on a page, for the Excel export (`export.tables`).
//!
//! Two ways a table shows itself. Most are drawn with rules: the lines
//! across and down (`warraq-render`'s rulings) that meet make a grid, and a
//! border missing between two cells merges them. Some have no rules at all,
//! only columns of text that line up: lines that the core's own reading
//! parts at wide gaps (`line_cells`), one under another, whose pieces stand
//! in the same bands across the page. The text of each cell is Warraq's
//! reading of it — Arabic in reading order — and a table whose text is
//! mostly right to left says so, so the sheet can put its first column on
//! the right.
use warraq_render::Ruling;
use warraq_text::{base_direction, Direction, TextLine};

/// One cell of a line: its text in reading order and where it was drawn,
/// left to right on the page.
#[derive(Debug, Clone, PartialEq)]
pub struct LineCell {
    pub text: String,
    pub x0: f32,
    pub x1: f32,
    pub direction: Direction,
}

/// How much wider than a word space a gap must be to part two cells, and
/// the least it can be, in ems of the line's type: justified text in a
/// narrow column stretches its spaces towards an em, a table's columns
/// stand further apart than that.
const CELL_GAP: (f32, f32) = (2.5, 1.5);
/// Gaps up to this many ems count as word spaces.
const WORD_GAP: f32 = 1.0;

fn direction_of(text: &str, line: Direction) -> Direction {
    if text.chars().any(char::is_alphabetic) {
        base_direction(text)
    } else {
        line
    }
}

/// `line` cut into cells at its wide gaps; the whole line when its chars'
/// places are not known (a turned line).
pub fn line_cells(line: &TextLine) -> Vec<LineCell> {
    let chars: Vec<char> = line.text.chars().collect();
    let whole = || {
        vec![LineCell {
            text: line.text.trim().to_string(),
            x0: line.x,
            x1: line.x + line.width,
            direction: line.direction,
        }]
    };
    if chars.is_empty() || line.spans.len() != chars.len() {
        return whole();
    }
    let size = (line.height / 1.2).max(1.0);
    // The drawn chars, left to right.
    let mut drawn: Vec<usize> = (0..chars.len())
        .filter(|&k| !chars[k].is_whitespace())
        .collect();
    if drawn.is_empty() {
        return whole();
    }
    drawn.sort_by(|a, b| {
        let (sa, sb) = (line.spans[*a], line.spans[*b]);
        sa.0.total_cmp(&sb.0).then(sa.1.total_cmp(&sb.1))
    });
    let gaps: Vec<f32> = drawn
        .windows(2)
        .map(|w| (line.spans[w[1]].0 - line.spans[w[0]].1).max(0.0))
        .collect();
    let mut words: Vec<f32> = gaps
        .iter()
        .copied()
        .filter(|g| *g > 0.1 * size && *g <= WORD_GAP * size)
        .collect();
    words.sort_by(f32::total_cmp);
    let word = words.get(words.len() / 2).copied().unwrap_or(0.3 * size);
    let threshold = (CELL_GAP.0 * word).max(CELL_GAP.1 * size);
    // Runs of drawn chars, left to right, parted at the wide gaps.
    let mut runs: Vec<(f32, f32)> = Vec::new();
    let first = line.spans[drawn[0]];
    let mut current = first;
    for (k, gap) in gaps.iter().enumerate() {
        let next = line.spans[drawn[k + 1]];
        if *gap > threshold {
            runs.push(current);
            current = next;
        } else {
            current.0 = current.0.min(next.0);
            current.1 = current.1.max(next.1);
        }
    }
    runs.push(current);
    if runs.len() == 1 {
        return whole();
    }
    runs.into_iter()
        .filter_map(|(x0, x1)| {
            // The chars inside the run, spaces included, in reading order.
            let text: String = chars
                .iter()
                .zip(&line.spans)
                .filter(|(_, (a, b))| {
                    let middle = (a + b) / 2.0;
                    middle >= x0 - 0.01 && middle <= x1 + 0.01
                })
                .map(|(c, _)| *c)
                .collect();
            let text = text.trim().to_string();
            (!text.is_empty()).then(|| LineCell {
                direction: direction_of(&text, line.direction),
                text,
                x0,
                x1,
            })
        })
        .collect()
}

/// Rulings closer than this, in points, are the same line.
const SNAP: f32 = 2.0;
/// A border is there when rulings cover this share of it.
const COVERED: f32 = 0.6;
/// A grid larger than this is not a table (a hatched drawing, graph paper).
const MAX_GRID: (usize, usize) = (200, 2_000);
/// Lines further apart than this many line heights end a column-aligned table.
const ROW_GAP: f32 = 2.5;

/// A cell of a table: its text in reading order, and how many rows and
/// columns of the grid it covers.
#[derive(Debug, Clone, PartialEq)]
pub struct TableCell {
    pub text: String,
    pub rows: usize,
    pub columns: usize,
}

/// A table found on a page. Its grid runs left to right and top to bottom as
/// drawn; a cell covered by a merged one is `None`.
#[derive(Debug, Clone, PartialEq)]
pub struct FoundTable {
    /// The top of the table, in page space (y down).
    pub top: f32,
    /// Its columns' widths, left to right, in points.
    pub widths: Vec<f32>,
    pub grid: Vec<Vec<Option<TableCell>>>,
    /// The direction most of its text reads in: a right-to-left table's
    /// first column is its rightmost.
    pub direction: Direction,
    /// Drawn with rules, rather than found by the alignment of its text.
    pub ruled: bool,
}

/// What is on a page, top to bottom: tables, and the lines of text around them.
#[derive(Debug, Clone, PartialEq)]
pub enum PageItem {
    Table(FoundTable),
    /// A line of text outside every table, with the cells its wide gaps
    /// part it into (one when it has none).
    Line {
        y: f32,
        text: String,
        direction: Direction,
        cells: Vec<LineCell>,
    },
}

impl PageItem {
    fn top(&self) -> f32 {
        match self {
            PageItem::Table(t) => t.top,
            PageItem::Line { y, .. } => *y,
        }
    }
}

/// One line across (`at` is its y) or down (`at` is its x), from `from` to `to`.
#[derive(Debug, Clone, Copy)]
struct Rule {
    at: f32,
    from: f32,
    to: f32,
}

/// Collinear rules that touch or overlap, made one.
fn merge_rules(mut rules: Vec<Rule>) -> Vec<Rule> {
    rules.sort_by(|a, b| a.at.total_cmp(&b.at).then(a.from.total_cmp(&b.from)));
    let mut out: Vec<Rule> = Vec::with_capacity(rules.len());
    for r in rules {
        if let Some(last) = out
            .iter_mut()
            .rev()
            .take_while(|l| (l.at - r.at).abs() <= SNAP)
            .find(|l| r.from <= l.to + SNAP)
        {
            last.to = last.to.max(r.to);
            last.from = last.from.min(r.from);
            continue;
        }
        out.push(r);
    }
    out
}

/// Values closer than `SNAP` made one (their mean), sorted.
fn cluster(mut values: Vec<f32>) -> Vec<f32> {
    values.sort_by(f32::total_cmp);
    let mut out: Vec<(f32, usize)> = Vec::new();
    for v in values {
        match out.last_mut() {
            Some((sum, n)) if v - *sum / *n as f32 <= SNAP => {
                *sum += v;
                *n += 1;
            }
            _ => out.push((v, 1)),
        }
    }
    out.into_iter().map(|(sum, n)| sum / n as f32).collect()
}

fn find(parent: &mut [usize], mut k: usize) -> usize {
    while parent[k] != k {
        parent[k] = parent[parent[k]];
        k = parent[k];
    }
    k
}

fn union(parent: &mut [usize], a: usize, b: usize) {
    let (ra, rb) = (find(parent, a), find(parent, b));
    if ra != rb {
        parent[ra.max(rb)] = ra.min(rb);
    }
}

/// How much of `[a, b]` the rules at `at` cover.
fn coverage(rules: &[Rule], at: f32, a: f32, b: f32) -> f32 {
    let mut spans: Vec<(f32, f32)> = rules
        .iter()
        .filter(|r| (r.at - at).abs() <= SNAP)
        .map(|r| (r.from.max(a), r.to.min(b)))
        .filter(|(x, y)| y > x)
        .collect();
    spans.sort_by(|x, y| x.0.total_cmp(&y.0));
    let (mut covered, mut end) = (0.0f32, a);
    for (x, y) in spans {
        let x = x.max(end);
        if y > x {
            covered += y - x;
            end = y;
        }
    }
    covered / (b - a).max(0.001)
}

/// A ruled grid: its column and row boundaries, and which cells are one.
struct Grid {
    xs: Vec<f32>,
    ys: Vec<f32>,
    /// For each cell (row-major), the cell it is part of.
    owner: Vec<usize>,
    /// For each cell that owns others, how many rows and columns it covers.
    spans: std::collections::HashMap<usize, (usize, usize)>,
}

/// For each owning cell: how many cells it has, and its first and last row
/// and column.
fn regions(owner: &[usize], cols: usize) -> std::collections::HashMap<usize, [usize; 5]> {
    let mut out: std::collections::HashMap<usize, [usize; 5]> = Default::default();
    for (k, o) in owner.iter().enumerate() {
        let (r, c) = (k / cols, k % cols);
        let e = out.entry(*o).or_insert([0, r, r, c, c]);
        e[0] += 1;
        e[1] = e[1].min(r);
        e[2] = e[2].max(r);
        e[3] = e[3].min(c);
        e[4] = e[4].max(c);
    }
    out
}

/// The grids that rules across and down draw: groups of rules that meet,
/// with at least two cells between them.
fn grids(rulings: &[Ruling]) -> Vec<Grid> {
    let across = merge_rules(
        rulings
            .iter()
            .filter(|r| r.across())
            .map(|r| Rule {
                at: r.y0,
                from: r.x0,
                to: r.x1,
            })
            .collect(),
    );
    let down = merge_rules(
        rulings
            .iter()
            .filter(|r| !r.across())
            .map(|r| Rule {
                at: r.x0,
                from: r.y0,
                to: r.y1,
            })
            .collect(),
    );
    let (na, nd) = (across.len(), down.len());
    if na < 2 || nd < 2 || na > 5_000 || nd > 5_000 {
        return Vec::new();
    }
    // Rules that meet belong to the same grid.
    let mut parent: Vec<usize> = (0..na + nd).collect();
    for (i, h) in across.iter().enumerate() {
        for (j, v) in down.iter().enumerate() {
            if v.at >= h.from - SNAP
                && v.at <= h.to + SNAP
                && h.at >= v.from - SNAP
                && h.at <= v.to + SNAP
            {
                union(&mut parent, i, na + j);
            }
        }
    }
    let mut groups: std::collections::BTreeMap<usize, (Vec<Rule>, Vec<Rule>)> = Default::default();
    for k in 0..na + nd {
        let root = find(&mut parent, k);
        let entry = groups.entry(root).or_default();
        if k < na {
            entry.0.push(across[k]);
        } else {
            entry.1.push(down[k - na]);
        }
    }
    let mut out = Vec::new();
    for (h, v) in groups.into_values() {
        if h.len() < 2 || v.len() < 2 {
            continue;
        }
        let ys = cluster(h.iter().map(|r| r.at).collect());
        let xs = cluster(v.iter().map(|r| r.at).collect());
        let (cols, rows) = (xs.len().saturating_sub(1), ys.len().saturating_sub(1));
        // One column is a box or a shaded paragraph (Word shades each line), not a table.
        if cols < 2 || rows == 0 || cols > MAX_GRID.0 || rows > MAX_GRID.1 {
            continue;
        }
        // A missing border between two cells makes them one.
        let mut owner: Vec<usize> = (0..rows * cols).collect();
        for r in 0..rows {
            for c in 0..cols {
                if c + 1 < cols && coverage(&v, xs[c + 1], ys[r], ys[r + 1]) < COVERED {
                    union(&mut owner, r * cols + c, r * cols + c + 1);
                }
                if r + 1 < rows && coverage(&h, ys[r + 1], xs[c], xs[c + 1]) < COVERED {
                    union(&mut owner, r * cols + c, (r + 1) * cols + c);
                }
            }
        }
        for k in 0..owner.len() {
            owner[k] = find(&mut owner, k);
        }
        // A merged cell that is not a rectangle is no merge a sheet can hold:
        // then every cell of the grid stands alone. The cell that owns a
        // region is its first (union keeps the smaller index).
        let mut found = regions(&owner, cols);
        let rectangular = found.iter().all(|(o, [n, r0, r1, c0, c1])| {
            *n == (r1 - r0 + 1) * (c1 - c0 + 1) && *o == r0 * cols + c0
        });
        if !rectangular {
            owner = (0..rows * cols).collect();
            found = regions(&owner, cols);
        }
        // One box with everything in it is a frame, not a table.
        if found.len() < 2 {
            continue;
        }
        let spans = found
            .into_iter()
            .map(|(o, [_, r0, r1, c0, c1])| (o, (r1 - r0 + 1, c1 - c0 + 1)))
            .collect();
        out.push(Grid {
            xs,
            ys,
            owner,
            spans,
        });
    }
    out
}

/// Where `v` falls between `edges`: the index of the band, if inside.
fn band(edges: &[f32], v: f32) -> Option<usize> {
    if edges.len() < 2 || v < edges[0] || v > edges[edges.len() - 1] {
        return None;
    }
    Some(
        edges
            .windows(2)
            .position(|w| v >= w[0] && v <= w[1])
            .unwrap_or(0),
    )
}

/// The direction most of `texts`' letters read in.
fn direction_of_all<'a>(texts: impl Iterator<Item = &'a str>) -> Direction {
    let (mut rtl, mut ltr) = (0usize, 0usize);
    for text in texts {
        let letters = text.chars().filter(|c| c.is_alphabetic()).count();
        if letters == 0 {
            continue;
        }
        match base_direction(text) {
            Direction::Rtl => rtl += letters,
            Direction::Ltr => ltr += letters,
        }
    }
    if rtl > ltr {
        Direction::Rtl
    } else {
        Direction::Ltr
    }
}

/// A ruled grid's cells filled with the text inside them.
fn fill_grid(grid: &Grid, texts: Vec<Vec<String>>) -> FoundTable {
    let cols = grid.xs.len() - 1;
    let rows = grid.ys.len() - 1;
    let table: Vec<Vec<Option<TableCell>>> = (0..rows)
        .map(|r| {
            (0..cols)
                .map(|c| {
                    let k = r * cols + c;
                    // A cell merged into another is left empty.
                    (grid.owner[k] == k).then(|| {
                        let (rows, columns) = grid.spans.get(&k).copied().unwrap_or((1, 1));
                        TableCell {
                            text: texts[k].join(" "),
                            rows,
                            columns,
                        }
                    })
                })
                .collect()
        })
        .collect();
    let direction = direction_of_all(
        table
            .iter()
            .flatten()
            .flatten()
            .map(|cell| cell.text.as_str()),
    );
    FoundTable {
        top: grid.ys[0],
        widths: grid.xs.windows(2).map(|w| w[1] - w[0]).collect(),
        grid: table,
        direction,
        ruled: true,
    }
}

/// Lines of cells, one after another, laid out as a table: columns are the
/// bands across the page where the fullest rows have cells.
fn aligned_table(rows: &[(f32, Vec<LineCell>)]) -> Option<FoundTable> {
    if rows.len() < 2 {
        return None;
    }
    let most = rows.iter().map(|(_, c)| c.len()).max()?;
    let mut spans: Vec<(f32, f32)> = rows
        .iter()
        .filter(|(_, c)| c.len() == most)
        .flat_map(|(_, c)| c.iter().map(|cell| (cell.x0, cell.x1)))
        .collect();
    spans.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut bands: Vec<(f32, f32)> = Vec::new();
    for (x0, x1) in spans {
        match bands.last_mut() {
            Some(last) if x0 <= last.1 + 0.5 => last.1 = last.1.max(x1),
            _ => bands.push((x0, x1)),
        }
    }
    if bands.len() < 2 {
        return None;
    }
    let cols = bands.len();
    let mut grid: Vec<Vec<Option<TableCell>>> = Vec::with_capacity(rows.len());
    for (_, cells) in rows {
        let mut texts: Vec<Vec<&str>> = vec![Vec::new(); cols];
        let mut covers: Vec<(usize, usize)> = vec![(usize::MAX, 0); cols];
        for cell in cells {
            // The bands the cell stands over: more than one is a merge.
            let over: Vec<usize> = bands
                .iter()
                .enumerate()
                .filter(|(_, (b0, b1))| {
                    let overlap = cell.x1.min(*b1) - cell.x0.max(*b0);
                    overlap > 0.3 * (b1 - b0).min(cell.x1 - cell.x0).max(0.5)
                })
                .map(|(k, _)| k)
                .collect();
            let first = match over.first() {
                Some(k) => *k,
                None => {
                    let middle = (cell.x0 + cell.x1) / 2.0;
                    (0..cols)
                        .min_by(|a, b| {
                            let d = |k: usize| (middle - (bands[k].0 + bands[k].1) / 2.0).abs();
                            d(*a).total_cmp(&d(*b))
                        })
                        .unwrap_or(0)
                }
            };
            let last = over.last().copied().unwrap_or(first);
            texts[first].push(&cell.text);
            covers[first] = (covers[first].0.min(first), covers[first].1.max(last));
        }
        let mut row: Vec<Option<TableCell>> = vec![None; cols];
        let mut k = 0;
        while k < cols {
            // A cell over several bands takes them, and whatever else is in them.
            let mut end = k;
            let mut j = k;
            while j <= end {
                if covers[j].0 != usize::MAX {
                    end = end.max(covers[j].1).min(cols - 1);
                }
                j += 1;
            }
            let text: Vec<&str> = (k..=end).flat_map(|j| texts[j].iter().copied()).collect();
            row[k] = Some(TableCell {
                text: text.join(" "),
                rows: 1,
                columns: end - k + 1,
            });
            k = end + 1;
        }
        grid.push(row);
    }
    let direction = direction_of_all(
        rows.iter()
            .flat_map(|(_, c)| c.iter().map(|c| c.text.as_str())),
    );
    let mut widths: Vec<f32> = bands.windows(2).map(|w| w[1].0 - w[0].0).collect();
    widths.push(bands[cols - 1].1 - bands[cols - 1].0);
    Some(FoundTable {
        top: rows[0].0,
        widths,
        grid,
        direction,
        ruled: false,
    })
}

/// What is on a page, in order from its top: the tables its rules draw,
/// then tables whose columns line up without rules, and every other line.
pub fn page_items(lines: &[TextLine], rulings: &[Ruling]) -> Vec<PageItem> {
    let mut grids = grids(rulings);
    // A grid with text in fewer than two of its cells is a frame or a
    // decoration: its text is read as lines.
    let (texts, _) = assign(lines, &grids);
    let keep: Vec<bool> = texts
        .iter()
        .map(|cells| cells.iter().filter(|c| !c.is_empty()).count() >= 2)
        .collect();
    let mut k = 0;
    grids.retain(|_| {
        k += 1;
        keep[k - 1]
    });
    let (texts, outside) = assign(lines, &grids);
    finish_items(grids, texts, outside)
}

/// The text of each cell of each grid, line by line; and the lines, or what
/// is left of them, outside every grid.
#[allow(clippy::type_complexity)]
fn assign(lines: &[TextLine], grids: &[Grid]) -> (Vec<Vec<Vec<String>>>, Vec<TextLine>) {
    let mut texts: Vec<Vec<Vec<String>>> = grids
        .iter()
        .map(|g| vec![Vec::new(); (g.xs.len() - 1) * (g.ys.len() - 1)])
        .collect();
    let mut outside: Vec<TextLine> = Vec::new();
    for line in lines {
        let chars: Vec<char> = line.text.chars().collect();
        let cy = line.y + line.height / 2.0;
        let whole = line.spans.len() != chars.len();
        // For each char: the grid and cell it is in, if any.
        let places: Vec<Option<(usize, usize)>> = (0..chars.len())
            .map(|k| {
                let cx = if whole {
                    line.x + line.width / 2.0
                } else {
                    (line.spans[k].0 + line.spans[k].1) / 2.0
                };
                grids.iter().enumerate().find_map(|(g, grid)| {
                    let c = band(&grid.xs, cx)?;
                    let r = band(&grid.ys, cy)?;
                    Some((g, grid.owner[r * (grid.xs.len() - 1) + c]))
                })
            })
            .collect();
        // Spaces take the place of what is next to them.
        let mut pieces: Vec<((usize, usize), String)> = Vec::new();
        let mut rest = String::new();
        let mut rest_spans = Vec::new();
        for (k, c) in chars.iter().enumerate() {
            match places[k] {
                Some(place) => match pieces.last_mut() {
                    Some((p, text)) if *p == place => text.push(*c),
                    _ => pieces.push((place, c.to_string())),
                },
                None => {
                    rest.push(*c);
                    if !whole {
                        rest_spans.push(line.spans[k]);
                    }
                }
            }
        }
        for ((g, cell), text) in pieces {
            let text = text.trim();
            if !text.is_empty() {
                texts[g][cell].push(text.to_string());
            }
        }
        if !rest.trim().is_empty() {
            if rest.chars().count() == chars.len() {
                outside.push(line.clone());
            } else {
                // What is left of a line a table cut through keeps its places.
                let (x0, x1) = rest_spans
                    .iter()
                    .fold((f32::MAX, f32::MIN), |(a, b), s| (a.min(s.0), b.max(s.1)));
                outside.push(TextLine {
                    text: rest,
                    x: x0,
                    width: (x1 - x0).max(0.0),
                    spans: rest_spans,
                    ..line.clone()
                });
            }
        }
    }
    (texts, outside)
}

fn finish_items(
    grids: Vec<Grid>,
    texts: Vec<Vec<Vec<String>>>,
    outside: Vec<TextLine>,
) -> Vec<PageItem> {
    let mut items: Vec<PageItem> = grids
        .iter()
        .zip(texts)
        .map(|(grid, texts)| PageItem::Table(fill_grid(grid, texts)))
        .collect();
    // Outside the rules: runs of lines of several cells, close together, are
    // tables; everything else is a line.
    let mut run: Vec<(f32, Vec<LineCell>, TextLine)> = Vec::new();
    let flush = |run: &mut Vec<(f32, Vec<LineCell>, TextLine)>, items: &mut Vec<PageItem>| {
        let rows: Vec<(f32, Vec<LineCell>)> = run.iter().map(|(y, c, _)| (*y, c.clone())).collect();
        match aligned_table(&rows) {
            Some(table) => items.push(PageItem::Table(table)),
            None => {
                for (y, cells, line) in run.drain(..) {
                    items.push(PageItem::Line {
                        y,
                        text: line.text.trim().to_string(),
                        direction: line.direction,
                        cells,
                    });
                }
            }
        }
        run.clear();
    };
    for line in outside {
        let cells = line_cells(&line);
        let near = run.last().is_none_or(|(_, _, last)| {
            line.y - (last.y + last.height) <= ROW_GAP * line.height.max(last.height)
        });
        if cells.len() >= 2 && near {
            run.push((line.y, cells, line));
            continue;
        }
        flush(&mut run, &mut items);
        if cells.len() >= 2 {
            run.push((line.y, cells, line));
        } else {
            items.push(PageItem::Line {
                y: line.y,
                text: line.text.trim().to_string(),
                direction: line.direction,
                cells,
            });
        }
    }
    flush(&mut run, &mut items);
    items.sort_by(|a, b| a.top().total_cmp(&b.top()));
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A left-to-right line of `text`, each char 5 points wide, with `gaps`
    /// extra points before the chars at those positions.
    fn line(text: &str, direction: Direction, gaps: &[(usize, f32)]) -> TextLine {
        let mut x = 100.0;
        let mut spans = Vec::new();
        for k in 0..text.chars().count() {
            if let Some((_, g)) = gaps.iter().find(|(at, _)| *at == k) {
                x += g;
            }
            spans.push((x, x + 5.0));
            x += 5.0;
        }
        TextLine {
            text: text.into(),
            x: 100.0,
            y: 50.0,
            width: x - 100.0,
            height: 12.0,
            direction,
            spans,
        }
    }

    fn texts(cells: &[LineCell]) -> Vec<&str> {
        cells.iter().map(|c| c.text.as_str()).collect()
    }

    #[test]
    fn wide_gaps_part_cells_and_word_spaces_do_not() {
        // "Paper A4" | "12" | "3.50": word spaces are one char wide.
        let l = line("Paper A4 12 3.50", Direction::Ltr, &[(9, 40.0), (12, 40.0)]);
        assert_eq!(texts(&line_cells(&l)), ["Paper A4", "12", "3.50"]);
    }

    #[test]
    fn a_justified_line_with_wide_spaces_stays_one_cell() {
        // Every space stretched to 14 points: none is much wider than the rest.
        let gaps: Vec<(usize, f32)> = [3, 7, 11].iter().map(|k| (*k, 9.0)).collect();
        let l = line("one two six ten", Direction::Ltr, &gaps);
        assert_eq!(line_cells(&l).len(), 1);
    }

    #[test]
    fn an_arabic_row_keeps_each_cell_in_reading_order() {
        // Logically "الوصف" then "12", drawn right to left: the word at the
        // right (x 200–225, its first letter rightmost), the number far to
        // the left (x 100–110). Spans are per logical char.
        let text = "الوصف 12";
        let mut spans: Vec<(f32, f32)> = (0..5)
            .map(|k| (220.0 - k as f32 * 5.0, 225.0 - k as f32 * 5.0))
            .collect();
        spans.push((180.0, 200.0));
        spans.push((100.0, 105.0));
        spans.push((105.0, 110.0));
        let l = TextLine {
            text: text.into(),
            x: 100.0,
            y: 0.0,
            width: 125.0,
            height: 12.0,
            direction: Direction::Rtl,
            spans,
        };
        let cells = line_cells(&l);
        assert_eq!(texts(&cells), ["12", "الوصف"]);
        assert_eq!(cells[1].direction, Direction::Rtl);
        assert_eq!(
            cells[0].direction,
            Direction::Rtl,
            "a number takes its line's direction"
        );
    }

    #[test]
    fn a_line_whose_places_are_unknown_is_one_cell() {
        let mut l = line("a b", Direction::Ltr, &[]);
        l.spans.clear();
        assert_eq!(texts(&line_cells(&l)), ["a b"]);
    }

    fn rule(x0: f32, y0: f32, x1: f32, y1: f32) -> Ruling {
        Ruling { x0, y0, x1, y1 }
    }

    /// The rules of a grid with columns at `xs` and rows at `ys`, every border drawn.
    fn grid_rules(xs: &[f32], ys: &[f32]) -> Vec<Ruling> {
        let mut out = Vec::new();
        for y in ys {
            out.push(rule(xs[0], *y, xs[xs.len() - 1], *y));
        }
        for x in xs {
            out.push(rule(*x, ys[0], *x, ys[ys.len() - 1]));
        }
        out
    }

    /// A line of `text` at `y`, its chars laid left to right from `x`, 5 points each.
    fn placed(text: &str, x: f32, y: f32) -> TextLine {
        let spans: Vec<(f32, f32)> = (0..text.chars().count())
            .map(|k| (x + 5.0 * k as f32, x + 5.0 * (k + 1) as f32))
            .collect();
        TextLine {
            text: text.into(),
            x,
            y,
            width: 5.0 * spans.len() as f32,
            height: 10.0,
            direction: Direction::Ltr,
            spans,
        }
    }

    fn cell_texts(t: &FoundTable) -> Vec<Vec<Option<String>>> {
        t.grid
            .iter()
            .map(|row| {
                row.iter()
                    .map(|c| c.as_ref().map(|c| c.text.clone()))
                    .collect()
            })
            .collect()
    }

    #[test]
    fn a_ruled_grid_is_a_table_with_its_text_in_its_cells() {
        let rules = grid_rules(&[100.0, 200.0, 300.0], &[100.0, 120.0, 140.0]);
        let lines = vec![
            placed("Title above", 100.0, 60.0),
            placed("Item", 110.0, 105.0),
            placed("Qty", 210.0, 105.0),
            placed("Paper", 110.0, 125.0),
            placed("12", 210.0, 125.0),
        ];
        let items = page_items(&lines, &rules);
        assert_eq!(items.len(), 2, "{items:?}");
        assert!(matches!(&items[0], PageItem::Line { text, .. } if text == "Title above"));
        let PageItem::Table(t) = &items[1] else {
            panic!("{items:?}")
        };
        assert!(t.ruled);
        assert_eq!(t.widths, vec![100.0, 100.0]);
        assert_eq!(
            cell_texts(t),
            vec![
                vec![Some("Item".into()), Some("Qty".into())],
                vec![Some("Paper".into()), Some("12".into())],
            ]
        );
    }

    #[test]
    fn a_missing_border_merges_two_cells() {
        // A header across both columns: no rule between them in the first row.
        let mut rules = grid_rules(&[100.0, 300.0], &[100.0, 120.0, 140.0]);
        rules.push(rule(200.0, 120.0, 200.0, 140.0));
        let lines = vec![
            placed("Both", 150.0, 105.0),
            placed("a", 110.0, 125.0),
            placed("b", 210.0, 125.0),
        ];
        let PageItem::Table(t) = &page_items(&lines, &rules)[0] else {
            panic!()
        };
        let first = t.grid[0][0].as_ref().unwrap();
        assert_eq!(
            (first.rows, first.columns, first.text.as_str()),
            (1, 2, "Both")
        );
        assert!(t.grid[0][1].is_none());
        assert_eq!(t.grid[1][1].as_ref().unwrap().text, "b");
    }

    #[test]
    fn a_box_around_text_or_shaded_lines_are_not_a_table() {
        let rules = grid_rules(&[100.0, 300.0], &[100.0, 140.0]);
        let items = page_items(&[placed("Note", 110.0, 110.0)], &rules);
        assert!(matches!(&items[..], [PageItem::Line { .. }]), "{items:?}");
        // Word shades a paragraph line by line: one column, many rows.
        let rules = grid_rules(&[100.0, 300.0], &[100.0, 112.0, 124.0, 136.0]);
        let lines = [
            placed("one", 110.0, 101.0),
            placed("two", 110.0, 113.0),
            placed("three", 110.0, 125.0),
        ];
        let items = page_items(&lines, &rules);
        assert!(
            items.iter().all(|i| matches!(i, PageItem::Line { .. })),
            "{items:?}"
        );
        // A frame of several boxes with text in only one of them.
        let rules = grid_rules(&[100.0, 110.0, 290.0, 300.0], &[100.0, 110.0, 130.0, 140.0]);
        let items = page_items(&[placed("Heading", 150.0, 115.0)], &rules);
        assert!(matches!(&items[..], [PageItem::Line { .. }]), "{items:?}");
    }

    #[test]
    fn columns_that_line_up_without_rules_are_a_table() {
        let row = |a: &str, b: &str, c: &str, y: f32| {
            let mut l = placed(&format!("{a} {b} {c}"), 100.0, y);
            // Wide gaps before the second and third columns.
            let n1 = a.chars().count();
            let n2 = n1 + 1 + b.chars().count();
            for (k, s) in l.spans.iter_mut().enumerate() {
                let shift = if k > n2 {
                    160.0
                } else if k > n1 {
                    80.0
                } else {
                    0.0
                };
                s.0 += shift;
                s.1 += shift;
            }
            l
        };
        let lines = vec![
            placed("Invoice", 100.0, 40.0),
            row("Item", "Qty", "Price", 100.0),
            row("Paper", "12", "3.50", 115.0),
            row("Ink", "1", "20.00", 130.0),
        ];
        let items = page_items(&lines, &[]);
        let PageItem::Table(t) = &items[1] else {
            panic!("{items:?}")
        };
        assert!(!t.ruled);
        assert_eq!(t.grid.len(), 3);
        assert_eq!(t.grid[2][2].as_ref().unwrap().text, "20.00");
        assert_eq!(t.grid[0][1].as_ref().unwrap().text, "Qty");
    }

    #[test]
    fn an_arabic_table_says_it_reads_right_to_left() {
        let rules = grid_rules(&[100.0, 200.0, 300.0], &[100.0, 120.0]);
        let lines = vec![
            placed("الكمية", 110.0, 105.0),
            placed("الصنف", 210.0, 105.0),
        ];
        let PageItem::Table(t) = &page_items(&lines, &rules)[0] else {
            panic!()
        };
        assert_eq!(t.direction, Direction::Rtl);
    }
}
