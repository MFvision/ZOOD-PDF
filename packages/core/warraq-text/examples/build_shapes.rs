//! Generate `warraq-text/src/shape_prototypes.bin` from the bundled OFL faces.
//!
//! For every Arabic letter, shape it in its four joining contexts (using tatweel
//! as the neighbour), take the glyph the shaper chose, and record the signature
//! of its outline. Several typefaces are recorded separately rather than averaged,
//! so an unknown glyph can match whichever family it resembles.
//!
//! usage: cargo run --example build_shapes -- <repo-root>
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::prelude::{LocationRef, Size};
use skrifa::raw::TableProvider;
use skrifa::{GlyphId, MetadataProvider};
use std::path::PathBuf;
use warraq_text::{Descriptor, Direction, Form, ShapeSampler, Shaper};

struct Pen(ShapeSampler);

impl OutlinePen for Pen {
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

/// Letters worth recognising: the Arabic alphabet plus the Persian and Urdu
/// additions that ADR-0006 makes first-class, and the lam-alef ligatures.
const LETTERS: &str = "ابتثجحخدذرزسشصضطظعغفقكلمنهوياءأإآةىئؤپچژگکیټڈڑںھےڤ";
const LIGATURES: &[&str] = &["لا", "لأ", "لإ", "لآ"];

fn descriptor_of(font_data: &[u8], gid: u16) -> Option<Descriptor> {
    let font = skrifa::FontRef::new(font_data).ok()?;
    let upem = font.head().ok()?.units_per_em() as f32;
    let outline = font.outline_glyphs().get(GlyphId::new(gid as u32))?;
    let mut pen = Pen(ShapeSampler::new());
    outline
        .draw(
            DrawSettings::unhinted(Size::unscaled(), LocationRef::default()),
            &mut pen,
        )
        .ok()?;
    pen.0.finish(upem)
}

fn main() {
    let repo = PathBuf::from(std::env::args().nth(1).expect("repo root"));
    let fonts_dir = repo.join("tests/fonts");
    // one static instance per family; variable fonts are instantiated by the corpus tooling
    let families: &[&str] = &[
        "Amiri-Regular.ttf",
        "static/NotoNaskhArabic-Regular-static.ttf",
        "static/Cairo-Regular-static.ttf",
        "Tajawal-Regular.ttf",
        "ScheherazadeNew-Regular.ttf",
        "static/Vazirmatn-Regular-static.ttf",
    ];
    let mut records: Vec<(char, Form, u8, Descriptor)> = vec![];
    for (fi, family) in families.iter().enumerate() {
        let path = fonts_dir.join(family);
        let Ok(data) = std::fs::read(&path) else {
            eprintln!("skipping missing {}", path.display());
            continue;
        };
        let Ok(shaper) = Shaper::new(&data) else {
            eprintln!("skipping unreadable {}", path.display());
            continue;
        };
        let mut kept = 0;
        for ch in LETTERS.chars() {
            for (form, text) in [
                (Form::Isolated, format!("{ch}")),
                (Form::Initial, format!("{ch}\u{0640}")),
                (Form::Medial, format!("\u{0640}{ch}\u{0640}")),
                (Form::Final, format!("\u{0640}{ch}")),
            ] {
                let glyphs = shaper.shape_run(&text, Direction::Rtl);
                let Some(g) = glyphs.iter().find(|g| g.text.contains(ch)) else {
                    continue;
                };
                if let Some(d) = descriptor_of(&data, g.gid) {
                    records.push((ch, form, fi as u8, d));
                    kept += 1;
                }
            }
        }
        for lig in LIGATURES {
            for (form, text) in [
                (Form::Isolated, lig.to_string()),
                (Form::Final, format!("\u{0640}{lig}")),
            ] {
                let glyphs = shaper.shape_run(&text, Direction::Rtl);
                // a ligature may still come out as two glyphs; only the single-glyph case is a ligature
                let letters: Vec<_> = glyphs
                    .iter()
                    .filter(|g| !g.text.is_empty() && g.text != "\u{0640}")
                    .collect();
                if letters.len() == 1 {
                    if let Some(d) = descriptor_of(&data, letters[0].gid) {
                        records.push((lig.chars().next().unwrap(), form, fi as u8, d));
                        kept += 1;
                    }
                }
            }
        }
        println!("{family}: {kept} prototypes");
    }
    let blob = warraq_text::glyphshape::encode_prototypes(&records);
    let out = repo.join("packages/core/warraq-text/src/shape_prototypes.bin");
    std::fs::write(&out, &blob).unwrap();
    println!(
        "wrote {} records ({} bytes) to {}",
        records.len(),
        blob.len(),
        out.display()
    );
}
