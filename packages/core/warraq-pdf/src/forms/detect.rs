//! Where a flat form expects to be written on, found from what the page draws.
//!
//! A printed form shows its fields in a handful of ways, and each is read
//! here from Warraq's own view of the page — its glyphs, with their text
//! (the same extraction that reads Arabic in logical order), and its
//! axis-aligned lines (`warraq_render::Rule`):
//!
//! * a run of underscores or dots after a label — `الاسم: ________`, with
//!   `____/____/______` read as one date;
//! * a box drawn around nothing, or an empty cell of a table beside its label
//!   cell, or under a column's heading;
//! * a line drawn to write on, with its label beside or under it;
//! * a check box: a small empty square, drawn or typed (☐).
//!
//! Each becomes a proposal named after its label — the words beside it, on
//! the side the label's script reads from (right for Arabic, left for
//! English), or above or below it — typed from that label (a date, a Hijri
//! date, a signature) and aligned right to left when the label is Arabic.
//! Nothing here writes to the file; the person accepts, adjusts or removes
//! each proposal first (`fields::create_fields`).
//!
//! Everything is bounded: glyphs and lines past a limit are not read, and the
//! search for table cells stops after a fixed number of steps.
use warraq_text::{base_direction, reconstruct_lines, Direction, PositionedGlyph};

/// Glyphs read on one page at most.
const MAX_GLYPHS: usize = 20_000;
/// Distinct line positions per axis at most, for the cell search.
const MAX_POSITIONS: usize = 160;
/// Steps of the cell search at most.
const MAX_STEPS: usize = 2_000_000;
/// How far from a field its label may be, in points.
const LABEL_REACH: f32 = 260.0;

/// An axis-aligned line the page draws (see `warraq_render::Rule`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rule {
    pub horizontal: bool,
    pub at: f32,
    pub from: f32,
    pub to: f32,
}

/// What detection reads of one page. Everything is in the page as shown:
/// points from its top-left corner, y down.
pub struct PageInput<'a> {
    pub width: f32,
    pub height: f32,
    pub glyphs: &'a [PositionedGlyph],
    pub rules: &'a [Rule],
    /// The boxes of the page's pictures: a frame around a picture is no field.
    pub pictures: &'a [[f32; 4]],
    /// Widgets the page already has: no field is proposed over one.
    pub existing: &'a [[f32; 4]],
}

/// A field detection proposes.
#[derive(Debug, Clone, PartialEq)]
pub struct Proposal {
    /// `text`, `checkbox`, `date`, `hijri` or `signature`.
    pub kind: &'static str,
    pub name: String,
    /// The label as found, for the field's tooltip (`/TU`).
    pub tooltip: String,
    /// `[x0, top, x1, bottom]`.
    pub rect: [f32; 4],
    pub rtl: bool,
    /// What it was found from: `underscores`, `dots`, `cell`, `box`, `line`, `glyph`.
    pub source: &'static str,
    /// A date field's pattern.
    pub pattern: Option<String>,
}

/// A glyph as detection sees it: its box and its text.
#[derive(Debug, Clone)]
struct Mark {
    x0: f32,
    x1: f32,
    top: f32,
    bottom: f32,
    baseline: f32,
    size: f32,
    text: String,
    /// Index into the page's glyphs.
    index: usize,
}

impl Mark {
    fn cx(&self) -> f32 {
        (self.x0 + self.x1) / 2.0
    }
    fn cy(&self) -> f32 {
        (self.top + self.bottom) / 2.0
    }
}

fn is_underscore(t: &str) -> bool {
    matches!(t, "_" | "‗" | "＿" | "‾")
}

fn is_dot(t: &str) -> bool {
    matches!(t, "." | "…" | "·" | "․" | "‥" | "⋯")
}

fn is_box_glyph(t: &str) -> bool {
    matches!(
        t,
        "☐" | "□"
            | "▢"
            | "❏"
            | "❐"
            | "❑"
            | "❒"
            | "⬜"
            | "◻"
            | "◽"
            | "☑"
            | "☒"
            | "⧠"
            | "⬚"
    )
}

fn is_blank(t: &str) -> bool {
    t.chars().all(char::is_whitespace)
}

/// A candidate before it is named.
#[derive(Debug, Clone)]
struct Found {
    kind: &'static str,
    rect: [f32; 4],
    source: &'static str,
    pattern: Option<String>,
    /// For the label search: priority when two overlap (lower wins).
    rank: u8,
    /// The cell or box it fills, for the cells beside and above it.
    cell: Option<[f32; 4]>,
}

