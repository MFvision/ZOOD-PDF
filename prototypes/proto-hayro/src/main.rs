//! Phase 0 probe: hayro (pure Rust) renders page 1 and a text-collecting
//! `Device` extracts glyph unicode + positions. Text is emitted in geometric
//! (visual, left-to-right) order, which is exactly what our own engine must
//! then turn into logical order.
use hayro::{render, RenderCache, RenderSettings};
use hayro_interpret::hayro_syntax::Pdf;
use hayro_interpret::{
    interpret_page, BlendMode, ClipPath, Context, Device, GlyphDrawMode, Image, InterpreterCache,
    InterpreterSettings, Paint, PathDrawMode, SoftMask,
};
use hayro_interpret::font::Glyph;
use hayro_interpret::util::TransformExt;
use hayro::vello_cpu::kurbo::{Affine, BezPath, Rect};
use hayro_interpret::hayro_cmap::BfString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

#[derive(Default)]
struct TextDevice {
    glyphs: Vec<(f64, f64, f64, String)>,
    calls: usize,
}

impl<'a> Device<'a> for TextDevice {
    fn set_soft_mask(&mut self, _: Option<SoftMask<'a>>) {}
    fn set_blend_mode(&mut self, _: BlendMode) {}
    fn draw_path(&mut self, _: &BezPath, _: Affine, _: &Paint<'a>, _: &PathDrawMode) {}
    fn push_clip_path(&mut self, _: &ClipPath) {}
    fn push_transparency_group(&mut self, _: f32, _: Option<SoftMask<'a>>, _: BlendMode) {}
    fn draw_glyph(&mut self, glyph: &Glyph<'a>, transform: Affine, glyph_transform: Affine, _: &Paint<'a>, _: &GlyphDrawMode) {
        self.calls += 1;
        if let Some(s) = glyph.as_unicode() {
            let t = transform * glyph_transform;
            let c = t.as_coeffs();
            let size = (c[0] * c[0] + c[1] * c[1]).sqrt() * 1000.0;
            let text = match s { BfString::Char(ch) => ch.to_string(), BfString::String(st) => st };
            self.glyphs.push((c[4], c[5], size, text));
        }
    }
    fn draw_image(&mut self, _: Image<'a, '_>, _: Affine) {}
    fn pop_clip_path(&mut self) {}
    fn pop_transparency_group(&mut self) {}
}

/// Group glyphs into lines by y, order by x, insert spaces on gaps.
fn layout_text(mut g: Vec<(f64, f64, f64, String)>) -> String {
    if g.is_empty() { return String::new(); }
    g.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap().then(a.0.partial_cmp(&b.0).unwrap()));
    let mut lines: Vec<Vec<(f64, f64, f64, String)>> = vec![];
    for it in g {
        match lines.last_mut() {
            Some(line) if (line[0].1 - it.1).abs() < (line[0].2.max(1.0)) * 0.5 => line.push(it),
            _ => lines.push(vec![it]),
        }
    }
    let mut out = String::new();
    for mut line in lines {
        line.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let mut prev_x: Option<f64> = None;
        for (x, _, size, s) in line {
            if let Some(px) = prev_x { if x - px > size.max(1.0) * 0.9 { out.push(' '); } }
            out.push_str(&s);
            prev_x = Some(x);
        }
        out.push('\n');
    }
    out
}

fn run_one(path: &Path, shots: &Path) -> serde_json::Value {
    let stem = path.file_stem().unwrap().to_string_lossy().to_string();
    let t0 = Instant::now();
    let data = std::fs::read(path).unwrap();
    let pdf = match Pdf::new(Arc::new(data)) { Ok(p) => p, Err(e) => return serde_json::json!({"open": false, "error": format!("{e:?}")}) };
    let pages = pdf.pages();
    let n = pages.len();
    let page = match pages.iter().next() { Some(p) => p, None => return serde_json::json!({"open": false, "error": "no pages"}) };
    let t_open = t0.elapsed().as_secs_f64() * 1000.0;
    let t1 = Instant::now();
    let cache = RenderCache::new();
    let is = InterpreterSettings::default();
    let pix = render(page, &cache, &is, &RenderSettings { x_scale: 1.5, y_scale: 1.5, bg_color: hayro::vello_cpu::color::palette::css::WHITE, ..Default::default() });
    let t_render = t1.elapsed().as_secs_f64() * 1000.0;
    let (w, h) = (pix.width() as u32, pix.height() as u32);
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for p in pix.data() { rgb.extend_from_slice(&[p.r, p.g, p.b]); }
    let img = image::RgbImage::from_raw(w, h, rgb).unwrap();
    let dir = shots.join("hayro"); std::fs::create_dir_all(&dir).unwrap();
    let shot = dir.join(format!("{stem}.jpg"));
    let img = if w > 900 { image::imageops::resize(&img, 900, h * 900 / w, image::imageops::FilterType::Triangle) } else { img };
    let mut f = std::fs::File::create(&shot).unwrap();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut f, 80).encode_image(&img).unwrap();
    // text extraction for up to 3 pages
    let t2 = Instant::now();
    let mut texts = vec![];
    let icache = InterpreterCache::new();
    for page in pages.iter().take(3) {
        let (pw, ph) = page.render_dimensions();
        let mut ctx = Context::new(page.initial_transform(true).to_kurbo(), Rect::new(0.0, 0.0, pw as f64, ph as f64), &icache, page.xref(), is.clone());
        let mut dev = TextDevice::default();
        interpret_page(page, &mut ctx, &mut dev);
        if std::env::var("WARRAQ_DEBUG").is_ok() { eprintln!("glyphs with unicode: {} (calls: {}), sample: {:?}", dev.glyphs.len(), dev.calls, dev.glyphs.iter().take(6).collect::<Vec<_>>()); }
        texts.push(layout_text(dev.glyphs));
    }
    let t_text = t2.elapsed().as_secs_f64() * 1000.0;
    let text = texts.join("\n");
    serde_json::json!({"open": true, "pages": n, "t_open_ms": (t_open * 10.0).round() / 10.0, "t_render_p1_ms": (t_render * 10.0).round() / 10.0,
        "t_text_ms": (t_text * 10.0).round() / 10.0, "shot": format!("docs/research/screenshots/hayro/{stem}.jpg"), "selectable": !text.trim().is_empty(), "text": text})
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let repo = PathBuf::from(&args[1]);
    let corpus = repo.join("tests/corpus/arabic");
    let shots = repo.join("docs/research/screenshots");
    let mut files: Vec<PathBuf> = vec![];
    for d in ["generated", "realworld"] {
        if let Ok(rd) = std::fs::read_dir(corpus.join(d)) {
            let mut v: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().map(|e| e == "pdf").unwrap_or(false)).collect();
            v.sort(); files.extend(v);
        }
    }
    let mut out = serde_json::Map::new();
    for f in files {
        let stem = f.file_stem().unwrap().to_string_lossy().to_string();
        let r = std::panic::catch_unwind(|| run_one(&f, &shots)).unwrap_or_else(|_| serde_json::json!({"open": false, "error": "PANIC"}));
        println!("hayro   {:<45} {} {}ms open {}ms render", stem, if r["open"].as_bool().unwrap_or(false) { "OK " } else { "ERR" }, r["t_open_ms"], r["t_render_p1_ms"]);
        out.insert(stem, r);
    }
    std::fs::write(repo.join("tests/acid/results-hayro.json"), serde_json::to_string_pretty(&serde_json::Value::Object(out)).unwrap()).unwrap();
}
