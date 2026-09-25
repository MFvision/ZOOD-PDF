//! The bundled OFL fonts (Amiri, Cairo, Inter), shaping with `harfrust` (variable-font instances
//! for bold Cairo/Inter), coverage checks and metrics.
//!
//! The fonts ship in `packages/core/assets/fonts/` with their `OFL.txt` and are compiled into the
//! engine, so Create PDF works offline everywhere (web, desktop, extension, iOS).

use std::sync::OnceLock;

use harfrust::{Direction, FontRef, ShapeOptions, ShaperData, ShaperInstance, Tag, UnicodeBuffer};
use read_fonts::TableProvider;

use crate::error::{CreateError, Result};
use crate::model::Family;

macro_rules! font_file {
    ($p:literal) => {
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../assets/fonts/", $p))
    };
}

static AMIRI_REGULAR: &[u8] = font_file!("amiri/Amiri-Regular.ttf");
static AMIRI_BOLD: &[u8] = font_file!("amiri/Amiri-Bold.ttf");
static CAIRO: &[u8] = font_file!("cairo/Cairo-Variable.ttf");
static INTER: &[u8] = font_file!("inter/Inter-Variable.ttf");

/// One concrete font instance we can embed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum FontId {
    AmiriRegular,
    AmiriBold,
    CairoRegular,
    CairoBold,
    InterRegular,
    InterBold,
}

impl FontId {
    pub const ALL: [FontId; 6] = [
        FontId::AmiriRegular,
        FontId::AmiriBold,
        FontId::CairoRegular,
        FontId::CairoBold,
        FontId::InterRegular,
        FontId::InterBold,
    ];

    /// The instance for a family and weight.
    pub fn for_family(family: Family, bold: bool) -> FontId {
        match (family, bold) {
            (Family::Serif, false) => FontId::AmiriRegular,
            (Family::Serif, true) => FontId::AmiriBold,
            (Family::Sans, false) => FontId::CairoRegular,
            (Family::Sans, true) => FontId::CairoBold,
            (Family::Latin, false) => FontId::InterRegular,
            (Family::Latin, true) => FontId::InterBold,
        }
    }

    /// Other instances to try when this one lacks a glyph (same weight).
    pub fn fallbacks(self) -> [FontId; 2] {
        match self {
            FontId::AmiriRegular => [FontId::CairoRegular, FontId::InterRegular],
            FontId::AmiriBold => [FontId::CairoBold, FontId::InterBold],
            FontId::CairoRegular => [FontId::AmiriRegular, FontId::InterRegular],
            FontId::CairoBold => [FontId::AmiriBold, FontId::InterBold],
            FontId::InterRegular => [FontId::CairoRegular, FontId::AmiriRegular],
            FontId::InterBold => [FontId::CairoBold, FontId::AmiriBold],
        }
    }

    /// Font program bytes (the variable font for Cairo/Inter).
    pub fn data(self) -> &'static [u8] {
        match self {
            FontId::AmiriRegular => AMIRI_REGULAR,
            FontId::AmiriBold => AMIRI_BOLD,
            FontId::CairoRegular | FontId::CairoBold => CAIRO,
            FontId::InterRegular | FontId::InterBold => INTER,
        }
    }

    /// Variation coordinates (user space) of this instance.
    pub fn variations(self) -> &'static [(&'static str, f32)] {
        match self {
            FontId::AmiriRegular | FontId::AmiriBold => &[],
            FontId::CairoRegular => &[("wght", 400.0), ("slnt", 0.0)],
            FontId::CairoBold => &[("wght", 700.0), ("slnt", 0.0)],
            FontId::InterRegular => &[("wght", 400.0), ("opsz", 14.0)],
            FontId::InterBold => &[("wght", 700.0), ("opsz", 14.0)],
        }
    }

    /// PostScript-style base font name (the subset tag is added by the writer).
    pub fn base_name(self) -> &'static str {
        match self {
            FontId::AmiriRegular => "Amiri-Regular",
            FontId::AmiriBold => "Amiri-Bold",
            FontId::CairoRegular => "Cairo-Regular",
            FontId::CairoBold => "Cairo-Bold",
            FontId::InterRegular => "Inter-Regular",
            FontId::InterBold => "Inter-Bold",
        }
    }

    pub fn is_bold(self) -> bool {
        matches!(
            self,
            FontId::AmiriBold | FontId::CairoBold | FontId::InterBold
        )
    }

    fn index(self) -> usize {
        self as usize
    }
}

/// A loaded font instance.
pub struct Font {
    pub id: FontId,
    font: FontRef<'static>,
    data: ShaperData,
    instance: Option<ShaperInstance>,
    pub upem: f64,
    /// Ascender/descender/line gap in font units (hhea).
    pub ascender: f64,
    pub descender: f64,
    pub line_gap: f64,
}

impl std::fmt::Debug for Font {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Font").field("id", &self.id).finish()
    }
}

/// A shaped glyph in visual order; advances/offsets in font units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Glyph {
    pub gid: u16,
    /// Byte offset of the glyph's cluster in the shaped text.
    pub cluster: usize,
    pub x_advance: f64,
    pub y_advance: f64,
    pub x_offset: f64,
    pub y_offset: f64,
}