fn overlap(a: [f32; 4], b: [f32; 4]) -> f32 {
    let w = (a[2].min(b[2]) - a[0].max(b[0])).max(0.0);
    let h = (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
    w * h
}

fn area(a: [f32; 4]) -> f32 {
    (a[2] - a[0]).max(0.0) * (a[3] - a[1]).max(0.0)
}

fn inside(a: [f32; 4], x: f32, y: f32) -> bool {
    x >= a[0] && x <= a[2] && y >= a[1] && y <= a[3]
}

/// Two boxes are one field's when they overlap much, or one holds the
/// other's middle.
fn same_place(a: [f32; 4], b: [f32; 4]) -> bool {
    let shared = overlap(a, b);
    let union = area(a) + area(b) - shared;
    (union > 0.0 && shared / union > 0.3)
        || inside(a, (b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0)
        || inside(b, (a[0] + a[2]) / 2.0, (a[1] + a[3]) / 2.0)
}

/// Proposes fields for one page.
pub fn detect(page: &PageInput) -> Vec<Proposal> {
    let marks: Vec<Mark> = page
        .glyphs
        .iter()
        .take(MAX_GLYPHS)
        .enumerate()
        .filter(|(_, g)| g.angle.abs() < 0.05 && g.size > 1.0 && g.x.is_finite() && g.y.is_finite())
        .filter_map(|(index, g)| {
            let text = g.text.clone()?;
            let advance = if g.advance > 0.0 {
                g.advance
            } else {
                0.3 * g.size
            };
            Some(Mark {
                x0: g.x,
                x1: g.x + advance,
                top: g.y - 0.8 * g.size,
                bottom: g.y + 0.22 * g.size,
                baseline: g.y,
                size: g.size,
                text,
                index,
            })
        })
        .collect();
    let body = median(marks.iter().filter(|m| !is_blank(&m.text)).map(|m| m.size)).unwrap_or(11.0);

    let mut found: Vec<Found> = Vec::new();
    found.extend(box_glyphs(&marks));
    found.extend(blank_runs(&marks));
    let lines = merge_rules(page.rules);
    let cells = cells(&lines, page);
    found.extend(empty_cells(&cells, &marks, page));
    found.retain(|f| {
        f.cell.is_none_or(|c| {
            !page
                .pictures
                .iter()
                .any(|p| inside(c, (p[0] + p[2]) / 2.0, (p[1] + p[3]) / 2.0))
        })
    });
    found.extend(write_on_lines(&lines, &cells, &marks, body));

    // One proposal per place: glyph boxes, then blanks, then cells and
    // boxes, then lines. Nothing over a field the page already has.
    found.sort_by_key(|f| f.rank);
    let mut kept: Vec<Found> = Vec::new();
    for f in found {
        if page.existing.iter().any(|e| same_place(*e, f.rect)) {
            continue;
        }
        if kept.iter().any(|k| same_place(k.rect, f.rect)) {
            continue;
        }
        kept.push(f);
    }

    let rtl_page = {
        let rtl = marks
            .iter()
            .filter(|m| base_direction(&m.text) == Direction::Rtl)
            .count();
        let ltr = marks
            .iter()
            .filter(|m| m.text.chars().any(|c| c.is_ascii_alphabetic()))
            .count();
        rtl >= ltr
    };
    let regions: Vec<[f32; 4]> = kept.iter().map(|k| k.rect).collect();
    let named: Vec<(Proposal, Origin)> = kept
        .iter()
        .map(|f| name(f, &marks, page.glyphs, &regions, &cells, rtl_page))
        .collect();
    let (mut proposals, origins): (Vec<Proposal>, Vec<Origin>) = named.into_iter().unzip();
    label_checkboxes(&mut proposals, &marks, page.glyphs, &regions);
    // What only looks like a field on a page that is no form: a frame at
    // the page's edge, a rule under a heading, a page number's line.
    let keep: Vec<bool> = proposals
        .iter()
        .zip(&origins)
        .zip(&kept)
        .map(|((p, origin), f)| plausible(p, *origin, f, page))
        .collect();
    let mut keep = keep.into_iter();
    proposals.retain(|_| keep.next().unwrap_or(false));

    // Reading order: rows from the top, then along the row as the page reads.
    let row = |p: &Proposal| ((p.rect[1] + p.rect[3]) / 2.0 / 8.0).round() as i64;
    proposals.sort_by(|a, b| {
        row(a).cmp(&row(b)).then_with(|| {
            let (ax, bx) = (a.rect[0], b.rect[0]);
            if rtl_page {
                bx.total_cmp(&ax)
            } else {
                ax.total_cmp(&bx)
            }
        })
    });
    // Names nobody could find are numbered in that order.
    let mut unnamed = 0;
    for p in &mut proposals {
        if p.name.is_empty() {
            unnamed += 1;
            p.name = match (p.kind, rtl_page) {
                ("checkbox", true) => format!("خيار {unnamed}"),
                ("checkbox", false) => format!("Option {unnamed}"),
                (_, true) => format!("حقل {unnamed}"),
                (_, false) => format!("Field {unnamed}"),
            };
        }
    }
    proposals
}

fn median(values: impl Iterator<Item = f32>) -> Option<f32> {
    let mut v: Vec<f32> = values.filter(|x| x.is_finite()).collect();
    if v.is_empty() {
        return None;
    }
    v.sort_by(f32::total_cmp);
    Some(v[v.len() / 2])
}

/// ☐ and its kin, typed as text.
fn box_glyphs(marks: &[Mark]) -> Vec<Found> {
    marks
        .iter()
        .filter(|m| is_box_glyph(&m.text))
        .map(|m| {
            let side = (0.72 * m.size).clamp(6.0, 24.0);
            let (cx, cy) = ((m.x0 + m.x1) / 2.0, m.baseline - 0.33 * m.size);
            Found {
                kind: "checkbox",
                rect: [
                    cx - side / 2.0,
                    cy - side / 2.0,
                    cx + side / 2.0,
                    cy + side / 2.0,
                ],
                source: "glyph",
                pattern: None,
                rank: 0,
                cell: None,
            }
        })
        .collect()
}

/// Runs of underscores or dots, and dates written as `__/__/____`.
fn blank_runs(marks: &[Mark]) -> Vec<Found> {
    let mut blanks: Vec<&Mark> = marks
        .iter()
        .filter(|m| is_underscore(&m.text) || is_dot(&m.text))
        .collect();
    blanks.sort_by(|a, b| {
        ((a.baseline / 2.0).round() as i64)
            .cmp(&((b.baseline / 2.0).round() as i64))
            .then(a.x0.total_cmp(&b.x0))
    });
    // Runs: same kind, same baseline, touching.
    struct Run {
        x0: f32,
        x1: f32,
        baseline: f32,
        size: f32,
        dots: bool,
        count: usize,
        ellipses: usize,
    }
    let mut runs: Vec<Run> = Vec::new();
    for m in blanks {
        let dots = is_dot(&m.text);
        match runs.last_mut() {
            Some(r)
                if r.dots == dots
                    && (r.baseline - m.baseline).abs() < 0.3 * r.size.max(m.size)
                    && m.x0 - r.x1 < 0.6 * r.size.max(m.size)
                    && m.x0 >= r.x0 - 0.5 =>
            {
                r.x1 = r.x1.max(m.x1);
                r.count += 1;
                r.ellipses += usize::from(m.text != ".");
            }
            _ => runs.push(Run {
                x0: m.x0,
                x1: m.x1,
                baseline: m.baseline,
                size: m.size,
                dots,
                count: 1,
                ellipses: usize::from(m.text != "."),
            }),
        }
    }
    runs.retain(|r| {
        let width = r.x1 - r.x0;
        if r.dots {
            width >= 15.0 && (r.count >= 5 || r.ellipses >= 2)
        } else {
            width >= 12.0 && r.count >= 3
        }
    });
    // Runs on one baseline with only / or - between them are one date.
    let separator = |a: &Run, b: &Run| -> Option<char> {
        if (a.baseline - b.baseline).abs() > 0.3 * a.size
            || b.x0 - a.x1 > 2.5 * a.size
            || b.x0 < a.x1 - 0.5
        {
            return None;
        }
        let between: Vec<&Mark> = marks
            .iter()
            .filter(|m| {
                m.cx() > a.x1 - 0.5
                    && m.cx() < b.x0 + 0.5
                    && (m.baseline - a.baseline).abs() < 0.4 * a.size
                    && !is_blank(&m.text)
            })
            .collect();
        match between.as_slice() {
            [one] if matches!(one.text.as_str(), "/" | "-" | "–" | "." | "\\") => {
                one.text.chars().next()
            }
            _ => None,
        }
    };
    let mut out = Vec::new();
    let mut i = 0;
    while i < runs.len() {
        let mut j = i;
        let mut seps = Vec::new();
        while j + 1 < runs.len() {
            match separator(&runs[j], &runs[j + 1]) {
                Some(c) => {
                    seps.push(c);
                    j += 1;
                }
                None => break,
            }
        }
        let first = &runs[i];
        let last = &runs[j];
        let size = first.size;
        let height = (1.35 * size).clamp(12.0, 24.0);
        let bottom = first.baseline + 0.25 * size;
        let date = seps.len() >= 2;
        out.push(Found {
            kind: if date { "date" } else { "text" },
            rect: [first.x0, bottom - height, last.x1, bottom],
            source: if first.dots { "dots" } else { "underscores" },
            pattern: date.then(|| {
                let s = seps[0];
                format!("dd{s}mm{s}yyyy")
            }),
            rank: 1,
            cell: None,
        });
        i = j + 1;
    }
    out
}

/// Lines on one position of one axis merged where they touch.
#[derive(Debug, Clone)]
struct Lines {
    /// Positions (y of horizontals, x of verticals), and the covered spans
    /// at each, sorted.
    horizontal: Vec<(f32, Vec<(f32, f32)>)>,
    vertical: Vec<(f32, Vec<(f32, f32)>)>,
}

fn merge_axis(rules: &[&Rule]) -> Vec<(f32, Vec<(f32, f32)>)> {
    let mut sorted: Vec<&Rule> = rules.to_vec();
    sorted.sort_by(|a, b| a.at.total_cmp(&b.at));
    let mut out: Vec<(f32, Vec<(f32, f32)>)> = Vec::new();
    for r in sorted {
        match out.last_mut() {
            Some((at, spans)) if (r.at - *at).abs() <= 1.5 => spans.push((r.from, r.to)),
            _ => out.push((r.at, vec![(r.from, r.to)])),
        }
    }
    for (_, spans) in &mut out {
        spans.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut merged: Vec<(f32, f32)> = Vec::new();
        for &(a, b) in spans.iter() {
            match merged.last_mut() {
                Some(last) if a <= last.1 + 1.5 => last.1 = last.1.max(b),
                _ => merged.push((a, b)),
            }
        }
        *spans = merged;
    }
    out
}

fn merge_rules(rules: &[Rule]) -> Lines {
    let h: Vec<&Rule> = rules.iter().filter(|r| r.horizontal).collect();
    let v: Vec<&Rule> = rules.iter().filter(|r| !r.horizontal).collect();
    Lines {
        horizontal: merge_axis(&h),
        vertical: merge_axis(&v),
    }
}

/// Whether a line along `axis` at `at` covers `a..b`.
fn covers(axis: &[(f32, Vec<(f32, f32)>)], at: f32, a: f32, b: f32) -> bool {
    axis.iter()
        .filter(|(pos, _)| (pos - at).abs() <= 1.5)
        .any(|(_, spans)| spans.iter().any(|&(s, e)| s <= a + 1.5 && e >= b - 1.5))
}

/// The smallest rectangles the lines close: table cells and drawn boxes.
fn cells(lines: &Lines, page: &PageInput) -> Vec<[f32; 4]> {
    let xs: Vec<f32> = lines.vertical.iter().map(|(x, _)| *x).collect();
    let ys: Vec<f32> = lines.horizontal.iter().map(|(y, _)| *y).collect();
    if xs.len() > MAX_POSITIONS || ys.len() > MAX_POSITIONS {
        return Vec::new();
    }
    let h = &lines.horizontal;
    let v = &lines.vertical;
    let mut steps = 0usize;
    let mut out = Vec::new();
    'corners: for (i, &x0) in xs.iter().enumerate() {
        for (j, &y0) in ys.iter().enumerate() {
            if !covers(v, x0, y0, y0 + 2.0) {
                continue;
            }
            for &x1 in &xs[i + 1..] {
                steps += 1;
                if steps > MAX_STEPS {
                    break 'corners;
                }
                if !covers(h, y0, x0, x1) {
                    break;
                }
                if !covers(v, x1, y0, y0 + 2.0) {
                    continue;
                }
                let mut closed = None;
                for &y1 in &ys[j + 1..] {
                    steps += 1;
                    if !covers(v, x0, y0, y1) {
                        break;
                    }
                    if covers(v, x1, y0, y1) && covers(h, y1, x0, x1) {
                        closed = Some(y1);
                        break;
                    }
                }
                if let Some(y1) = closed {
                    out.push([x0, y0, x1, y1]);
                    break;
                }
            }
        }
    }
    let page_area = page.width * page.height;
    out.retain(|c| {
        let (w, h) = (c[2] - c[0], c[3] - c[1]);
        w >= 6.0 && (6.0..=200.0).contains(&h) && w * h <= 0.25 * page_area
    });
    out
}

/// Cells and boxes with nothing written in them.
fn empty_cells(cells: &[[f32; 4]], marks: &[Mark], _page: &PageInput) -> Vec<Found> {
    cells
        .iter()
        .filter(|c| {
            !marks.iter().any(|m| {
                !is_blank(&m.text)
                    && inside(
                        [c[0] + 1.0, c[1] + 1.0, c[2] - 1.0, c[3] - 1.0],
                        m.cx(),
                        m.cy(),
                    )
            })
        })
        // A cell with a box drawn in it: the box is the field, not the cell.
        .filter(|c| {
            !cells.iter().any(|inner| {
                inner != *c
                    && area(*inner) < 0.5 * area(**c)
                    && inside(
                        **c,
                        (inner[0] + inner[2]) / 2.0,
                        (inner[1] + inner[3]) / 2.0,
                    )
            })
        })
        .filter_map(|c| {
            let (w, h) = (c[2] - c[0], c[3] - c[1]);
            if w <= 26.0 && h <= 26.0 && w.max(h) / w.min(h) <= 1.35 {
                return Some(Found {
                    kind: "checkbox",
                    rect: *c,
                    source: "box",
                    pattern: None,
                    rank: 2,
                    cell: Some(*c),
                });
            }
            if h < 9.0 || w < 20.0 {
                return None;
            }
            let inset = 1.5;
            Some(Found {
                kind: "text",
                rect: [c[0] + inset, c[1] + inset, c[2] - inset, c[3] - inset],
                source: "cell",
                pattern: None,
                rank: 2,
                cell: Some(*c),
            })
        })
        .collect()
}

/// Lines drawn to write on: a horizontal line that is no side of a box, with
/// nothing written on it.
fn write_on_lines(lines: &Lines, cells: &[[f32; 4]], marks: &[Mark], body: f32) -> Vec<Found> {
    let mut out = Vec::new();
    for (y, spans) in &lines.horizontal {
        for &(a, b) in spans {
            if b - a < 30.0 {
                continue;
            }
            // A side of a cell or box is not a line to write on.
            let edge = cells.iter().any(|c| {
                ((c[1] - y).abs() <= 1.5 || (c[3] - y).abs() <= 1.5) && c[0] <= b && c[2] >= a
            });
            // Nor is a line with a vertical at its end (a table's border).
            let joined = lines.vertical.iter().any(|(x, vs)| {
                ((x - a).abs() <= 2.0 || (x - b).abs() <= 2.0)
                    && vs
                        .iter()
                        .any(|&(s, e)| s <= y + 2.0 && e >= y - 2.0 && e - s > 4.0)
            });
            if edge || joined {
                continue;
            }
            let height = (1.5 * body).clamp(14.0, 22.0);
            let rect = [a + 1.0, y - height, b - 1.0, y - 0.8];
            // Text on it: an underline, not a place to write.
            let written = marks.iter().any(|m| {
                !is_blank(&m.text)
                    && m.cx() > a
                    && m.cx() < b
                    && m.bottom > y - height
                    && m.top < y - 0.5
            });
            if written {
                continue;
            }
            out.push(Found {
                kind: "text",
                rect,
                source: "line",
                pattern: None,
                rank: 3,
                cell: None,
            });
        }
    }
    out
}

/// The logical text of some glyphs, through Warraq's own reader.
fn text_of(glyphs: &[PositionedGlyph], marks: &[&Mark]) -> String {
    let chosen: Vec<PositionedGlyph> = marks
        .iter()
        .filter_map(|m| glyphs.get(m.index).cloned())
        .collect();
    reconstruct_lines(&chosen)
        .into_iter()
        .map(|l| l.text)
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// The words beside a region on its row, going `rightwards` or leftwards,
/// until a wide gap, another field, or `LABEL_REACH`.
fn beside<'a>(
    region: [f32; 4],
    rightwards: bool,
    marks: &'a [Mark],
    others: &[[f32; 4]],
) -> Vec<&'a Mark> {
    let (top, bottom) = (region[1], region[3]);
    let mid = (top + bottom) / 2.0;
    let mut row: Vec<&Mark> = marks
        .iter()
        .filter(|m| {
            let shared = (m.bottom.min(bottom + 2.0) - m.top.max(top - 2.0)).max(0.0);
            let tall = (m.bottom - m.top).max(0.1);
            (shared / tall > 0.5 || (m.cy() - mid).abs() < 0.4 * m.size)
                && if rightwards {
                    m.x0 >= region[2] - 1.0 && m.x0 <= region[2] + LABEL_REACH
                } else {
                    m.x1 <= region[0] + 1.0 && m.x1 >= region[0] - LABEL_REACH
                }
        })
        .filter(|m| !is_underscore(&m.text) && !is_box_glyph(&m.text))
        .collect();
    if rightwards {
        row.sort_by(|a, b| a.x0.total_cmp(&b.x0));
    } else {
        row.sort_by(|a, b| b.x1.total_cmp(&a.x1));
    }
    let mut taken = Vec::new();
    let mut edge = if rightwards { region[2] } else { region[0] };
    for m in row {
        let gap = if rightwards { m.x0 - edge } else { edge - m.x1 };
        let limit = if taken.iter().all(|t: &&Mark| is_blank(&t.text)) {
            4.0
        } else {
            2.2
        } * m.size;
        if gap > limit {
            break;
        }
        // Another field in between ends the label.
        let (a, b) = if rightwards {
            (edge, m.x1)
        } else {
            (m.x0, edge)
        };
        if others.iter().any(|o| {
            *o != region && o[0] >= a - 0.5 && o[2] <= b + 0.5 && o[1] < m.bottom && o[3] > m.top
        }) {
            break;
        }
        if is_dot(&m.text) && taken.is_empty() {
            // Leftover leader dots right beside the field.
            edge = if rightwards { m.x1 } else { m.x0 };
            continue;
        }
        edge = if rightwards {
            m.x1.max(edge)
        } else {
            m.x0.min(edge)
        };
        taken.push(m);
    }
    taken
}

