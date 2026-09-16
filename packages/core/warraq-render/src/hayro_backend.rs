//! Pure-Rust backend on `hayro` (raster) and `hayro-interpret` (glyph device).
use crate::{Bitmap, RenderDoc, RenderError};
use hayro::vello_cpu::kurbo::{Affine, BezPath, Rect};
use hayro::{render, RenderCache, RenderSettings};
use hayro_interpret::font::Glyph;
use hayro_interpret::hayro_cmap::BfString;
use hayro_interpret::hayro_syntax::Pdf;
use hayro_interpret::util::TransformExt;
use hayro_interpret::{
    interpret_page, BlendMode, ClipPath, Context, Device, GlyphDrawMode, Image, InterpreterCache,
    InterpreterSettings, Paint, PathDrawMode, SoftMask,
};
use skrifa::instance::{LocationRef, Size};
use skrifa::raw::TableProvider;
use skrifa::{GlyphId, MetadataProvider};
use std::collections::HashMap;
use std::sync::Arc;
use warraq_text::PositionedGlyph;

pub struct HayroDoc {
    pdf: Pdf,
}

impl HayroDoc {
    pub fn open(bytes: Vec<u8>, _password: Option<&str>) -> Result<Self, RenderError> {
        let pdf = Pdf::new(Arc::new(bytes)).map_err(|e| {
            let msg = format!("{e:?}");
            if msg.contains("Password") || msg.contains("Decryption") {
                RenderError::Password
            } else {
                RenderError::Parse(msg)
            }
        })?;
        Ok(Self { pdf })
    }
}

/// Collects glyph text and positions; advances come from the glyph's own font.
#[derive(Default)]
struct GlyphDevice {
    glyphs: Vec<PositionedGlyph>,
    font_ids: HashMap<usize, u32>,
    advance_cache: HashMap<(u32, u32), f32>,
    /// gid → code point from the embedded font's cmap (fallback when ToUnicode is missing or U+0000)
    reverse_cmaps: HashMap<u32, HashMap<u32, char>>,
}

impl GlyphDevice {
    fn cmap_char(&mut self, data: &[u8], font: u32, gid: u32) -> Option<char> {
        if !self.reverse_cmaps.contains_key(&font) {
            let mut rev: HashMap<u32, char> = HashMap::new();
            if let Ok(f) = skrifa::FontRef::new(data) {
                for (cp, g) in f.charmap().mappings() {
                    if let Some(ch) = char::from_u32(cp) {
                        // prefer real letters over private-use and presentation forms
                        let better = |old: char, new: char| -> bool {
                            let pua = |c: char| ('\u{E000}'..='\u{F8FF}').contains(&c);
                            (pua(old) && !pua(new))
                                || (warraq_text::normalize::is_presentation_form(old)
                                    && !warraq_text::normalize::is_presentation_form(new)
                                    && !pua(new))
                        };
                        match rev.get(&g.to_u32()) {
                            Some(old) if !better(*old, ch) => {}
                            _ => {
                                rev.insert(g.to_u32(), ch);
                            }
                        }
                    }
                }
            }
            self.reverse_cmaps.insert(font, rev);
        }
        self.reverse_cmaps
            .get(&font)
            .and_then(|m| m.get(&gid))
            .copied()
    }

    fn advance(&mut self, data: &[u8], font: u32, gid: u32) -> f32 {
        if let Some(a) = self.advance_cache.get(&(font, gid)) {
            return *a;
        }
        let adv = skrifa::FontRef::new(data)
            .ok()
            .map(|f| {
                let upem = f.head().map(|h| h.units_per_em() as f32).unwrap_or(1000.0);
                f.glyph_metrics(Size::unscaled(), LocationRef::default())
                    .advance_width(GlyphId::new(gid))
                    .unwrap_or(0.0)
                    / upem
            })
            .unwrap_or(0.0);
        self.advance_cache.insert((font, gid), adv);
        adv
    }
}

