//! Shaped glyphs written as text-showing operators, so that what they say
//! can be read back.
//!
//! Runs of glyphs go in TJ arrays from a text matrix at their start; a glyph
//! the shaper moved (a mark, a cursive attachment) is placed on its own. A
//! word whose glyphs do not spell it one glyph at a time is marked with its
//! text as `/ActualText`, which PDFium, Acrobat and Warraq's own reader take
//! instead of the glyphs': Amiri draws some letters with two glyphs, of which
//! the second has no text, one glyph can stand for different letters in
//! different words, and a mark or an attached letter moved off the line
//! confuses the order a reader puts the letters in.
use std::ops::Range;

use lopdf::content::Operation;
use lopdf::{dictionary, Object, StringFormat};
use warraq_text::{clusters, ShapedGlyph, Shaper};

use crate::fonts::FontSubset;

/// One line of glyphs, in visual order, and where it goes.
pub(crate) struct ShownLine<'a> {
    pub glyphs: &'a [ShapedGlyph],
    /// The text matrix at the line's start; the font size is set by `Tf`.
    pub matrix: [f32; 6],
    pub size: f32,
    /// Advance added to each space, in thousandths of an em (justification).
    pub space_stretch: f32,
}

/// A run of a line's glyphs, and the text to read for them when theirs would
/// not do.
#[derive(Debug, PartialEq)]
pub(crate) struct Span {
    pub range: Range<usize>,
    pub actual_text: Option<String>,
}

fn is_space(g: &ShapedGlyph) -> bool {
    !g.text.is_empty() && g.text.chars().all(char::is_whitespace)
}

/// The line's words and spaces, each word with `/ActualText` when its glyphs
/// alone would not read back as it: a cluster of more than one glyph, a
/// glyph the ToUnicode map gives other text, or a glyph moved off the line.
pub(crate) fn spans(subset: &FontSubset, glyphs: &[ShapedGlyph]) -> Vec<Span> {
    let mut out = Vec::new();
    let mut word: Vec<Range<usize>> = Vec::new();
    let end_word = |word: &mut Vec<Range<usize>>, out: &mut Vec<Span>| {
        let (Some(first), Some(last)) = (word.first(), word.last()) else {
            return;
        };
        let range = first.start..last.end;
        let misread = word.iter().any(|cluster| {
            let g = &glyphs[cluster.start];
            cluster.len() > 1
                || subset.tounicode.get(&subset.cid(g.gid)) != Some(&g.text)
                || glyphs[cluster.clone()]
                    .iter()
                    .any(|g| g.x_offset != 0.0 || g.y_offset != 0.0)
        });
        // The word as it was typed: its clusters in the order of the text
        // they came from, whatever order they are laid out in.
        let actual_text = misread.then(|| {
            let mut typed: Vec<&ShapedGlyph> = word.iter().map(|c| &glyphs[c.start]).collect();
            typed.sort_by_key(|g| g.offset);
            typed.iter().map(|g| g.text.as_str()).collect::<String>()
        });
        out.push(Span { range, actual_text });
        word.clear();
    };
    for cluster in clusters(glyphs) {
        if is_space(&glyphs[cluster.start]) {
            end_word(&mut word, &mut out);
            out.push(Span {
                range: cluster,
                actual_text: None,
            });
        } else {
            word.push(cluster);
        }
    }
    end_word(&mut word, &mut out);
    out
}

/// A PDF text string: UTF-16BE with its byte order mark.
fn text_string(text: &str) -> Object {
    let mut bytes = vec![0xFE, 0xFF];
    for unit in text.encode_utf16() {
        bytes.extend(unit.to_be_bytes());
    }
    Object::String(bytes, StringFormat::Hexadecimal)
}