/// The text of the nearest line above a region, over its width.
fn above(region: [f32; 4], marks: &[Mark], reach: f32) -> Vec<&Mark> {
    let candidates: Vec<&Mark> = marks
        .iter()
        .filter(|m| {
            m.bottom <= region[1] + 1.0
                && m.bottom >= region[1] - reach
                && m.cx() >= region[0] - 2.0
                && m.cx() <= region[2] + 2.0
        })
        .collect();
    let Some(nearest) = candidates
        .iter()
        .filter(|m| !is_blank(&m.text))
        .map(|m| m.baseline)
        .max_by(f32::total_cmp)
    else {
        return Vec::new();
    };
    candidates
        .into_iter()
        .filter(|m| (m.baseline - nearest).abs() < 0.4 * m.size)
        .collect()
}

/// The text of the nearest line just under a region.
fn below(region: [f32; 4], marks: &[Mark], reach: f32) -> Vec<&Mark> {
    let candidates: Vec<&Mark> = marks
        .iter()
        .filter(|m| {
            m.top >= region[3] - 1.0
                && m.top <= region[3] + reach
                && m.cx() >= region[0] - 2.0
                && m.cx() <= region[2] + 2.0
        })
        .collect();
    let Some(nearest) = candidates
        .iter()
        .filter(|m| !is_blank(&m.text))
        .map(|m| m.baseline)
        .min_by(f32::total_cmp)
    else {
        return Vec::new();
    };
    candidates
        .into_iter()
        .filter(|m| (m.baseline - nearest).abs() < 0.4 * m.size)
        .collect()
}

