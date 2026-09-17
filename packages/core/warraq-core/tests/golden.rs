//! Golden renders: every corpus page must keep looking the same (brief §5).
//!
//! References are stored small and grey (160 px wide, 8-bit) so the whole corpus
//! costs a few hundred kilobytes in git while still catching the regressions that
//! matter: a line that moves, a glyph that disappears, a page that comes out blank.
//! Comparison is by mean absolute difference, which tolerates the last-bit
//! differences between CPUs but not a visible change.
//!
//! Refresh after an intended change:
//!   `UPDATE_GOLDEN=1 cargo test -p warraq-core --test golden`
use std::path::{Path, PathBuf};

const WIDTH: usize = 160;
/// Mean absolute difference, in grey levels out of 255, that still counts as the same page.
const TOLERANCE: f32 = 2.0;

fn corpus_files() -> Vec<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/corpus/arabic");
    let mut files = vec![];
    for sub in ["generated", "realworld"] {
        if let Ok(rd) = std::fs::read_dir(dir.join(sub)) {
            let mut v: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().map(|e| e == "pdf").unwrap_or(false))
                .collect();
            v.sort();
            files.extend(v);
        }
    }
    files
}

fn password_for(stem: &str) -> Option<&'static str> {
    match stem {
        "variant-encrypted-aes256-owner-only" => Some(""),
        s if s.starts_with("variant-encrypted") => Some("warraq"),
        _ => None,
    }
}

/// Render page 1 and reduce it to a small grey thumbnail by box-averaging.
fn thumbnail(path: &Path) -> Option<(usize, Vec<u8>)> {
    let stem = path.file_stem()?.to_string_lossy().to_string();
    let doc = warraq_core::Document::open(std::fs::read(path).ok()?, password_for(&stem)).ok()?;
    let (w, _) = doc.page_size(0).ok()?;
    let scale = WIDTH as f32 / w.max(1.0);
    let bmp = doc.render_page(0, scale).ok()?;
    let (bw, bh) = (bmp.width as usize, bmp.height as usize);
    if bw == 0 || bh == 0 {
        return None;
    }
    let height = (bh * WIDTH).div_ceil(bw.max(1));
    let mut out = vec![0u8; WIDTH * height];
    for (y, row) in out.as_chunks_mut::<WIDTH>().0.iter_mut().enumerate() {
        for (x, cell) in row.iter_mut().enumerate() {
            // average the source block that maps to this cell
            let (x0, x1) = (
                x * bw / WIDTH,
                ((x + 1) * bw / WIDTH).max(x * bw / WIDTH + 1).min(bw),
            );
            let (y0, y1) = (
                y * bh / height,
                ((y + 1) * bh / height).max(y * bh / height + 1).min(bh),
            );
            let mut sum = 0u32;
            let mut n = 0u32;
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let i = (sy * bw + sx) * 4;
                    // luminance of the premultiplied-over-white pixel
                    sum += (bmp.rgba[i] as u32 * 299
                        + bmp.rgba[i + 1] as u32 * 587
                        + bmp.rgba[i + 2] as u32 * 114)
                        / 1000;
                    n += 1;
                }
            }
            *cell = (sum / n.max(1)) as u8;
        }
    }
    Some((height, out))
}

#[test]
fn every_corpus_page_renders_the_same_as_its_golden() {
    let golden_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/golden");
    let update = std::env::var("UPDATE_GOLDEN").is_ok();
    if update {
        std::fs::create_dir_all(&golden_dir).unwrap();
    }
    let mut missing: Vec<String> = vec![];
    let mut changed: Vec<String> = vec![];
    let mut checked = 0;
    for file in corpus_files() {
        let stem = file.file_stem().unwrap().to_string_lossy().to_string();
        let Some((height, thumb)) = thumbnail(&file) else {
            panic!("{stem}: page 1 could not be rendered");
        };
        // a tiny header keeps the geometry honest: a page that changes shape must fail
        let mut blob = vec![
            (WIDTH >> 8) as u8,
            WIDTH as u8,
            (height >> 8) as u8,
            height as u8,
        ];
        blob.extend_from_slice(&thumb);
        let path = golden_dir.join(format!("{stem}.gray"));
        if update {
            std::fs::write(&path, &blob).unwrap();
            continue;
        }
        let Ok(reference) = std::fs::read(&path) else {
            missing.push(stem);
            continue;
        };
        checked += 1;
        if reference.len() != blob.len() || reference[..4] != blob[..4] {
            changed.push(format!("{stem}: page geometry changed"));
            continue;
        }
        let diff: f32 = reference[4..]
            .iter()
            .zip(blob[4..].iter())
            .map(|(a, b)| (*a as f32 - *b as f32).abs())
            .sum::<f32>()
            / (thumb.len() as f32);
        if diff > TOLERANCE {
            changed.push(format!(
                "{stem}: mean difference {diff:.2} grey levels (tolerance {TOLERANCE})"
            ));
        }
    }
    if update {
        eprintln!("golden references rewritten");
        return;
    }
    assert!(missing.is_empty(), "no golden reference for: {missing:?} — run UPDATE_GOLDEN=1 cargo test -p warraq-core --test golden");
    assert!(
        changed.is_empty(),
        "rendering changed:\n  {}",
        changed.join("\n  ")
    );
    assert!(checked > 40, "only {checked} pages were compared");
}
