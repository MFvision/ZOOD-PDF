//! What Export needs from the core beyond a page's lines and paragraphs.
//!
//! - `export.cells` (Excel): each line of a page cut into the cells a table
//!   has, where the gap between two words is far wider than the line's own
//!   word spaces. The text of each cell is in reading order.
//! - `export.picture` (PowerPoint): the page drawn without its text, to go
//!   behind the slide's editable text boxes; and whether the page's text was
//!   invisible to begin with (a scan with a text layer), in which case the
//!   picture is the page as it is.
use serde::Deserialize;
use warraq_text::{base_direction, Direction, TextLine};

use super::{args, Reply};
use crate::{CoreError, Document};

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

#[derive(Deserialize)]
struct Page {
    page: usize,
}

#[derive(Deserialize)]
struct Picture {
    page: usize,
    scale: f32,
}

fn dir(d: Direction) -> &'static str {
    match d {
        Direction::Rtl => "rtl",
        Direction::Ltr => "ltr",
    }
}

pub fn call(
    doc: &mut Document,
    name: &str,
    json: &str,
    _: Vec<Vec<u8>>,
) -> Result<Reply, CoreError> {
    match name {
        "cells" => {
            let a: Page = args(json)?;
            let lines: Vec<serde_json::Value> = doc
                .text_lines(a.page)?
                .iter()
                .map(|line| {
                    let cells: Vec<serde_json::Value> = line_cells(line)
                        .into_iter()
                        .map(|c| serde_json::json!({ "text": c.text, "x0": c.x0, "x1": c.x1, "direction": dir(c.direction) }))
                        .collect();
                    serde_json::json!({
                        "text": line.text, "x": line.x, "y": line.y, "width": line.width,
                        "height": line.height, "direction": dir(line.direction), "cells": cells,
                    })
                })
                .collect();
            Reply::of(&serde_json::json!({ "lines": lines }))
        }
        "picture" => {
            let a: Picture = args(json)?;
            let (bitmap, hidden) = doc.render_without_text(a.page, a.scale)?;
            Ok(Reply::of(&serde_json::json!({
                "width": bitmap.width, "height": bitmap.height, "textHidden": hidden,
            }))?
            .with_blob(bitmap.rgba))
        }
        _ => Err(CoreError::UnknownOp(format!("export.{name}"))),
    }
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
}
