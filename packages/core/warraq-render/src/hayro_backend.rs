//! Pure-Rust backend on `hayro` (raster) and `hayro-interpret` (glyph device).
use crate::{Bitmap, MarkedGlyphs, RenderDoc, RenderError};
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
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::raw::TableProvider;
use skrifa::{GlyphId, MetadataProvider};
use std::collections::HashMap;
use std::sync::Arc;
use warraq_text::PositionedGlyph;
use warraq_text::{best_match, Descriptor, ShapeSampler, MAX_DISTANCE};

/// Feeds an outline into a [`ShapeSampler`] so an unidentified glyph can be
/// recognised by its shape (the last rung of the extraction ladder, ADR-0005).
#[derive(Default)]
struct SamplePen(ShapeSampler);

impl OutlinePen for SamplePen {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.move_to(x, y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.0.line_to(x, y);
    }
    fn quad_to(&mut self, cx: f32, cy: f32, x: f32, y: f32) {
        self.0.quad_to(cx, cy, x, y);
    }
    fn curve_to(&mut self, c1x: f32, c1y: f32, c2x: f32, c2y: f32, x: f32, y: f32) {
        self.0.curve_to(c1x, c1y, c2x, c2y, x, y);
    }
    fn close(&mut self) {}
}

/// Signature of an embedded glyph's outline, for shape recognition.
fn outline_descriptor(data: &[u8], gid: u32) -> Option<Descriptor> {
    let f = skrifa::FontRef::new(data).ok()?;
    let upem = f.head().ok()?.units_per_em() as f32;
    let outline = f.outline_glyphs().get(GlyphId::new(gid))?;
    let mut pen = SamplePen::default();
    outline
        .draw(
            DrawSettings::unhinted(Size::unscaled(), LocationRef::default()),
            &mut pen,
        )
        .ok()?;
    pen.0.finish(upem)
}

/// Accumulates the bounding box of an outline (font units).
#[derive(Default)]
struct BoundsPen {
    min: (f32, f32),
    max: (f32, f32),
    any: bool,
}

impl BoundsPen {
    fn add(&mut self, x: f32, y: f32) {
        if !self.any {
            self.min = (x, y);
            self.max = (x, y);
            self.any = true;
        } else {
            self.min = (self.min.0.min(x), self.min.1.min(y));
            self.max = (self.max.0.max(x), self.max.1.max(y));
        }
    }
}

impl OutlinePen for BoundsPen {
    fn move_to(&mut self, x: f32, y: f32) {
        self.add(x, y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.add(x, y);
    }
    fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
        self.add(cx0, cy0);
        self.add(x, y);
    }
    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        self.add(cx0, cy0);
        self.add(cx1, cy1);
        self.add(x, y);
    }
    fn close(&mut self) {}
}

/// Records the device-space bounding box of everything drawn into it (Type3 glyph procedures).
#[derive(Default)]
struct BoundsDevice {
    min: (f64, f64),
    max: (f64, f64),
    any: bool,
}

impl BoundsDevice {
    fn add_rect(&mut self, r: Rect) {
        for (x, y) in [(r.x0, r.y0), (r.x1, r.y1)] {
            if !self.any {
                self.min = (x, y);
                self.max = (x, y);
                self.any = true;
            } else {
                self.min = (self.min.0.min(x), self.min.1.min(y));
                self.max = (self.max.0.max(x), self.max.1.max(y));
            }
        }
    }
}