/// Writes `line`'s glyphs as text operators into `ops`, inside a text object.
pub(crate) fn show_line(
    ops: &mut Vec<Operation>,
    subset: &FontSubset,
    shaper: &Shaper,
    line: &ShownLine,
) {
    let [a, b, c, d, e, f] = line.matrix;
    // The text matrix `dx` along the line and `dy` up from its start.
    let at = |dx: f32, dy: f32| {
        Operation::new(
            "Tm",
            [a, b, c, d, e + dx * a + dy * c, f + dx * b + dy * d]
                .into_iter()
                .map(Object::Real)
                .collect(),
        )
    };
    let stretch = |g: &ShapedGlyph| {
        if is_space(g) {
            line.space_stretch
        } else {
            0.0
        }
    };
    // PDF advances by a glyph's own width: each is corrected to the shaped
    // advance, and a space widened by the stretch (a negative number in TJ
    // moves the pen on).
    let items = |run: &[&ShapedGlyph]| -> Vec<Object> {
        let mut items = Vec::with_capacity(run.len() * 2);
        for g in run {
            items.push(Object::String(
                subset.cid(g.gid).to_be_bytes().to_vec(),
                StringFormat::Hexadecimal,
            ));
            let adjust = shaper.advance(g.gid) - g.x_advance - stretch(g);
            if adjust.abs() > 0.01 {
                items.push(Object::Real(adjust));
            }
        }
        items
    };
    let scale = line.size / 1000.0;
    let mut pen = 0.0f32;
    let mut run: Vec<&ShapedGlyph> = Vec::new();
    let mut run_start = 0.0f32;
    let flush = |ops: &mut Vec<Operation>, run: &mut Vec<&ShapedGlyph>, start: f32| {
        if !run.is_empty() {
            ops.push(at(start, 0.0));
            ops.push(Operation::new("TJ", vec![Object::Array(items(run))]));
            run.clear();
        }
    };
    for span in spans(subset, line.glyphs) {
        if let Some(text) = &span.actual_text {
            flush(ops, &mut run, run_start);
            ops.push(Operation::new(
                "BDC",
                vec![
                    Object::Name(b"Span".to_vec()),
                    Object::Dictionary(dictionary! { "ActualText" => text_string(text) }),
                ],
            ));
        }
        for g in &line.glyphs[span.range.clone()] {
            if g.x_offset != 0.0 || g.y_offset != 0.0 {
                flush(ops, &mut run, run_start);
                ops.push(at(pen + g.x_offset * scale, g.y_offset * scale));
                ops.push(Operation::new("TJ", vec![Object::Array(items(&[g]))]));
            } else {
                if run.is_empty() {
                    run_start = pen;
                }
                run.push(g);
            }
            pen += (g.x_advance + stretch(g)) * scale;
        }
        if span.actual_text.is_some() {
            flush(ops, &mut run, run_start);
            ops.push(Operation::new("EMC", vec![]));
        }
    }
    flush(ops, &mut run, run_start);
}

#[cfg(test)]
mod tests {
    use super::*;

    const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");

    fn spans_of(text: &str) -> Vec<(String, Option<String>)> {
        let shaper = Shaper::new(AMIRI).unwrap();
        let glyphs = shaper.shape_line(text);
        let subset = FontSubset::build(AMIRI, &shaper, &glyphs).unwrap();
        spans(&subset, &glyphs)
            .into_iter()
            .map(|s| {
                let visual: String = glyphs[s.range].iter().map(|g| g.text.as_str()).collect();
                (visual, s.actual_text)
            })
            .collect()
    }

    #[test]
    fn a_word_whose_glyphs_do_not_spell_it_carries_its_text() {
        let spans = spans_of("لكن في الخير");
        // Visual order: the last word first.
        assert_eq!(spans.len(), 5, "{spans:?}");
        assert_eq!(spans[0].1.as_deref(), Some("الخير"), "kha is two glyphs");
        assert_eq!(spans[1], (" ".into(), None));
        assert_eq!(spans[2].1, None, "في reads back glyph by glyph");
        assert_eq!(spans[4].1.as_deref(), Some("لكن"), "lam is two glyphs");
    }

    #[test]
    fn a_word_with_a_moved_mark_carries_its_text_and_latin_reads_as_it_is() {
        let spans = spans_of("يتركَّز Warraq");
        let marked: Vec<&str> = spans.iter().filter_map(|s| s.1.as_deref()).collect();
        assert_eq!(marked, ["يتركَّز"]);
    }

    #[test]
    fn a_word_of_two_directions_carries_its_text_in_reading_order() {
        let spans = spans_of("العدد123 ثَمّ");
        let marked: Vec<&str> = spans.iter().filter_map(|s| s.1.as_deref()).collect();
        assert!(marked.contains(&"ثَمّ"), "{marked:?}");
        let shaper = Shaper::new(AMIRI).unwrap();
        let glyphs = shaper.shape_line("العدد123");
        let mut typed: Vec<&ShapedGlyph> = glyphs.iter().filter(|g| !g.text.is_empty()).collect();
        typed.sort_by_key(|g| g.offset);
        assert_eq!(
            typed.iter().map(|g| g.text.as_str()).collect::<String>(),
            "العدد123"
        );
    }

    #[test]
    fn marked_words_are_wrapped_and_the_rest_is_shown_in_runs() {
        let shaper = Shaper::new(AMIRI).unwrap();
        let glyphs = shaper.shape_line("لكن في");
        let subset = FontSubset::build(AMIRI, &shaper, &glyphs).unwrap();
        let mut ops = Vec::new();
        show_line(
            &mut ops,
            &subset,
            &shaper,
            &ShownLine {
                glyphs: &glyphs,
                matrix: [1.0, 0.0, 0.0, 1.0, 100.0, 700.0],
                size: 12.0,
                space_stretch: 0.0,
            },
        );
        let names: Vec<&str> = ops.iter().map(|op| op.operator.as_str()).collect();
        assert_eq!(names.iter().filter(|n| **n == "BDC").count(), 1);
        assert_eq!(names.iter().filter(|n| **n == "EMC").count(), 1);
        let shown: usize = ops
            .iter()
            .filter(|op| op.operator == "TJ")
            .flat_map(|op| op.operands[0].as_array().unwrap())
            .filter(|item| matches!(item, Object::String(..)))
            .count();
        assert_eq!(shown, glyphs.len(), "every glyph is shown once");
        assert_eq!(
            ops.first().map(|op| op.operator.as_str()),
            Some("Tm"),
            "the first run starts at the line's start"
        );
    }
}
