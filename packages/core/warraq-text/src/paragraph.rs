//! Paragraph detection and line layout: what an editor needs before it can
//! reflow Arabic text (brief §5, ADR-0005).
use crate::bidi::Direction;
use crate::extract::TextLine;
use crate::shape::{ShapedGlyph, Shaper};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Alignment {
    Start,
    End,
    Center,
    Justify,
}

/// A run of lines that belong together: same script direction, comparable font
/// size, consistent edges and regular leading.
#[derive(Debug, Clone, PartialEq)]
pub struct Paragraph {
    /// Indices into the slice given to [`detect_paragraphs`].
    pub lines: Vec<usize>,
    pub direction: Direction,
    pub alignment: Alignment,
    /// Union of the lines' boxes: (x, y, width, height), y growing downwards.
    pub bbox: (f32, f32, f32, f32),
    /// Distance between consecutive baselines.
    pub leading: f32,
    pub font_size: f32,
    /// Logical text, lines joined with a space (a soft break, not a paragraph break).
    pub text: String,
}

/// Reads one edge (start or end) of a line, chosen by paragraph direction.
type EdgeFn = fn(&TextLine) -> f32;

fn close(a: f32, b: f32, tol: f32) -> bool {
    (a - b).abs() <= tol
}

/// Whether a line's text finishes a sentence: its last letter, past closing
/// quotes and brackets, is a full stop, a question or exclamation mark, a
/// colon or an ellipsis — Arabic, Urdu or Latin.
fn ends_sentence(text: &str) -> bool {
    text.trim_end()
        .trim_end_matches([
            '"', '\'', '»', '”', '’', ')', ']', '›', '\u{200F}', '\u{200E}',
        ])
        .ends_with(['.', '؟', '?', '!', '۔', ':', '…'])
}

/// Group lines (as returned by `reconstruct_lines`, ordered top to bottom) into paragraphs.
///
/// First the column: lines of one direction and size, a line's height or so
/// apart, one under the other. Then its paragraphs, which a space between
/// them marks, and which, set without one, end after a short line that
/// finishes a sentence, or before a line indented from a full one.
pub fn detect_paragraphs(lines: &[TextLine]) -> Vec<Paragraph> {
    let mut out: Vec<Paragraph> = vec![];
    let mut start = 0usize;
    while start < lines.len() {
        let mut end = start + 1;
        while end < lines.len() && same_column(&lines[end - 1], &lines[end]) {
            end += 1;
        }
        for range in paragraphs_in(&lines[start..end]) {
            out.push(paragraph_of(lines, start + range.start..start + range.end));
        }
        start = end;
    }
    out
}

/// Whether `c` follows `p` down the same column: the same direction and
/// size, a line's height or so below, and side by side with it.
fn same_column(p: &TextLine, c: &TextLine) -> bool {
    let size = p.height.max(c.height) / 1.2;
    let gap = c.y - p.y;
    let overlap = (p.x + p.width).min(c.x + c.width) - p.x.max(c.x);
    p.direction == c.direction
        && close(p.height, c.height, 0.3 * p.height.max(1.0))
        && gap > 0.2 * size
        && gap < 2.2 * size
        && overlap >= 0.5 * p.width.min(c.width)
}

/// The paragraphs of one column, as ranges of its lines.
fn paragraphs_in(column: &[TextLine]) -> Vec<std::ops::Range<usize>> {
    let direction = column[0].direction;
    // Reading order's start edge: the right one for RTL.
    let (start_edge, end_edge): (EdgeFn, EdgeFn) = match direction {
        Direction::Rtl => (|l| l.x + l.width, |l| l.x),
        Direction::Ltr => (|l| l.x, |l| l.x + l.width),
    };
    let x0 = column.iter().map(|l| l.x).fold(f32::MAX, f32::min);
    let x1 = column
        .iter()
        .map(|l| l.x + l.width)
        .fold(f32::MIN, f32::max);
    let (column_start, column_end) = match direction {
        Direction::Rtl => (x1, x0),
        Direction::Ltr => (x0, x1),
    };
    let widest = column.iter().map(|l| l.width).fold(0.0, f32::max);
    // How far a line starts in from the column's start.
    let indent = |l: &TextLine| (start_edge(l) - column_start).abs();
    let mut parts = vec![];
    let mut from = 0;
    for i in 1..column.len() {
        let (p, c) = (&column[i - 1], &column[i]);
        let size = p.height.max(c.height) / 1.2;
        let tol = 0.6 * size.max(1.0);
        // One edge must line up: with the line above, or the column's.
        let aligned = close(start_edge(p), start_edge(c), tol)
            || close(end_edge(p), end_edge(c), tol)
            || close(start_edge(c), column_start, tol)
            || close(end_edge(c), column_end, tol);
        let finished = p.width < 0.8 * widest && ends_sentence(&p.text);
        let indented = (size..=6.0 * size).contains(&indent(c)) && indent(p) < 0.3 * size;
        if !aligned || finished || indented {
            parts.push(from..i);
            from = i;
        }
    }
    parts.push(from..column.len());
    parts
}