/// A label as a field is named after it: without a trailing colon or
/// asterisk, and when it runs on, only the words nearest the field.
fn clean(label: &str, nearest_at_end: bool) -> String {
    let trimmed = label
        .trim()
        .trim_matches(|c: char| {
            c == ':'
                || c == '：'
                || c == '*'
                || c == '•'
                || c.is_whitespace()
                || c == '-'
                || c == '،'
        })
        .trim();
    // "العنوان: الحي" beside one field: the part nearest the field.
    let part = if nearest_at_end {
        trimmed
            .rsplit([':', '：', '.', '؛', ';'])
            .next()
            .unwrap_or(trimmed)
    } else {
        trimmed
            .split([':', '：', '.', '؛', ';'])
            .next()
            .unwrap_or(trimmed)
    };
    let words: Vec<&str> = part.split_whitespace().collect();
    let words = if words.len() > 5 {
        if nearest_at_end {
            words[words.len() - 5..].to_vec()
        } else {
            words[..5].to_vec()
        }
    } else {
        words
    };
    words.join(" ").chars().take(80).collect()
}

fn loose(text: &str) -> String {
    warraq_text::normalize_for_search(text, &warraq_text::SearchNormalization::default())
        .0
        .to_lowercase()
}

fn is_signature(label: &str) -> bool {
    let l = loose(label);
    ["توقيع", "امضاء", "signature", "sign here", "signed by"]
        .iter()
        .any(|w| l.contains(&loose(w)))
}

