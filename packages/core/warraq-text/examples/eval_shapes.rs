//! Accuracy of glyph-shape recovery on fonts that are NOT in the prototype table.
//! usage: cargo run --example eval_shapes -- <repo-root>
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::prelude::{LocationRef, Size};
use skrifa::raw::TableProvider;
use skrifa::{GlyphId, MetadataProvider};
use std::path::PathBuf;
use warraq_text::{best_match, Descriptor, Direction, Form, ShapeSampler, Shaper};

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
    fn curve_to(&mut self, a: f32, b: f32, c: f32, d: f32, x: f32, y: f32) {
        self.0.curve_to(a, b, c, d, x, y);
    }
    fn close(&mut self) {}
}

fn descriptor_of(data: &[u8], gid: u16) -> Option<Descriptor> {
    let font = skrifa::FontRef::new(data).ok()?;
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

const LETTERS: &str = "ابتثجحخدذرزسشصضطظعغفقكلمنهوي";

fn main() {
    let repo = PathBuf::from(std::env::args().nth(1).expect("repo"));
    let dir = repo.join("tests/fonts");
    // held-out families: none of these contributed prototypes
    for family in [
        "IBMPlexSansArabic-Regular.ttf",
        "static/NotoSansArabic-Regular-static.ttf",
        "Amiri-Bold.ttf",
    ] {
        let Ok(data) = std::fs::read(dir.join(family)) else {
            continue;
        };
        let Ok(shaper) = Shaper::new(&data) else {
            continue;
        };
        let (mut total, mut exact, mut rejected) = (0, 0, 0);
        let mut worst: Vec<(char, char, f32)> = vec![];
        for ch in LETTERS.chars() {
            for (_, text) in [
                (Form::Isolated, format!("{ch}")),
                (Form::Initial, format!("{ch}\u{0640}")),
                (Form::Medial, format!("\u{0640}{ch}\u{0640}")),
                (Form::Final, format!("\u{0640}{ch}")),
            ] {
                let glyphs = shaper.shape_run(&text, Direction::Rtl);
                let Some(g) = glyphs.iter().find(|g| g.text.contains(ch)) else {
                    continue;
                };
                let Some(d) = descriptor_of(&data, g.gid) else {
                    continue;
                };
                total += 1;
                match best_match(&d, 0.11) {
                    Some((got, _, dist)) => {
                        if got == ch {
                            exact += 1
                        } else {
                            worst.push((ch, got, dist))
                        }
                    }
                    None => rejected += 1,
                }
            }
        }
        let answered = total - rejected;
        let precision = if answered > 0 {
            100.0 * exact as f32 / answered as f32
        } else {
            0.0
        };
        println!(
            "{family:46} answered {answered}/{total}, correct {exact} → precision {precision:.0}%"
        );
        worst.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap());
        for (want, got, d) in worst.iter().take(5) {
            println!("      confused {want} -> {got} (distance {d:.3})");
        }
    }
}