fn load(id: FontId) -> Option<Font> {
    let font = FontRef::new(id.data()).ok()?;
    let data = ShaperData::new(&font);
    let vars = id.variations();
    let instance = if vars.is_empty() {
        None
    } else {
        Some(ShaperInstance::from_variations(&font, vars.iter()))
    };
    let upem = f64::from(font.head().ok()?.units_per_em().max(16));
    let hhea = font.hhea().ok()?;
    Some(Font {
        id,
        font,
        data,
        instance,
        upem,
        ascender: f64::from(hhea.ascender().to_i16()),
        descender: f64::from(hhea.descender().to_i16()),
        line_gap: f64::from(hhea.line_gap().to_i16()),
    })
}

/// The loaded font instance `id` (loaded once per process).
pub fn font(id: FontId) -> Result<&'static Font> {
    static FONTS: OnceLock<Vec<Option<Font>>> = OnceLock::new();
    FONTS
        .get_or_init(|| FontId::ALL.iter().map(|&i| load(i)).collect())
        .get(id.index())
        .and_then(Option::as_ref)
        .ok_or_else(|| CreateError::Font(format!("bundled font {id:?} failed to load")))
}

impl Font {
    /// Does the font map `c` to a real glyph?
    pub fn covers(&self, c: char) -> bool {
        if is_default_ignorable(c) || c.is_whitespace() {
            return true;
        }
        self.font
            .cmap()
            .ok()
            .and_then(|cm| cm.map_codepoint(c))
            .is_some_and(|g| g.to_u32() != 0)
    }

    /// Shape `text` in one direction. Glyphs come back in visual (left-to-right) order.
    pub fn shape(&self, text: &str, rtl: bool) -> Vec<Glyph> {
        let shaper = self
            .data
            .shaper(&self.font)
            .instance(self.instance.as_ref())
            .build();
        let mut buf = UnicodeBuffer::new();
        buf.push_str(text);
        buf.set_direction(if rtl {
            Direction::RightToLeft
        } else {
            Direction::LeftToRight
        });
        buf.guess_segment_properties();
        let out = shaper.shape(buf, ShapeOptions::new());
        out.glyph_infos()
            .iter()
            .zip(out.glyph_positions())
            .map(|(gi, gp)| Glyph {
                gid: u16::try_from(gi.glyph_id).unwrap_or(0),
                cluster: gi.cluster as usize,
                x_advance: f64::from(gp.x_advance),
                y_advance: f64::from(gp.y_advance),
                x_offset: f64::from(gp.x_offset),
                y_offset: f64::from(gp.y_offset),
            })
            .collect()
    }

    /// Scale from font units to points at `size`.
    pub fn scale(&self, size: f64) -> f64 {
        size / self.upem
    }

    /// Variation coordinates for the subsetter.
    pub fn subset_variations(&self) -> Vec<(subsetter::Tag, f32)> {
        self.id
            .variations()
            .iter()
            .filter_map(|(t, v)| {
                let b = t.as_bytes();
                let arr: [u8; 4] = [
                    *b.first()?,
                    *b.get(1)?,
                    *b.get(2)?,
                    *b.get(3)?,
                ];
                Some((subsetter::Tag::new(&arr), *v))
            })
            .collect()
    }

    /// The raw font reference (for tests).
    pub fn font_ref(&self) -> &FontRef<'static> {
        &self.font
    }
}

/// Characters that never need a glyph (joiners, bidi controls, variation selectors).
pub fn is_default_ignorable(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{115F}' | '\u{1160}' | '\u{17B4}' | '\u{17B5}'
        | '\u{180B}'..='\u{180F}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{206F}' | '\u{FE00}'..='\u{FE0F}' | '\u{FEFF}')
}

/// Pick a font instance covering `c`: the preferred one, else its fallbacks.
pub fn font_for_char(preferred: FontId, c: char) -> FontId {
    if let Ok(f) = font(preferred) {
        if f.covers(c) {
            return preferred;
        }
    }
    for fb in preferred.fallbacks() {
        if let Ok(f) = font(fb) {
            if f.covers(c) {
                return fb;
            }
        }
    }
    preferred
}

/// Unused import guard for `Tag` (kept for the public variation API).
#[allow(dead_code)]
fn _tag(_: Tag) {}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn all_fonts_load_and_cover_their_scripts() {
        for id in FontId::ALL {
            let f = font(id).unwrap();
            assert!(f.covers('A'), "{id:?}");
            assert!(f.upem > 0.0);
            assert!(f.ascender > 0.0 && f.descender < 0.0);
        }
        assert!(font(FontId::AmiriRegular).unwrap().covers('ب'));
        assert!(font(FontId::CairoBold).unwrap().covers('ب'));
        assert!(!font(FontId::InterRegular).unwrap().covers('ب'));
        assert_eq!(font_for_char(FontId::InterRegular, 'ب'), FontId::CairoRegular);
        assert_eq!(font_for_char(FontId::InterRegular, 'x'), FontId::InterRegular);
    }

    #[test]
    fn bold_instance_is_wider() {
        let r = font(FontId::InterRegular).unwrap().shape("Wide", false);
        let b = font(FontId::InterBold).unwrap().shape("Wide", false);
        let w = |g: &[Glyph]| g.iter().map(|x| x.x_advance).sum::<f64>();
        assert!(w(&b) > w(&r), "{} vs {}", w(&b), w(&r));
    }

    #[test]
    fn arabic_is_shaped_in_visual_order() {
        let g = font(FontId::AmiriRegular).unwrap().shape("سلام", true);
        assert!(!g.is_empty());
        // Visual order: the first logical letter (cluster 0) is rightmost.
        assert_eq!(g.last().unwrap().cluster, 0);
    }
}