fn is_date(label: &str) -> bool {
    let l = loose(label);
    l.contains(&loose("تاريخ"))
        || l.split(|c: char| !c.is_alphanumeric())
            .any(|w| w == "date" || w == "dob")
        || l.contains("date of birth")
}

fn is_hijri(label: &str) -> bool {
    let l = loose(label);
    label.contains("هـ") || l.contains(&loose("هجري")) || l.contains("hijri")
}

/// Glyphs whose middle is inside a rectangle.
fn within(r: [f32; 4], marks: &[Mark]) -> Vec<&Mark> {
    marks.iter().filter(|m| inside(r, m.cx(), m.cy())).collect()
}

fn written_in(r: [f32; 4], marks: &[Mark]) -> bool {
    marks
        .iter()
        .any(|m| !is_blank(&m.text) && inside(r, m.cx(), m.cy()))
}

/// The cell beside `cell` in its row, on the right or the left.
fn neighbour(cell: [f32; 4], cells: &[[f32; 4]], right: bool) -> Option<[f32; 4]> {
    cells.iter().copied().find(|c| {
        let touching = if right {
            (c[0] - cell[2]).abs() <= 3.0
        } else {
            (c[2] - cell[0]).abs() <= 3.0
        };
        let shared = (c[3].min(cell[3]) - c[1].max(cell[1])).max(0.0);
        touching && shared >= 0.6 * (cell[3] - cell[1]).min(c[3] - c[1])
    })
}

/// The cell right above `cell`, of the same width.
fn cell_above(cell: [f32; 4], cells: &[[f32; 4]]) -> Option<[f32; 4]> {
    cells.iter().copied().find(|c| {
        (c[3] - cell[1]).abs() <= 3.0
            && (c[0] - cell[0]).abs() <= 3.0
            && (c[2] - cell[2]).abs() <= 3.0
    })
}

fn arabic(text: &str) -> bool {
    base_direction(text) == Direction::Rtl
}