impl<'a> Device<'a> for BoundsDevice {
    fn set_soft_mask(&mut self, _: Option<SoftMask<'a>>) {}
    fn set_blend_mode(&mut self, _: BlendMode) {}
    fn draw_path(&mut self, path: &BezPath, transform: Affine, _: &Paint<'a>, _: &PathDrawMode) {
        use hayro::vello_cpu::kurbo::Shape;
        let mut p = path.clone();
        p.apply_affine(transform);
        self.add_rect(p.bounding_box());
    }
    fn push_clip_path(&mut self, _: &ClipPath) {}
    fn push_transparency_group(&mut self, _: f32, _: Option<SoftMask<'a>>, _: BlendMode) {}
    fn draw_glyph(
        &mut self,
        _: &Glyph<'a>,
        _: Affine,
        _: Affine,
        _: &Paint<'a>,
        _: &GlyphDrawMode,
    ) {
    }
    fn draw_image(&mut self, _: Image<'a, '_>, transform: Affine) {
        self.add_rect(transform.transform_rect_bbox(Rect::new(0.0, 0.0, 1.0, 1.0)));
    }
    fn pop_clip_path(&mut self) {}
    fn pop_transparency_group(&mut self) {}
}

/// Classify a small blob (bounds in em units, y up) as a combining dot mark; see `dot_mark_from_outline`.
fn dot_mark_from_bounds(w: f32, h: f32) -> Option<char> {
    if h > 0.22 || w > 0.45 || h < 0.03 {
        return None;
    }
    // above-variant by count; `warraq-text` flips to the below-variant from the glyph's position
    Some(
        match if w < 0.17 {
            1
        } else if h > 0.6 * w {
            3
        } else {
            2
        } {
            1 => '\u{0307}',
            2 => '\u{0308}',
            _ => '\u{20DB}',
        },
    )
}

/// Fonts such as Noto Naskh Arabic build dotted letters from a skeleton glyph plus separate
/// dot glyphs; producers map the dots to nothing. Classify a text-less, zero-advance glyph by its
/// outline: a dot-sized blob above or below the baseline becomes a combining dot mark
/// (U+0307/U+0308/U+20DB above, U+0323/U+0324/U+20E8 below) which `warraq-text` recomposes.
fn dot_mark_from_outline(data: &[u8], gid: u32) -> Option<(char, (f32, f32))> {
    let f = skrifa::FontRef::new(data).ok()?;
    let upem = f.head().ok()?.units_per_em() as f32;
    let outline = f.outline_glyphs().get(GlyphId::new(gid))?;
    let mut pen = BoundsPen::default();
    outline
        .draw(
            DrawSettings::unhinted(Size::unscaled(), LocationRef::default()),
            &mut pen,
        )
        .ok()?;
    if !pen.any {
        return None;
    }
    let (w, h) = (
        (pen.max.0 - pen.min.0) / upem,
        (pen.max.1 - pen.min.1) / upem,
    );
    let center = (
        (pen.min.0 + pen.max.0) / 2.0 / upem,
        (pen.min.1 + pen.max.1) / 2.0 / upem,
    );
    dot_mark_from_bounds(w, h).map(|m| (m, center))
}

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
    /// The marked-content sequences begun so far, and the ones open now.
    marked: MarkedGlyphs,
    open: Vec<u32>,
    font_ids: HashMap<usize, u32>,
    advance_cache: HashMap<(u32, u32), f32>,
    /// gid → code point from the embedded font's cmap (fallback when ToUnicode is missing or U+0000)
    reverse_cmaps: HashMap<u32, HashMap<u32, char>>,
    /// gid → text learned by shaping Arabic letters in every joining context with the font's own GSUB
    shaped_maps: HashMap<u32, HashMap<u32, String>>,
    /// font id → its bytes, kept for the shape-recovery pass
    font_data: HashMap<u32, Vec<u8>>,
    /// Fonts where a dot had to be RECOVERED from an unidentified glyph, which is
    /// what marks a face that builds dotted letters from a skeleton plus dots.
    /// A font whose marks came from its own ToUnicode or cmap is not one of these.
    skeleton_fonts: std::collections::HashSet<u32>,
    /// The glyph last filled, and where: text drawn to be filled and stroked
    /// (render mode 2, how many producers make type bold) reaches the device
    /// twice, and is one glyph to a reader.
    last_fill: Option<((usize, u32), [f64; 6])>,
}

impl GlyphDevice {
    /// Learn gid → text by shaping each Arabic-script letter isolated, initial, medial and final
    /// (joined through tatweel) plus the lam-alef pairs, using the embedded font's GSUB. Real
    /// Google Docs exports keep GSUB in their subsets; Chrome print and Word drop it.
    fn shaped_text(&mut self, data: &[u8], font: u32, gid: u32) -> Option<String> {
        let map = self.shaped_maps.entry(font).or_insert_with(|| {
            let mut map: HashMap<u32, String> = HashMap::new();
            let Ok(shaper) = warraq_text::Shaper::new(data) else {
                return map;
            };
            let letters: Vec<char> = (0x0620u32..=0x06FF)
                .filter_map(char::from_u32)
                .filter(|c| c.is_alphabetic())
                .collect();
            let mut probes: Vec<String> = vec![];
            for l in &letters {
                probes.push(l.to_string());
                probes.push(format!("\u{0640}{l}"));
                probes.push(format!("{l}\u{0640}"));
                probes.push(format!("\u{0640}{l}\u{0640}"));
            }
            for pair in [
                "لا",
                "لأ",
                "لإ",
                "لآ",
                "\u{0640}لا",
                "\u{0640}لأ",
                "\u{0640}لإ",
                "\u{0640}لآ",
            ] {
                probes.push(pair.to_string());
            }
            for probe in probes {
                for g in shaper.shape_run(&probe, warraq_text::Direction::Rtl) {
                    let text: String = g.text.chars().filter(|c| *c != '\u{0640}').collect();
                    if g.gid != 0 && !text.is_empty() {
                        map.entry(g.gid as u32).or_insert(text);
                    }
                }
            }
            map
        });
        map.get(&gid).cloned()
    }