/// The paragraph of `lines[range]`: its box, direction, alignment and text.
fn paragraph_of(lines: &[TextLine], range: std::ops::Range<usize>) -> Paragraph {
    let group = &lines[range.clone()];
    let x0 = group.iter().map(|l| l.x).fold(f32::MAX, f32::min);
    let x1 = group.iter().map(|l| l.x + l.width).fold(f32::MIN, f32::max);
    let y0 = group.iter().map(|l| l.y).fold(f32::MAX, f32::min);
    let y1 = group
        .iter()
        .map(|l| l.y + l.height)
        .fold(f32::MIN, f32::max);
    let direction = group[0].direction;
    let size = group.iter().map(|l| l.height / 1.2).fold(0.0, f32::max);
    let leading = if group.len() > 1 {
        (group[1].y - group[0].y).abs()
    } else {
        size * 1.2
    };
    // Justification needs at least two full lines to be visible (the last line of a
    // paragraph is short whatever the alignment), so it is decided on the body; every
    // other alignment is decided on all lines, since a short last line still shares the
    // edge it is aligned to.
    let body = if group.len() > 2 {
        &group[..group.len() - 1]
    } else {
        group
    };
    let tol = 0.25 * size.max(1.0);
    let justified = group.len() > 2
        && body.iter().all(|l| close(l.x, x0, tol))
        && body.iter().all(|l| close(l.x + l.width, x1, tol));
    let (start_edge, end_edge): (EdgeFn, EdgeFn) = match direction {
        Direction::Rtl => (|l| l.x + l.width, |l| l.x),
        Direction::Ltr => (|l| l.x, |l| l.x + l.width),
    };
    let (start_target, end_target) = match direction {
        Direction::Rtl => (x1, x0),
        Direction::Ltr => (x0, x1),
    };
    let center = x0 + (x1 - x0) / 2.0;
    let alignment = if justified {
        Alignment::Justify
    } else if group
        .iter()
        .all(|l| close(start_edge(l), start_target, tol))
    {
        Alignment::Start
    } else if group.iter().all(|l| close(end_edge(l), end_target, tol)) {
        Alignment::End
    } else if group
        .iter()
        .all(|l| close(l.x + l.width / 2.0, center, tol))
    {
        Alignment::Center
    } else {
        Alignment::Start
    };
    Paragraph {
        lines: range.collect(),
        direction,
        alignment,
        bbox: (x0, y0, x1 - x0, y1 - y0),
        leading,
        font_size: size,
        text: group
            .iter()
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>()
            .join(" "),
    }
}

/// One line produced by [`layout_paragraph`]: shaped glyphs plus the pen origin.
#[derive(Debug, Clone)]
pub struct LaidOutLine {
    pub text: String,
    pub glyphs: Vec<ShapedGlyph>,
    /// Pen start in text space (the left end of the line, whatever the direction).
    pub x: f32,
    pub y: f32,
    /// Extra advance added to each space for justification, in 1/1000 em.
    pub space_stretch: f32,
    pub width: f32,
}

/// Where a reflowed paragraph goes, in the coordinate space of the caller.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayoutBox {
    pub left: f32,
    pub right: f32,
    /// Baseline of the first line; later lines step by `LayoutStyle::leading`
    /// (negative when the coordinate space has y growing upwards, as PDF does).
    pub first_baseline: f32,
}

/// How a reflowed paragraph is typeset.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayoutStyle {
    pub font_size: f32,
    pub leading: f32,
    pub direction: Direction,
    pub alignment: Alignment,
}

