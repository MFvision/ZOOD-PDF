//! Shaping Arabic (and any script) for writing into PDFs, with `harfrust` (MIT) and
//! `unicode-bidi` visual reordering.
//!
//! [`shape`] returns glyphs in **visual** order (left to right) with advances and offsets in
//! points, and each glyph's cluster (byte offset of its source text). [`actual_text_spans`]
//! groups the glyphs per logical word so a writer can wrap each word in
//! `/Span <</ActualText (word)>> BDC … EMC`; the text then reads back in logical order in every
//! extractor, whatever glyph order and ligatures the font produced. We never write
//! `/Direction /R2L` (it makes PDFium read lines backwards).

use std::ops::Range;

use harfrust::{Direction, FontRef, ShapeOptions, ShaperData, UnicodeBuffer};
use serde::Serialize;
use unicode_bidi::ParagraphBidiInfo;

use crate::error::{Result, TextError};
use crate::limits;

/// One positioned glyph.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShapedGlyph {
    pub glyph_id: u32,
    /// Byte offset in the input text of the cluster this glyph belongs to.
    pub cluster: usize,
    /// Advance and offsets in points.
    pub x_advance: f64,
    pub y_advance: f64,
    pub x_offset: f64,
    pub y_offset: f64,
    /// The glyph comes from a right-to-left run.
    pub rtl: bool,
}

/// A shaped line of text.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShapedRun {
    pub text: String,
    pub size: f64,
    /// Glyphs in visual order (left to right).
    pub glyphs: Vec<ShapedGlyph>,
    /// Total advance in points.
    pub width: f64,
}

/// A contiguous group of glyphs (visual order) and the logical text they represent.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ActualTextSpan {
    pub text: String,
    pub glyphs: Range<usize>,
}

/// Shape one line of `text` with the font program `font_bytes` at `size` points.
pub fn shape(text: &str, font_bytes: &[u8], size: f64) -> Result<ShapedRun> {
    if text.len() > limits::MAX_SHAPE_BYTES {
        return Err(TextError::Limit("shape text length"));
    }
    if !(size.is_finite() && size > 0.0) {
        return Err(TextError::Params("font size must be positive".into()));
    }
    let font = FontRef::new(font_bytes).map_err(|e| TextError::Font(e.to_string()))?;
    let data = ShaperData::new(&font);
    let shaper = data.shaper(&font).build();
    let upem = f64::from(shaper.units_per_em().max(1));
    let scale = size / upem;
    let mut glyphs = Vec::new();
    let mut width = 0.0;
    if text.is_empty() {
        return Ok(ShapedRun {
            text: String::new(),
            size,
            glyphs,
            width,
        });
    }
    let info = ParagraphBidiInfo::new(text, None);
    let (levels, runs) = info.visual_runs(0..text.len());
    for run in runs {
        let Some(sub) = text.get(run.clone()) else {
            continue;
        };
        let rtl = levels.get(run.start).is_some_and(|l| l.is_rtl());
        let mut buf = UnicodeBuffer::new();
        buf.push_str(sub);
        buf.set_direction(if rtl {
            Direction::RightToLeft
        } else {
            Direction::LeftToRight
        });
        buf.guess_segment_properties();
        let out = shaper.shape(buf, ShapeOptions::new());
        for (gi, gp) in out.glyph_infos().iter().zip(out.glyph_positions()) {
            let g = ShapedGlyph {
                glyph_id: gi.glyph_id,
                cluster: run.start + gi.cluster as usize,
                x_advance: f64::from(gp.x_advance) * scale,
                y_advance: f64::from(gp.y_advance) * scale,
                x_offset: f64::from(gp.x_offset) * scale,
                y_offset: f64::from(gp.y_offset) * scale,
                rtl,
            };
            width += g.x_advance;
            glyphs.push(g);
        }
    }
    Ok(ShapedRun {
        text: text.to_string(),
        size,
        glyphs,
        width,
    })
}

/// Logical tokens of `text`: words and whitespace runs, as byte ranges.
fn tokens(text: &str) -> Vec<Range<usize>> {
    let mut out: Vec<Range<usize>> = Vec::new();
    let mut cur: Option<(usize, bool)> = None;
    for (i, c) in text.char_indices() {
        let ws = c.is_whitespace();
        match cur {
            Some((s, w)) if w == ws => {
                let _ = s;
            }
            Some((s, _)) => {
                out.push(s..i);
                cur = Some((i, ws));
            }
            None => cur = Some((i, ws)),
        }
    }
    if let Some((s, _)) = cur {
        out.push(s..text.len());
    }
    out
}

/// Group the glyphs of `run` per logical word (and per whitespace run) for `/ActualText`.
///
/// Spans are contiguous in visual order. If a word's glyphs are split (a word mixing
/// directions), the first piece carries the text and later pieces carry an empty string, so the
/// text is never duplicated on read-back.
pub fn actual_text_spans(run: &ShapedRun) -> Vec<ActualTextSpan> {
    let toks = tokens(&run.text);
    let token_of = |cluster: usize| toks.iter().position(|r| r.contains(&cluster));
    let mut spans: Vec<ActualTextSpan> = Vec::new();
    let mut used = vec![false; toks.len()];
    let mut cur: Option<(Option<usize>, usize)> = None;
    let mut close =
        |tok: Option<usize>, start: usize, end: usize, spans: &mut Vec<ActualTextSpan>| {
            let text = match tok {
                Some(t) => {
                    let first = !used.get(t).copied().unwrap_or(true);
                    if let Some(u) = used.get_mut(t) {
                        *u = true;
                    }
                    if first {
                        toks.get(t)
                            .and_then(|r| run.text.get(r.clone()))
                            .unwrap_or("")
                            .to_string()
                    } else {
                        String::new()
                    }
                }
                None => String::new(),
            };
            spans.push(ActualTextSpan {
                text,
                glyphs: start..end,
            });
        };
    for (i, g) in run.glyphs.iter().enumerate() {
        let t = token_of(g.cluster);
        match cur {
            Some((ct, _)) if ct == t => {}
            Some((ct, s)) => {
                close(ct, s, i, &mut spans);
                cur = Some((t, i));
            }
            None => cur = Some((t, i)),
        }
    }
    if let Some((ct, s)) = cur {
        close(ct, s, run.glyphs.len(), &mut spans);
    }
    spans
}