/// Of the words on either side, the label: Arabic reads towards the field
/// from its right, English from its left.
fn either_side(right: String, left: String) -> Option<(String, bool)> {
    if arabic(&right) {
        Some((right, true))
    } else if !left.is_empty() && !arabic(&left) {
        Some((left, true))
    } else if !right.is_empty() {
        Some((right, false))
    } else if !left.is_empty() {
        Some((left, true))
    } else {
        None
    }
}

/// Where a proposal's label was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Origin {
    /// The cell beside it in a table, or its column's heading.
    Table,
    Beside,
    Above,
    Below,
    None,
}

fn words(text: &str) -> usize {
    text.split_whitespace().count()
}

fn has_letters(text: &str) -> bool {
    text.chars().any(char::is_alphabetic)
}

/// Whether a proposal is a field a form has, rather than a shape any page
/// has. Blanks and typed check boxes are always fields; drawn boxes and
/// lines need a label that reads like one.
fn plausible(p: &Proposal, origin: Origin, f: &Found, page: &PageInput) -> bool {
    let [x0, top, x1, bottom] = p.rect;
    let outside = (-x0).max(0.0)
        + (x1 - page.width).max(0.0)
        + (-top).max(0.0)
        + (bottom - page.height).max(0.0);
    if outside > 2.0 {
        return false;
    }
    if matches!(f.source, "underscores" | "dots" | "glyph") {
        return true;
    }
    let label = &p.tooltip;
    let colon = label.contains([':', '：']);
    let keyword = p.kind == "signature" || p.kind == "date" || p.kind == "hijri";
    // A sentence is not a box's label.
    if words(label) > 7 && !colon {
        return false;
    }
    match f.source {
        // A line to write on has a label that says so: with a colon, under
        // it, naming a signature or a date, or beside a line long enough to
        // write a name on — not a word beside a short rule.
        "line" => {
            let length = p.rect[2] - p.rect[0];
            has_letters(label)
                && (colon
                    || keyword
                    || (origin == Origin::Below && words(label) <= 3)
                    || (origin == Origin::Beside && length >= 80.0))
        }
        _ => {
            let Some(cell) = f.cell else { return true };
            // A frame at the page's edge is the page's, not a field's.
            let edge = 4.0;
            if cell[0] < edge
                || cell[1] < edge
                || cell[2] > page.width - edge
                || cell[3] > page.height - edge
            {
                return false;
            }
            // Boxes are named after words: an empty cell beside a dash is
            // an empty cell.
            has_letters(label) && (p.kind == "checkbox" || origin != Origin::None)
        }
    }
}

/// Names a candidate after its label and types it by that label. Check
/// boxes are named afterwards, a row at a time (`label_checkboxes`).
fn name(
    f: &Found,
    marks: &[Mark],
    glyphs: &[PositionedGlyph],
    regions: &[[f32; 4]],
    cells: &[[f32; 4]],
    rtl_page: bool,
) -> (Proposal, Origin) {
    // (label, whether its nearest words are at its logical end)
    let mut label: Option<(String, bool)> = None;
    let mut origin = Origin::None;
    let mut column = None;
    // A box drawn in a table's cell answers its row's question under its
    // column's heading: "سرعة الخدمة/ممتاز".
    if let (Some(boxed), "checkbox") = (f.cell, f.kind) {
        let (cx, cy) = ((boxed[0] + boxed[2]) / 2.0, (boxed[1] + boxed[3]) / 2.0);
        let holder = cells
            .iter()
            .copied()
            .filter(|c| *c != boxed && area(*c) > 1.5 * area(boxed) && inside(*c, cx, cy))
            .min_by(|a, b| area(*a).total_cmp(&area(*b)));
        if let Some(holder) = holder {
            let text = |c: [f32; 4]| text_of(glyphs, &within(c, marks));
            // The row's words: the nearest written cell on either side.
            let row_label = |right: bool| {
                let mut at = holder;
                for _ in 0..32 {
                    match neighbour(at, cells, right) {
                        Some(c) if written_in(c, marks) => return text(c),
                        Some(c) => at = c,
                        None => break,
                    }
                }
                String::new()
            };
            let mut heading = String::new();
            let mut up = holder;
            for _ in 0..64 {
                match cell_above(up, cells) {
                    Some(c) if written_in(c, marks) => {
                        heading = text(c);
                        break;
                    }
                    Some(c) => up = c,
                    None => break,
                }
            }
            let row = either_side(row_label(true), row_label(false))
                .map(|(t, _)| clean(&t, true))
                .unwrap_or_default();
            let heading = clean(&heading, false);
            let (name, tooltip) = match (row.is_empty(), heading.is_empty()) {
                (false, false) => (format!("{row}/{heading}"), format!("{row}: {heading}")),
                (false, true) => (row.clone(), row.clone()),
                (true, false) => (heading.clone(), heading.clone()),
                (true, true) => (String::new(), String::new()),
            };
            if !name.is_empty() {
                let proposal = Proposal {
                    kind: "checkbox",
                    rtl: arabic(&name),
                    name,
                    tooltip,
                    rect: f.rect,
                    source: f.source,
                    pattern: None,
                };
                return (proposal, Origin::Table);
            }
        }
    }
    if f.kind != "checkbox" {
        // A cell of a table: the label cell beside it, or its column's heading.
        if let Some(cell) = f.cell {
            let text = |c: Option<[f32; 4]>| {
                c.map(|c| text_of(glyphs, &within(c, marks)))
                    .unwrap_or_default()
            };
            label = either_side(
                text(neighbour(cell, cells, true)),
                text(neighbour(cell, cells, false)),
            );
            if label.is_some() {
                origin = Origin::Table;
            } else {
                let (mut up, mut n) = (cell, 1);
                for _ in 0..64 {
                    match cell_above(up, cells) {
                        Some(c) if written_in(c, marks) => {
                            label = Some((text_of(glyphs, &within(c, marks)), false));
                            origin = Origin::Table;
                            // The first row under a heading is 1, then 2…
                            column = Some(n);
                            break;
                        }
                        Some(c) => {
                            n += 1;
                            up = c;
                        }
                        None => break,
                    }
                }
            }
        }
        if label.is_none() {
            label = either_side(
                text_of(glyphs, &beside(f.rect, true, marks, regions)),
                text_of(glyphs, &beside(f.rect, false, marks, regions)),
            );
            if label.is_some() {
                origin = Origin::Beside;
            }
        }
        if label.is_none() {
            // A label over a box or a line to write on sits a line above it.
            let up = text_of(glyphs, &above(f.rect, marks, 36.0));
            let down = text_of(glyphs, &below(f.rect, marks, 18.0));
            (label, origin) = match (f.source, up.is_empty(), down.is_empty()) {
                ("line", _, false) => (Some((down, false)), Origin::Below),
                (_, false, _) => (Some((up, false)), Origin::Above),
                (_, true, false) => (Some((down, false)), Origin::Below),
                _ => (None, Origin::None),
            };
        }
    }
    let (raw, nearest_at_end) = label.unwrap_or_default();
    let tooltip = clean(&raw, nearest_at_end);
    // What the field is for is said by its label — or, in running text, by
    // the words right beside it: "جرى التوقيع في مدينة ____" is a city.
    let running = !raw.contains([':', '：']) && tooltip.split_whitespace().count() > 3;
    let deciding = if running {
        let words: Vec<&str> = tooltip.split_whitespace().collect();
        let n = words.len();
        if nearest_at_end {
            words[n - 2..].join(" ")
        } else {
            words[..2].join(" ")
        }
    } else {
        tooltip.clone()
    };
    let mut kind = f.kind;
    let mut pattern = f.pattern.clone();
    if kind != "checkbox" {
        if is_signature(&deciding) {
            kind = "signature";
            pattern = None;
        } else if is_date(&deciding) || kind == "date" {
            if is_hijri(&raw) {
                kind = "hijri";
                pattern = Some("dd/mm/yyyy هـ".into());
            } else {
                kind = "date";
                pattern = Some(pattern.unwrap_or_else(|| "dd/mm/yyyy".into()));
            }
        }
    }
    let name = match column {
        Some(n) if !tooltip.is_empty() => format!("{tooltip} {n}"),
        _ => tooltip.clone(),
    };
    let proposal = Proposal {
        kind,
        rtl: if tooltip.is_empty() {
            rtl_page
        } else {
            arabic(&tooltip)
        },
        name,
        tooltip: if raw.trim().is_empty() {
            String::new()
        } else {
            raw.trim().to_string()
        },
        rect: f.rect,
        source: f.source,
        pattern,
    };
    (proposal, origin)
}