impl<'a> Device<'a> for GlyphDevice {
    fn set_soft_mask(&mut self, _: Option<SoftMask<'a>>) {}
    fn set_blend_mode(&mut self, _: BlendMode) {}
    fn draw_path(&mut self, _: &BezPath, _: Affine, _: &Paint<'a>, _: &PathDrawMode) {}
    fn push_clip_path(&mut self, _: &ClipPath) {}
    fn push_transparency_group(&mut self, _: f32, _: Option<SoftMask<'a>>, _: BlendMode) {}
    fn draw_glyph(
        &mut self,
        glyph: &Glyph<'a>,
        transform: Affine,
        glyph_transform: Affine,
        _: &Paint<'a>,
        _: &GlyphDrawMode,
    ) {
        let t = transform * glyph_transform;
        let c = t.as_coeffs();
        // glyph outlines are in 1/1000 text space, so the transform scale is size/1000
        let size = ((c[0] * c[0] + c[1] * c[1]).sqrt() * 1000.0) as f32;
        // ToUnicode text; U+0000 (Skia writes it for glyphs without a cmap entry) means unknown
        let mut text = glyph
            .as_unicode()
            .map(|s| match s {
                BfString::Char(ch) => ch.to_string(),
                BfString::String(st) => st,
            })
            .filter(|t| !t.is_empty() && !t.chars().all(|c| c == '\0'));
        let (font, gid, adv) = match glyph {
            Glyph::Outline(g) => {
                let gid = g.glyph_id().to_u32();
                match g.font_data() {
                    Some(fd) => {
                        let bytes: &[u8] = (*fd.data).as_ref();
                        let key = bytes.as_ptr() as usize;
                        let next = self.font_ids.len() as u32;
                        let font = *self.font_ids.entry(key).or_insert(next);
                        if text.is_none() {
                            text = self.cmap_char(bytes, font, gid).map(|c| c.to_string());
                        }
                        (font, gid, self.advance(bytes, font, gid) * size)
                    }
                    None => (u32::MAX, gid, 0.0),
                }
            }
            Glyph::Type3(_) => (u32::MAX, 0, 0.0),
        };
        self.glyphs.push(PositionedGlyph {
            x: c[4] as f32,
            y: c[5] as f32,
            size,
            advance: adv,
            text,
            gid,
            font,
        });
    }
    fn draw_image(&mut self, _: Image<'a, '_>, _: Affine) {}
    fn pop_clip_path(&mut self) {}
    fn pop_transparency_group(&mut self) {}
}

impl RenderDoc for HayroDoc {
    fn page_count(&self) -> usize {
        self.pdf.pages().len()
    }

    fn page_size(&self, index: usize) -> Result<(f32, f32), RenderError> {
        let page = self
            .pdf
            .pages()
            .get(index)
            .ok_or(RenderError::Page(index))?;
        Ok(page.render_dimensions())
    }

    fn render(&self, index: usize, scale: f32) -> Result<Bitmap, RenderError> {
        let page = self
            .pdf
            .pages()
            .get(index)
            .ok_or(RenderError::Page(index))?;
        let cache = RenderCache::new();
        let settings = RenderSettings {
            x_scale: scale,
            y_scale: scale,
            bg_color: hayro::vello_cpu::color::palette::css::WHITE,
            ..Default::default()
        };
        let pix = render(page, &cache, &InterpreterSettings::default(), &settings);
        let (w, h) = (pix.width() as u32, pix.height() as u32);
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for p in pix.data() {
            rgba.extend_from_slice(&[p.r, p.g, p.b, 255]);
        }
        Ok(Bitmap {
            width: w,
            height: h,
            rgba,
        })
    }

    fn glyphs(&self, index: usize) -> Result<Vec<PositionedGlyph>, RenderError> {
        let page = self
            .pdf
            .pages()
            .get(index)
            .ok_or(RenderError::Page(index))?;
        let (w, h) = page.render_dimensions();
        let cache = InterpreterCache::new();
        let mut ctx = Context::new(
            page.initial_transform(true).to_kurbo(),
            Rect::new(0.0, 0.0, w as f64, h as f64),
            &cache,
            page.xref(),
            InterpreterSettings::default(),
        );
        let mut dev = GlyphDevice::default();
        interpret_page(page, &mut ctx, &mut dev);
        Ok(dev.glyphs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn corpus(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/../../../tests/corpus/arabic/generated/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    #[test]
    fn renders_and_extracts_glyphs_with_advances() {
        let d = HayroDoc::open(corpus("raw-amiri-cid-identity-tounicode.pdf"), None).unwrap();
        assert_eq!(d.page_count(), 1);
        let (w, h) = d.page_size(0).unwrap();
        assert!((w - 595.28).abs() < 0.5 && (h - 841.89).abs() < 0.5);
        let bmp = d.render(0, 0.5).unwrap();
        assert_eq!((bmp.width, bmp.height), (297, 420));
        assert!(
            bmp.rgba.iter().step_by(4).any(|r| *r < 128),
            "some dark pixels expected"
        );
        let g = d.glyphs(0).unwrap();
        assert!(g.len() > 300);
        assert!(g.iter().all(|g| g.text.is_some()));
        assert!(
            g.iter().filter(|g| g.advance > 0.0).count() > 250,
            "advances from the embedded font"
        );
        assert!(
            (g[0].size - 15.0).abs() < 0.1,
            "font size recovered: {}",
            g[0].size
        );
    }
}
