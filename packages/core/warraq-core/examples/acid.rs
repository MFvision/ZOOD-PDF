//! Run the Warraq core through the same acid harness as the candidate engines:
//! writes tests/acid/results-warraq.json and page-1 screenshots.
use std::path::{Path, PathBuf};
use std::time::Instant;

fn jpeg(path: &Path, bmp: &warraq_render::Bitmap) {
    let img = image::RgbaImage::from_raw(bmp.width, bmp.height, bmp.rgba.clone()).unwrap();
    let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
    let rgb = if rgb.width() > 900 {
        image::imageops::resize(
            &rgb,
            900,
            rgb.height() * 900 / rgb.width(),
            image::imageops::FilterType::Triangle,
        )
    } else {
        rgb
    };
    let mut f = std::fs::File::create(path).unwrap();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut f, 80)
        .encode_image(&rgb)
        .unwrap();
}

fn main() {
    let repo = PathBuf::from(std::env::args().nth(1).expect("repo root"));
    let corpus = repo.join("tests/corpus/arabic");
    let shots = repo.join("docs/research/screenshots/warraq");
    std::fs::create_dir_all(&shots).unwrap();
    let mut files: Vec<PathBuf> = vec![];
    for d in ["generated", "realworld"] {
        if let Ok(rd) = std::fs::read_dir(corpus.join(d)) {
            let mut v: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().map(|e| e == "pdf").unwrap_or(false))
                .collect();
            v.sort();
            files.extend(v);
        }
    }
    let mut out = serde_json::Map::new();
    for f in files {
        let stem = f.file_stem().unwrap().to_string_lossy().to_string();
        let pw = if stem.starts_with("variant-encrypted") {
            Some("warraq")
        } else {
            None
        };
        let t0 = Instant::now();
        let r = match warraq_core::Document::open(std::fs::read(&f).unwrap(), pw) {
            Err(e) => serde_json::json!({"open": false, "error": e.to_string()}),
            Ok(doc) => {
                let t_open = t0.elapsed().as_secs_f64() * 1000.0;
                let t1 = Instant::now();
                let bmp = doc.render_page(0, 1.5);
                let t_render = t1.elapsed().as_secs_f64() * 1000.0;
                if let Ok(b) = &bmp {
                    jpeg(&shots.join(format!("{stem}.jpg")), b);
                }
                let t2 = Instant::now();
                let n = doc.page_count();
                let text: Vec<String> = (0..n.min(3))
                    .map(|i| doc.extract_text(i).unwrap_or_default())
                    .collect();
                let t_text = t2.elapsed().as_secs_f64() * 1000.0;
                let mut r = serde_json::json!({"open": true, "pages": n, "t_open_ms": (t_open * 10.0).round() / 10.0, "t_render_p1_ms": (t_render * 10.0).round() / 10.0,
                    "t_text_ms": (t_text * 10.0).round() / 10.0, "shot": format!("docs/research/screenshots/warraq/{stem}.jpg"), "selectable": text.iter().any(|t| !t.trim().is_empty()), "text": text.join("\n")});
                if n >= 100 {
                    let t3 = Instant::now();
                    for i in 0..n {
                        let _ = doc.extract_text(i);
                    }
                    r["t_text_all_pages_ms"] =
                        serde_json::json!((t3.elapsed().as_secs_f64() * 10000.0).round() / 10.0);
                }
                r
            }
        };
        println!(
            "warraq  {:<45} {} {}ms open {}ms render",
            stem,
            if r["open"].as_bool().unwrap_or(false) {
                "OK "
            } else {
                "ERR"
            },
            r["t_open_ms"],
            r["t_render_p1_ms"]
        );
        out.insert(stem, r);
    }
    std::fs::write(
        repo.join("tests/acid/results-warraq.json"),
        serde_json::to_string_pretty(&serde_json::Value::Object(out)).unwrap(),
    )
    .unwrap();
}