    fn cmap_char(&mut self, data: &[u8], font: u32, gid: u32) -> Option<char> {
        let rev = self.reverse_cmaps.entry(font).or_insert_with(|| {
            let mut rev: HashMap<u32, char> = HashMap::new();
            if let Ok(f) = skrifa::FontRef::new(data) {
                for (cp, g) in f.charmap().mappings() {
                    if let Some(ch) = char::from_u32(cp) {
                        // prefer real letters over private-use and presentation forms
                        let pua = |c: char| ('\u{E000}'..='\u{F8FF}').contains(&c);
                        let better = |old: char, new: char| -> bool {
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
            rev
        });
        rev.get(&gid).copied()
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
        paint: &Paint<'a>,
        mode: &GlyphDrawMode,
    ) {
        let t = transform * glyph_transform;
        let c = t.as_coeffs();
        let key = match glyph {
            Glyph::Outline(g) => (
                g.font_data()
                    .map(|fd| (*fd.data).as_ref().as_ptr() as usize)
                    .unwrap_or(0),
                g.glyph_id().to_u32(),
            ),
            Glyph::Type3(_) => (usize::MAX, 0),
        };
        let filled = self.last_fill.take();
        match mode {
            GlyphDrawMode::Stroke(_) if filled == Some((key, c)) => return,
            GlyphDrawMode::Fill => self.last_fill = Some((key, c)),
            _ => {}
        }
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
        let mut center: Option<(f32, f32)> = None;
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
                        if text.is_none() {
                            text = self.shaped_text(bytes, font, gid);
                        }
                        if text.is_none() {
                            // leave it unknown here; `shape_recover` decides after the whole
                            // page is known, because whether shape matching is safe depends on
                            // whether this font draws dots as separate glyphs
                            self.font_data.entry(font).or_insert_with(|| bytes.to_vec());
                        }
                        let adv = self.advance(bytes, font, gid);
                        if text.is_none() && adv == 0.0 {
                            if let Some((m, (cx, cy))) = dot_mark_from_outline(bytes, gid) {
                                text = Some(m.to_string());
                                self.skeleton_fonts.insert(font);
                                // glyph units are 1/1000 em in text space: map the center through the glyph transform
                                let p = t * hayro::vello_cpu::kurbo::Point::new(
                                    cx as f64 * 1000.0,
                                    cy as f64 * 1000.0,
                                );
                                center = Some((p.x as f32, p.y as f32));
                            }
                        }
                        (font, gid, adv * size)
                    }
                    None => (u32::MAX, gid, 0.0),
                }
            }
            Glyph::Type3(g) => {
                let mut b = BoundsDevice::default();
                g.interpret(&mut b, transform, glyph_transform, paint);
                if b.any && size > 0.0 {
                    let (w, h) = (
                        ((b.max.0 - b.min.0) as f32) / size,
                        ((b.max.1 - b.min.1) as f32) / size,
                    );
                    if text.is_none() {
                        if let Some(m) = dot_mark_from_bounds(w, h) {
                            text = Some(m.to_string());
                            self.skeleton_fonts.insert(u32::MAX);
                            center = Some((
                                ((b.min.0 + b.max.0) / 2.0) as f32,
                                ((b.min.1 + b.max.1) / 2.0) as f32,
                            ));
                        }
                    }
                    let is_dot = text
                        .as_ref()
                        .map(|t| {
                            t.chars().all(warraq_text::normalize::is_mark_or_control)
                                || matches!(
                                    t.as_str(),
                                    "\u{0307}"
                                        | "\u{0308}"
                                        | "\u{20DB}"
                                        | "\u{0323}"
                                        | "\u{0324}"
                                        | "\u{20E8}"
                                )
                        })
                        .unwrap_or(false);
                    // Type3 fonts carry no metrics here: estimate the advance from the drawn width
                    let adv = if is_dot {
                        0.0
                    } else {
                        (b.max.0 - b.min.0) as f32 * 1.12
                    };
                    (u32::MAX, 0, adv)
                } else {
                    (u32::MAX, 0, 0.0)
                }
            }
        };
        // baseline direction of this run; device y grows downwards, so negate
        let angle = -(c[1] as f32).atan2(c[0] as f32);
        self.marked.inside.push(self.open.clone());
        self.glyphs.push(PositionedGlyph {
            x: center.map(|p| p.0).unwrap_or(c[4] as f32),
            y: center.map(|p| p.1).unwrap_or(c[5] as f32),
            angle,
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
    fn begin_marked_content(&mut self, tag: &[u8], _mcid: Option<i32>) {
        self.open.push(self.marked.tags.len() as u32);
        self.marked.tags.push(tag.to_vec());
    }
    fn end_marked_content(&mut self) {
        self.open.pop();
    }
}

/// Recover characters for glyphs that nothing else identified.
///
/// Runs once the whole page is collected, because whether shape matching is safe
/// depends on the font. A face that builds dotted letters from a skeleton plus
/// separate dot glyphs (Noto Naskh among them) presents bare skeletons that
/// genuinely resemble several undotted letters, and guessing would put a wrong
/// letter in the user's text. Such a face is recognised by two things together:
/// dots had to be recovered from unidentified glyphs, AND most of its letters are
/// unidentified as well. A normal font whose tashkeel merely lacked a mapping
/// satisfies only the first, and is still worth matching.
fn shape_recover(
    glyphs: &mut [PositionedGlyph],
    font_data: &HashMap<u32, Vec<u8>>,
    recovered_dot_fonts: &std::collections::HashSet<u32>,
) {
    let mut bases: HashMap<u32, (usize, usize)> = HashMap::new(); // font -> (unidentified, total)
    for g in glyphs.iter().filter(|g| g.advance > 0.0) {
        let e = bases.entry(g.font).or_insert((0, 0));
        e.1 += 1;
        if g.text.is_none() {
            e.0 += 1;
        }
    }
    let skeleton = |font: u32| -> bool {
        recovered_dot_fonts.contains(&font)
            && bases
                .get(&font)
                .map(|(unknown, total)| *total > 0 && *unknown * 2 > *total)
                .unwrap_or(false)
    };
    let mut cache: HashMap<(u32, u32), Option<String>> = HashMap::new();
    for g in glyphs.iter_mut() {
        if g.text.is_some() || skeleton(g.font) {
            continue;
        }
        let Some(data) = font_data.get(&g.font) else {
            continue;
        };
        let (font, gid) = (g.font, g.gid);
        g.text = cache
            .entry((font, gid))
            .or_insert_with(|| {
                outline_descriptor(data, gid)
                    .and_then(|d| best_match(&d, MAX_DISTANCE))
                    .map(|(ch, _, _)| ch.to_string())
            })
            .clone();
    }
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
        Ok(self.marked_glyphs(index)?.0)
    }

    fn marked_glyphs(
        &self,
        index: usize,
    ) -> Result<(Vec<PositionedGlyph>, MarkedGlyphs), RenderError> {
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
        let mut glyphs = dev.glyphs;
        shape_recover(&mut glyphs, &dev.font_data, &dev.skeleton_fonts);
        Ok((glyphs, dev.marked))
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
