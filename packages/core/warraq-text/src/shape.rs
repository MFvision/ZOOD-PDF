//! OpenType shaping with HarfRust, metrics with skrifa. Units: 1/1000 em.
use crate::bidi::{visual_runs, Direction};
use harfrust::{BufferClusterLevel, Feature, ShapeOptions, ShaperData, Tag, UnicodeBuffer};
use skrifa::instance::{LocationRef, Size};
use skrifa::raw::TableProvider;
use skrifa::{GlyphId, MetadataProvider};

#[derive(Debug, thiserror::Error)]
pub enum ShapeError {
    #[error("font data could not be parsed")]
    BadFont,
}

/// One shaped glyph in visual order. `text` is the logical text of its cluster
/// (several characters for a ligature, empty for a glyph that continues a cluster).
#[derive(Debug, Clone, PartialEq)]
pub struct ShapedGlyph {
    pub gid: u16,
    pub text: String,
    /// Where the glyph's cluster starts in the text that was shaped, in
    /// bytes: the reading order of glyphs laid out in visual order.
    pub offset: usize,
    pub x_advance: f32,
    pub x_offset: f32,
    pub y_offset: f32,
}

/// The clusters of a shaped line, as ranges of its glyphs: a glyph carrying
/// text, then the glyphs after it that carry none. That is how `shape_run`
/// hands out a cluster's text — to its first glyph — and a cluster's glyphs
/// are adjacent at the cluster level it shapes with.
pub fn clusters(glyphs: &[ShapedGlyph]) -> Vec<std::ops::Range<usize>> {
    let mut out: Vec<std::ops::Range<usize>> = Vec::new();
    for (i, g) in glyphs.iter().enumerate() {
        match out.last_mut() {
            Some(last) if g.text.is_empty() => last.end = i + 1,
            _ => out.push(i..i + 1),
        }
    }
    out
}

pub struct Shaper<'a> {
    hb: harfrust::FontRef<'a>,
    sk: skrifa::FontRef<'a>,
    data: ShaperData,
    upem: f32,
}

impl<'a> Shaper<'a> {
    pub fn new(font: &'a [u8]) -> Result<Self, ShapeError> {
        let hb = harfrust::FontRef::from_index(font, 0).map_err(|_| ShapeError::BadFont)?;
        let sk = skrifa::FontRef::new(font).map_err(|_| ShapeError::BadFont)?;
        let upem = sk.head().map_err(|_| ShapeError::BadFont)?.units_per_em() as f32;
        let data = ShaperData::new(&hb);
        Ok(Self { hb, sk, data, upem })
    }

    pub fn units_per_em(&self) -> f32 {
        self.upem
    }

    /// Advance width of a glyph in 1/1000 em.
    pub fn advance(&self, gid: u16) -> f32 {
        self.sk
            .glyph_metrics(Size::unscaled(), LocationRef::default())
            .advance_width(GlyphId::new(gid as u32))
            .unwrap_or(0.0)
            * 1000.0
            / self.upem
    }

    /// True when the font's cmap covers every non-mark, non-control character.
    pub fn covers(&self, text: &str) -> bool {
        let cmap = self.sk.charmap();
        text.chars()
            .filter(|c| {
                !c.is_control() && !crate::normalize::is_mark_or_control(*c) && !c.is_whitespace()
            })
            .all(|c| cmap.map(c).is_some())
    }

    /// Ascent/descent/bbox in 1/1000 em, for PDF font descriptors.
    pub fn metrics(&self) -> FontMetrics {
        let s = 1000.0 / self.upem;
        let head = self.sk.head().ok();
        let hhea = self.sk.hhea().ok();
        FontMetrics {
            ascent: hhea
                .as_ref()
                .map(|h| h.ascender().to_i16() as f32 * s)
                .unwrap_or(900.0),
            descent: hhea
                .as_ref()
                .map(|h| h.descender().to_i16() as f32 * s)
                .unwrap_or(-200.0),
            bbox: head
                .map(|h| {
                    [
                        h.x_min() as f32 * s,
                        h.y_min() as f32 * s,
                        h.x_max() as f32 * s,
                        h.y_max() as f32 * s,
                    ]
                })
                .unwrap_or([-200.0, -300.0, 1200.0, 1000.0]),
        }
    }

    /// Shape one run of a single direction and script.
    pub fn shape_run(&self, text: &str, direction: Direction) -> Vec<ShapedGlyph> {
        let shaper = self.data.shaper(&self.hb).build();
        let mut buf = UnicodeBuffer::new();
        buf.push_str(text);
        buf.set_direction(match direction {
            Direction::Rtl => harfrust::Direction::RightToLeft,
            Direction::Ltr => harfrust::Direction::LeftToRight,
        });
        buf.guess_segment_properties();
        buf.set_cluster_level(BufferClusterLevel::MonotoneCharacters);
        let features = [
            Feature::new(Tag::new(b"liga"), 1, ..),
            Feature::new(Tag::new(b"kern"), 1, ..),
        ];
        let out = shaper.shape(buf, ShapeOptions::new().features(&features));
        let infos = out.glyph_infos();
        let positions = out.glyph_positions();
        let mut clusters: Vec<usize> = infos.iter().map(|i| i.cluster as usize).collect();
        clusters.sort_unstable();
        clusters.dedup();
        let next_cluster = |c: usize| {
            clusters
                .iter()
                .find(|&&x| x > c)
                .copied()
                .unwrap_or(text.len())
        };
        let scale = 1000.0 / self.upem;
        let mut seen = std::collections::HashSet::new();
        infos
            .iter()
            .zip(positions)
            .map(|(i, p)| {
                let c = i.cluster as usize;
                // the first glyph of a cluster carries the cluster text; later glyphs carry nothing
                let cluster_text = if seen.insert(c) {
                    text[c..next_cluster(c)].to_string()
                } else {
                    String::new()
                };
                ShapedGlyph {
                    gid: i.glyph_id as u16,
                    text: cluster_text,
                    offset: c,
                    x_advance: p.x_advance as f32 * scale,
                    x_offset: p.x_offset as f32 * scale,
                    y_offset: p.y_offset as f32 * scale,
                }
            })
            .collect()
    }