/// Encode a string as a PDF hex text string with a UTF-16BE BOM: `<FEFF…>`.
pub fn pdf_text_string_hex(s: &str) -> String {
    let mut out = String::from("<FEFF");
    for u in s.encode_utf16() {
        out.push_str(&format!("{u:04X}"));
    }
    out.push('>');
    out
}

fn fmt(v: f64) -> String {
    let r = (v * 1000.0).round() / 1000.0;
    if r == r.trunc() {
        format!("{}", r as i64)
    } else {
        format!("{r}")
    }
}

/// Content-stream operators drawing `run` at baseline origin `(x, y)` with the Type0
/// (Identity-H) font resource `font_res`, one `/ActualText` span per word.
pub fn content_stream(run: &ShapedRun, font_res: &str, x: f64, y: f64) -> Vec<u8> {
    let mut s = format!("BT\n/{font_res} {} Tf\n", fmt(run.size));
    let mut pen = x;
    let mut pen_y = y;
    let spans = actual_text_spans(run);
    for span in spans {
        s.push_str(&format!(
            "/Span <</ActualText {}>> BDC\n",
            pdf_text_string_hex(&span.text)
        ));
        for g in run.glyphs.get(span.glyphs.clone()).unwrap_or(&[]) {
            s.push_str(&format!(
                "1 0 0 1 {} {} Tm <{:04X}> Tj\n",
                fmt(pen + g.x_offset),
                fmt(pen_y + g.y_offset),
                g.glyph_id & 0xffff
            ));
            pen += g.x_advance;
            pen_y += g.y_advance;
        }
        s.push_str("EMC\n");
    }
    s.push_str("ET\n");
    s.into_bytes()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn amiri() -> Vec<u8> {
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../tests/corpus/fonts/amiri/Amiri-Regular.ttf"
        );
        std::fs::read(p).unwrap()
    }

    #[test]
    fn lam_alef_uses_ligature_forms() {
        let f = amiri();
        let run = shape("لا", &f, 20.0).unwrap();
        let lam = shape("ل", &f, 20.0).unwrap();
        let alef = shape("ا", &f, 20.0).unwrap();
        // Amiri builds lam-alef from two special ligature glyphs, not the isolated forms.
        assert_eq!(run.glyphs.len(), 2, "{:?}", run.glyphs);
        assert!(
            run.glyphs
                .iter()
                .all(|g| g.glyph_id != lam.glyphs[0].glyph_id
                    && g.glyph_id != alef.glyphs[0].glyph_id)
        );
        // Visual order: alef part on the left (cluster 2), lam part on the right (cluster 0).
        assert_eq!(
            run.glyphs.iter().map(|g| g.cluster).collect::<Vec<_>>(),
            vec![2, 0]
        );
        let spans = actual_text_spans(&run);
        assert_eq!(
            spans,
            vec![ActualTextSpan {
                text: "لا".into(),
                glyphs: 0..2
            }]
        );
    }

    #[test]
    fn tashkeel_marks_have_no_advance() {
        let run = shape("بَ", &amiri(), 20.0).unwrap();
        assert!(run.glyphs.len() >= 2);
        let marks: Vec<_> = run.glyphs.iter().filter(|g| g.x_advance == 0.0).collect();
        assert!(!marks.is_empty());
        // both glyphs belong to the same word span
        assert_eq!(actual_text_spans(&run).len(), 1);
    }

    #[test]
    fn mixed_digits_are_visual_ltr_inside_rtl() {
        let text = "عام 2024 و ٢٠٢٥";
        let run = shape(text, &amiri(), 12.0).unwrap();
        // Visual order: the rightmost glyph is the first logical letter (ع).
        let last = run.glyphs.last().unwrap();
        assert_eq!(last.cluster, 0);
        // European digits keep increasing clusters left to right.
        let digit_clusters: Vec<usize> = run
            .glyphs
            .iter()
            .filter(|g| (7..11).contains(&g.cluster))
            .map(|g| g.cluster)
            .collect();
        assert_eq!(digit_clusters, vec![7, 8, 9, 10]);
        let spans = actual_text_spans(&run);
        let words: Vec<&str> = spans
            .iter()
            .map(|s| s.text.as_str())
            .filter(|t| !t.trim().is_empty())
            .collect();
        // visual order of words, right-to-left reading reversed
        assert_eq!(words, vec!["٢٠٢٥", "و", "2024", "عام"]);
        assert!(run.width > 0.0);
    }

    #[test]
    fn bad_input_is_an_error_not_a_panic() {
        assert!(shape("x", b"not a font", 12.0).is_err());
        assert!(shape("x", &amiri(), f64::NAN).is_err());
        assert!(shape("", &amiri(), 12.0).unwrap().glyphs.is_empty());
    }

    #[test]
    fn hex_text_string() {
        assert_eq!(pdf_text_string_hex("لا"), "<FEFF06440627>");
    }
}