/// Break `text` into lines no wider than the box and place them according to the
/// style. For an RTL paragraph the lines are pinned to the box's right edge.
///
/// Breaking happens at spaces only: Arabic and Latin both break there, and the
/// full UAX #14 line-breaking (ICU) is a later refinement, tracked in STATUS.
pub fn layout_paragraph(
    shaper: &Shaper,
    text: &str,
    area: &LayoutBox,
    style: &LayoutStyle,
) -> Vec<LaidOutLine> {
    let (font_size, leading, direction, alignment) = (
        style.font_size,
        style.leading,
        style.direction,
        style.alignment,
    );
    let (x_left, x_right, y_first) = (area.left, area.right, area.first_baseline);
    let max_width = (x_right - x_left).max(1.0);
    let width_of = |s: &str| -> (Vec<ShapedGlyph>, f32) {
        let g = shaper.shape_line(s);
        let w = g.iter().map(|g| g.x_advance).sum::<f32>() * font_size / 1000.0;
        (g, w)
    };
    // greedy first-fit on space boundaries
    let words: Vec<&str> = text.split(' ').filter(|w| !w.is_empty()).collect();
    let mut raw_lines: Vec<String> = vec![];
    let mut cur = String::new();
    for w in words {
        let candidate = if cur.is_empty() {
            w.to_string()
        } else {
            format!("{cur} {w}")
        };
        if !cur.is_empty() && width_of(&candidate).1 > max_width {
            raw_lines.push(std::mem::take(&mut cur));
            cur = w.to_string();
        } else {
            cur = candidate;
        }
    }
    if !cur.is_empty() {
        raw_lines.push(cur);
    }
    let last = raw_lines.len().saturating_sub(1);
    raw_lines
        .into_iter()
        .enumerate()
        .map(|(i, line)| {
            let (glyphs, w) = width_of(&line);
            let spaces = glyphs.iter().filter(|g| g.text == " ").count();
            let justify = alignment == Alignment::Justify && i != last && spaces > 0;
            let space_stretch = if justify {
                (max_width - w) / spaces as f32 * 1000.0 / font_size
            } else {
                0.0
            };
            let effective = if justify { max_width } else { w };
            let x = match (alignment, direction) {
                (Alignment::Justify, _) => {
                    if direction == Direction::Rtl {
                        x_right - effective
                    } else {
                        x_left
                    }
                }
                (Alignment::Center, _) => x_left + (x_right - x_left - effective) / 2.0,
                (Alignment::Start, Direction::Rtl) | (Alignment::End, Direction::Ltr) => {
                    x_right - effective
                }
                _ => x_left,
            };
            LaidOutLine {
                text: line,
                glyphs,
                x,
                y: y_first + i as f32 * leading,
                space_stretch,
                width: effective,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");

    fn line(text: &str, x: f32, y: f32, w: f32, dir: Direction) -> TextLine {
        TextLine {
            text: text.into(),
            x,
            y,
            width: w,
            height: 12.0,
            direction: dir,
        }
    }

    #[test]
    fn justified_rtl_block_is_one_paragraph_with_both_edges_aligned() {
        let lines = vec![
            line("السطر الأول من الفقرة", 100.0, 100.0, 400.0, Direction::Rtl),
            line(
                "السطر الثاني من الفقرة",
                100.0,
                120.0,
                400.0,
                Direction::Rtl,
            ),
            line("آخر سطر قصير", 320.0, 140.0, 180.0, Direction::Rtl),
        ];
        let p = detect_paragraphs(&lines);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].lines, vec![0, 1, 2]);
        assert_eq!(p[0].direction, Direction::Rtl);
        assert_eq!(p[0].alignment, Alignment::Justify);
        assert_eq!(p[0].leading, 20.0);
        assert_eq!(p[0].bbox, (100.0, 100.0, 400.0, 52.0));
        assert!(p[0].text.starts_with("السطر الأول"));
    }

    #[test]
    fn evenly_spaced_paragraphs_part_after_a_short_line_that_ends_a_sentence() {
        // Two justified paragraphs, the same 20 pt from line to line
        // throughout: nothing but the first one's short, finished last line
        // says where it ends.
        let lines = vec![
            line(
                "السطر الأول من الفقرة الأولى",
                100.0,
                100.0,
                400.0,
                Direction::Rtl,
            ),
            line(
                "السطر الثاني من الفقرة الأولى",
                100.0,
                120.0,
                400.0,
                Direction::Rtl,
            ),
            line("وآخر سطر منها.", 330.0, 140.0, 170.0, Direction::Rtl),
            line(
                "الفقرة الثانية تبدأ من الحافة",
                100.0,
                160.0,
                400.0,
                Direction::Rtl,
            ),
            line("وتنتهي هنا؟", 380.0, 180.0, 120.0, Direction::Rtl),
        ];
        let p = detect_paragraphs(&lines);
        let parts: Vec<Vec<usize>> = p.iter().map(|p| p.lines.clone()).collect();
        assert_eq!(parts, vec![vec![0, 1, 2], vec![3, 4]]);
        assert_eq!(p[0].alignment, Alignment::Justify);
        assert_eq!(p[1].text, "الفقرة الثانية تبدأ من الحافة وتنتهي هنا؟");
    }

    #[test]
    fn an_indented_line_after_a_full_one_starts_a_paragraph() {
        let lines = vec![
            line(
                "The first paragraph runs to",
                124.0,
                100.0,
                376.0,
                Direction::Ltr,
            ),
            line(
                "the very edge of the column and",
                100.0,
                120.0,
                400.0,
                Direction::Ltr,
            ),
            line(
                "ends exactly at the edge as well",
                100.0,
                140.0,
                400.0,
                Direction::Ltr,
            ),
            line(
                "The second begins indented",
                124.0,
                160.0,
                376.0,
                Direction::Ltr,
            ),
            line("and carries on", 100.0, 180.0, 150.0, Direction::Ltr),
        ];
        let parts: Vec<Vec<usize>> = detect_paragraphs(&lines)
            .iter()
            .map(|p| p.lines.clone())
            .collect();
        assert_eq!(parts, vec![vec![0, 1, 2], vec![3, 4]]);
    }

    #[test]
    fn short_lines_that_do_not_end_a_sentence_stay_together() {
        // An address, a list of names: short lines, no full stops.
        let lines = vec![
            line("شركة وراق للبرمجيات", 300.0, 100.0, 200.0, Direction::Rtl),
            line("طريق الملك فهد", 380.0, 120.0, 120.0, Direction::Rtl),
            line("الرياض", 440.0, 140.0, 60.0, Direction::Rtl),
        ];
        assert_eq!(detect_paragraphs(&lines).len(), 1);
    }

    #[test]
    fn a_far_away_line_and_a_direction_change_start_new_paragraphs() {
        let lines = vec![
            line("فقرة أولى", 100.0, 100.0, 300.0, Direction::Rtl),
            line("سطر ثان", 100.0, 118.0, 300.0, Direction::Rtl),
            line("A different block", 100.0, 300.0, 300.0, Direction::Ltr),
        ];
        let p = detect_paragraphs(&lines);
        assert_eq!(p.len(), 2);
        assert_eq!(p[1].direction, Direction::Ltr);
    }

    #[test]
    fn right_aligned_rtl_paragraph_is_detected_as_start_aligned() {
        let lines = vec![
            line("سطر طويل نسبياً", 200.0, 100.0, 300.0, Direction::Rtl),
            line("سطر أقصر", 350.0, 120.0, 150.0, Direction::Rtl),
        ];
        assert_eq!(detect_paragraphs(&lines)[0].alignment, Alignment::Start);
    }

    #[test]
    fn layout_breaks_at_spaces_and_right_aligns_rtl_lines() {
        let s = Shaper::new(AMIRI).unwrap();
        let text = "وراق محرر ملفات مفتوح المصدر يعمل دون حساب ويحفظ المستندات على جهاز المستخدم";
        let area = LayoutBox {
            left: 100.0,
            right: 300.0,
            first_baseline: 50.0,
        };
        let style = LayoutStyle {
            font_size: 14.0,
            leading: 20.0,
            direction: Direction::Rtl,
            alignment: Alignment::Start,
        };
        let lines = layout_paragraph(&s, text, &area, &style);
        assert!(
            lines.len() > 2,
            "expected several lines, got {}",
            lines.len()
        );
        for l in &lines {
            assert!(l.width <= 200.5, "line too wide: {} ({})", l.width, l.text);
            // RTL start alignment pins the RIGHT edge of every line
            assert!(
                (l.x + l.width - 300.0).abs() < 0.5,
                "line not right-aligned: x={} w={}",
                l.x,
                l.width
            );
        }
        assert_eq!(lines[0].y, 50.0);
        assert_eq!(lines[1].y, 70.0);
        // the reflowed text is the input again
        assert_eq!(
            lines
                .iter()
                .map(|l| l.text.clone())
                .collect::<Vec<_>>()
                .join(" "),
            text
        );
    }

    #[test]
    fn justification_stretches_spaces_on_every_line_but_the_last() {
        let s = Shaper::new(AMIRI).unwrap();
        let text = "وراق محرر ملفات مفتوح المصدر يعمل دون حساب ويحفظ المستندات على جهاز المستخدم";
        let area = LayoutBox {
            left: 100.0,
            right: 300.0,
            first_baseline: 50.0,
        };
        let style = LayoutStyle {
            font_size: 14.0,
            leading: 20.0,
            direction: Direction::Rtl,
            alignment: Alignment::Justify,
        };
        let lines = layout_paragraph(&s, text, &area, &style);
        let last = lines.len() - 1;
        for (i, l) in lines.iter().enumerate() {
            if i == last {
                assert_eq!(l.space_stretch, 0.0);
            } else {
                assert!(l.space_stretch > 0.0, "line {i} not stretched");
                assert!(
                    (l.width - 200.0).abs() < 0.01,
                    "justified line width {}",
                    l.width
                );
            }
        }
    }
}