    /// Shape a whole logical line: bidi runs in visual order, each shaped in its direction.
    pub fn shape_line(&self, line: &str) -> Vec<ShapedGlyph> {
        let mut out = vec![];
        for run in visual_runs(line) {
            let start = run.range.start;
            out.extend(
                self.shape_run(&line[run.range.clone()], run.direction)
                    .into_iter()
                    .map(|g| ShapedGlyph {
                        offset: g.offset + start,
                        ..g
                    }),
            );
        }
        out
    }
}

#[derive(Debug, Clone, Copy)]
pub struct FontMetrics {
    pub ascent: f32,
    pub descent: f32,
    pub bbox: [f32; 4],
}

#[cfg(test)]
mod tests {
    use super::*;
    const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");

    #[test]
    fn arabic_letters_get_contextual_forms_and_ligatures() {
        let s = Shaper::new(AMIRI).unwrap();
        let isolated = s.shape_run("ب", Direction::Rtl);
        let word = s.shape_run("ببب", Direction::Rtl);
        assert_eq!(word.len(), 3);
        // initial/medial/final forms are different glyphs from the isolated one
        let gids: Vec<u16> = word.iter().map(|g| g.gid).collect();
        assert!(
            gids.iter().all(|g| *g != isolated[0].gid),
            "contextual forms expected, got {gids:?}"
        );
        // conformance with HarfBuzz 12.1 (uharfbuzz) on the same font: Amiri draws lam-alef as
        // two contextual glyphs, and "الله" as four; glyph ids and advances must match exactly
        let la: Vec<(u16, f32)> = s
            .shape_run("لا", Direction::Rtl)
            .iter()
            .map(|g| (g.gid, g.x_advance))
            .collect();
        assert_eq!(la, vec![(2518, 340.0), (2513, 302.0)]);
        let allah: Vec<u16> = s
            .shape_run("الله", Direction::Rtl)
            .iter()
            .map(|g| g.gid)
            .collect();
        assert_eq!(allah, vec![1348, 6128, 1346, 55]);
        let bla: Vec<u16> = s
            .shape_run("بلا", Direction::Rtl)
            .iter()
            .map(|g| g.gid)
            .collect();
        assert_eq!(bla, vec![3080, 3075, 1611]);
    }

    #[test]
    fn some_amiri_letters_are_clusters_of_two_glyphs() {
        // Lam before kaf, and kha, are drawn with two glyphs; the second
        // carries no text of its own, so it has to be read with the first.
        let s = Shaper::new(AMIRI).unwrap();
        for (word, letter) in [("لكن", "ل"), ("الخير", "خ")] {
            let glyphs = s.shape_run(word, Direction::Rtl);
            let two: Vec<_> = clusters(&glyphs)
                .into_iter()
                .filter(|r| r.len() > 1)
                .collect();
            assert_eq!(two.len(), 1, "{word}");
            assert_eq!(glyphs[two[0].start].text, letter);
            let text: String = glyphs.iter().map(|g| g.text.as_str()).collect();
            assert_eq!(
                text.chars().rev().collect::<String>(),
                word,
                "every letter once"
            );
        }
    }

    #[test]
    fn marks_have_zero_advance_and_are_positioned() {
        let s = Shaper::new(AMIRI).unwrap();
        let g = s.shape_run("بَ", Direction::Rtl);
        assert_eq!(g.len(), 2);
        let mark = g
            .iter()
            .find(|g| g.text == "\u{064E}")
            .expect("fatha glyph");
        assert_eq!(mark.x_advance, 0.0);
    }

    #[test]
    fn shape_line_orders_runs_visually() {
        let s = Shaper::new(AMIRI).unwrap();
        let g = s.shape_line("رقم: INV-1");
        let text: String = g.iter().map(|g| g.text.as_str()).collect();
        // visual order: Latin run first (left), then the Arabic run reversed
        assert!(text.starts_with("INV-1"), "got {text:?}");
        assert!(s.covers("مرحبا Warraq 123"));
        assert!(!s.covers("你好"));
    }

    #[test]
    fn a_date_marked_left_to_right_keeps_its_order_and_sign_in_arabic() {
        // A visible signature's date line: without the mark, the date splits
        // into three runs and the zone's sign lands after it ("03:00+").
        let s = Shaper::new(AMIRI).unwrap();
        let g = s.shape_line("التاريخ: \u{200E}2026-09-19 20:05 +03:00");
        let text: String = g.iter().map(|g| g.text.as_str()).collect();
        assert!(
            text.trim_start_matches('\u{200E}')
                .starts_with("2026-09-19 20:05 +03:00"),
            "visual order: {text:?}"
        );
        // Unmarked, the same line is drawn as the review found it.
        let bare: String = s
            .shape_line("التاريخ: 2026-09-19 20:05 +03:00")
            .iter()
            .map(|g| g.text.as_str())
            .collect();
        assert!(bare.starts_with("03:00+"), "{bare:?}");
        // The mark itself draws nothing.
        let mark: f32 = g
            .iter()
            .filter(|g| g.text.contains('\u{200E}'))
            .map(|g| g.x_advance)
            .sum();
        assert_eq!(mark, 0.0);
    }
}