/// A question and its answer: `الجنس: ذكر` → (الجنس, ذكر); `Gender:` →
/// (Gender, nothing); no colon, no question.
fn question_and_answer(text: &str) -> (Option<String>, String) {
    match text.rsplit_once([':', '：']) {
        Some((q, a)) if !q.trim().is_empty() => (Some(clean(q, true)), clean(a, false)),
        Some((_, a)) => (None, clean(a, false)),
        None => (None, clean(text, false)),
    }
}

/// Check boxes a row at a time. A row's words sit between its boxes, and
/// each box takes the words on one side of it — the same side for the whole
/// row: the side where the row's words run past its last box. So `☐ Male
/// ☐ Female` and `ذكر ☐ أنثى ☐` (whose words, right to left, come first)
/// take the words on their right, and `☐ اعتيادية ☐ مرضية` the words on their
/// left. A question before the answers — `الجنس:`, `Gender:` — names the
/// boxes `question/answer`.
fn label_checkboxes(
    proposals: &mut [Proposal],
    marks: &[Mark],
    glyphs: &[PositionedGlyph],
    regions: &[[f32; 4]],
) {
    // Those named already, in a table, keep their names.
    let boxes: Vec<usize> = (0..proposals.len())
        .filter(|&i| proposals[i].kind == "checkbox" && proposals[i].name.is_empty())
        .collect();
    let middle = |p: &Proposal| (p.rect[1] + p.rect[3]) / 2.0;
    let mut done = vec![false; proposals.len()];
    for &i in &boxes {
        if done[i] {
            continue;
        }
        let mut row: Vec<usize> = boxes
            .iter()
            .copied()
            .filter(|&j| !done[j] && (middle(&proposals[j]) - middle(&proposals[i])).abs() < 6.0)
            .collect();
        row.iter().for_each(|&j| done[j] = true);
        row.sort_by(|&a, &b| proposals[a].rect[0].total_cmp(&proposals[b].rect[0]));
        let k = row.len();
        // The words left of the row, between its boxes, and right of it.
        let mut words: Vec<String> = Vec::with_capacity(k + 1);
        let first = proposals[row[0]].rect;
        words.push(text_of(glyphs, &beside(first, false, marks, regions)));
        for pair in row.windows(2) {
            let (a, b) = (proposals[pair[0]].rect, proposals[pair[1]].rect);
            let (top, bottom) = (a[1].min(b[1]) - 2.0, a[3].max(b[3]) + 2.0);
            let between: Vec<&Mark> = marks
                .iter()
                .filter(|m| {
                    m.cx() > a[2] && m.cx() < b[0] && m.cy() > top - 4.0 && m.cy() < bottom + 4.0
                })
                .filter(|m| !is_box_glyph(&m.text))
                .collect();
            words.push(text_of(glyphs, &between));
        }
        let last = proposals[row[k - 1]].rect;
        words.push(text_of(glyphs, &beside(last, true, marks, regions)));

        let (left_q, left_a) = question_and_answer(&words[0]);
        let (right_q, right_a) = question_and_answer(&words[k]);
        let rightwards = !(right_a.is_empty() && !left_a.is_empty());
        let question = if rightwards {
            right_q.or(left_q)
        } else {
            left_q.or(right_q)
        };
        for (n, &j) in row.iter().enumerate() {
            let answer = match (rightwards, n) {
                (true, n) if n + 1 == k => right_a.clone(),
                (true, n) => clean(&words[n + 1], false),
                (false, 0) => left_a.clone(),
                (false, n) => clean(&words[n], false),
            };
            let p = &mut proposals[j];
            p.rtl = arabic(&answer) || question.as_deref().is_some_and(arabic);
            match &question {
                Some(q) if !answer.is_empty() => {
                    p.name = format!("{q}/{answer}");
                    p.tooltip = format!("{q}: {answer}");
                }
                Some(q) => {
                    p.name = q.clone();
                    p.tooltip = q.clone();
                }
                None => {
                    p.name = answer.clone();
                    p.tooltip = answer;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn glyph(text: &str, x: f32, y: f32, size: f32) -> PositionedGlyph {
        PositionedGlyph {
            x,
            y,
            angle: 0.0,
            size,
            advance: 0.5 * size,
            text: Some(text.to_string()),
            gid: 0,
            font: 0,
        }
    }

    /// A line of text laid out left to right from `x`, one glyph a character.
    fn line(text: &str, x: f32, y: f32) -> Vec<PositionedGlyph> {
        text.chars()
            .enumerate()
            .map(|(i, c)| glyph(&c.to_string(), x + i as f32 * 6.0, y, 12.0))
            .collect()
    }

    fn page<'a>(glyphs: &'a [PositionedGlyph], rules: &'a [Rule]) -> PageInput<'a> {
        PageInput {
            width: 600.0,
            height: 800.0,
            glyphs,
            rules,
            pictures: &[],
            existing: &[],
        }
    }

    #[test]
    fn underscores_after_an_english_label() {
        let glyphs = line("Full name: ______________  Date: __/__/____", 50.0, 100.0);
        let found = detect(&page(&glyphs, &[]));
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!(found[0].name, "Full name");
        assert_eq!(found[0].kind, "text");
        assert!(!found[0].rtl);
        assert_eq!(found[1].name, "Date");
        assert_eq!(found[1].kind, "date");
        assert_eq!(found[1].pattern.as_deref(), Some("dd/mm/yyyy"));
    }

    #[test]
    fn a_box_drawn_around_nothing_and_a_check_box() {
        let rules = [
            Rule {
                horizontal: true,
                at: 200.0,
                from: 100.0,
                to: 300.0,
            },
            Rule {
                horizontal: true,
                at: 220.0,
                from: 100.0,
                to: 300.0,
            },
            Rule {
                horizontal: false,
                at: 100.0,
                from: 200.0,
                to: 220.0,
            },
            Rule {
                horizontal: false,
                at: 300.0,
                from: 200.0,
                to: 220.0,
            },
            Rule {
                horizontal: true,
                at: 300.0,
                from: 50.0,
                to: 62.0,
            },
            Rule {
                horizontal: true,
                at: 312.0,
                from: 50.0,
                to: 62.0,
            },
            Rule {
                horizontal: false,
                at: 50.0,
                from: 300.0,
                to: 312.0,
            },
            Rule {
                horizontal: false,
                at: 62.0,
                from: 300.0,
                to: 312.0,
            },
        ];
        let mut glyphs = line("Email", 40.0, 215.0);
        glyphs.extend(line("I agree", 70.0, 310.0));
        let found = detect(&page(&glyphs, &rules));
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!(
            (found[0].kind, found[0].name.as_str(), found[0].source),
            ("text", "Email", "cell")
        );
        assert_eq!(
            (found[1].kind, found[1].name.as_str()),
            ("checkbox", "I agree")
        );
    }

    #[test]
    fn a_line_to_sign_on_with_its_label_under_it() {
        let rules = [Rule {
            horizontal: true,
            at: 500.0,
            from: 300.0,
            to: 450.0,
        }];
        let glyphs = line("Signature", 330.0, 515.0);
        let found = detect(&page(&glyphs, &rules));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!((found[0].kind, found[0].source), ("signature", "line"));
    }

    #[test]
    fn an_underlined_word_is_not_a_field() {
        let rules = [Rule {
            horizontal: true,
            at: 102.0,
            from: 50.0,
            to: 110.0,
        }];
        let glyphs = line("Important notice", 50.0, 100.0);
        assert!(detect(&page(&glyphs, &rules)).is_empty());
    }

    #[test]
    fn nothing_is_proposed_over_an_existing_field() {
        let glyphs = line("Name: ____________", 50.0, 100.0);
        let existing = [[100.0, 80.0, 200.0, 105.0]];
        let input = PageInput {
            existing: &existing,
            ..page(&glyphs, &[])
        };
        assert!(detect(&input).is_empty());
    }

    #[test]
    fn never_panics_and_is_bounded() {
        // A dense grid: many cells, all found within the step budget.
        let mut rules = Vec::new();
        for k in 0..100 {
            let at = 10.0 + k as f32 * 7.0;
            rules.push(Rule {
                horizontal: true,
                at,
                from: 0.0,
                to: 600.0,
            });
            rules.push(Rule {
                horizontal: false,
                at,
                from: 0.0,
                to: 800.0,
            });
        }
        let _ = detect(&page(&[], &rules));
        // Nonsense numbers.
        let rules = [
            Rule {
                horizontal: true,
                at: f32::NAN,
                from: 0.0,
                to: 1.0,
            },
            Rule {
                horizontal: false,
                at: 1e30,
                from: -1e30,
                to: 1e30,
            },
        ];
        let glyphs = vec![
            glyph("_", f32::INFINITY, 1.0, 12.0),
            glyph("☐", 1.0, f32::NAN, 12.0),
        ];
        let _ = detect(&page(&glyphs, &rules));
    }
}
