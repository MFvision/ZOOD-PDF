//! Phase 0 probe: PDFium through pdfium-render (native dynamic library).
//! `run <repo> <pdfium-lib-dir>` mirrors the Python harness; `edit` replaces the
//! text of the first text object with Arabic through FPDFText_SetText to show
//! what PDFium's own editing path does with Arabic (no shaping).
use pdfium_render::prelude::*;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn run_one(pdfium: &Pdfium, path: &Path, shots: &Path) -> serde_json::Value {
    let stem = path.file_stem().unwrap().to_string_lossy().to_string();
    let pw = if stem.starts_with("variant-encrypted") { Some("warraq") } else { None };
    let t0 = Instant::now();
    let doc = match pdfium.load_pdf_from_file(path, pw) { Ok(d) => d, Err(e) => return serde_json::json!({"open": false, "error": format!("{e:?}")}) };
    let n = doc.pages().len();
    let page = match doc.pages().get(0) { Ok(p) => p, Err(e) => return serde_json::json!({"open": false, "error": format!("{e:?}")}) };
    let t_open = t0.elapsed().as_secs_f64() * 1000.0;
    let t1 = Instant::now();
    let img = page.render_with_config(&PdfRenderConfig::new().set_target_width(893)).unwrap().as_image().unwrap();
    let t_render = t1.elapsed().as_secs_f64() * 1000.0;
    let dir = shots.join("pdfium-rs"); std::fs::create_dir_all(&dir).unwrap();
    let mut f = std::fs::File::create(dir.join(format!("{stem}.jpg"))).unwrap();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut f, 80).encode_image(&img.to_rgb8()).unwrap();
    let t2 = Instant::now();
    let mut texts = vec![];
    for i in 0..n.min(3) { if let Ok(p) = doc.pages().get(i) { if let Ok(t) = p.text() { texts.push(t.all()); } } }
    let t_text = t2.elapsed().as_secs_f64() * 1000.0;
    let text = texts.join("\n");
    serde_json::json!({"open": true, "pages": n, "t_open_ms": (t_open * 10.0).round() / 10.0, "t_render_p1_ms": (t_render * 10.0).round() / 10.0,
        "t_text_ms": (t_text * 10.0).round() / 10.0, "shot": format!("docs/research/screenshots/pdfium-rs/{stem}.jpg"), "selectable": !text.trim().is_empty(), "text": text})
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let libdir = &args[3];
    let pdfium = Pdfium::new(Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(libdir)).expect("bind pdfium"));
    let repo = PathBuf::from(&args[2]);
    match args[1].as_str() {
        "run" => {
            let corpus = repo.join("tests/corpus/arabic"); let shots = repo.join("docs/research/screenshots");
            let mut files: Vec<PathBuf> = vec![];
            for d in ["generated", "realworld"] { if let Ok(rd) = std::fs::read_dir(corpus.join(d)) { let mut v: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().map(|e| e == "pdf").unwrap_or(false)).collect(); v.sort(); files.extend(v); } }
            let mut out = serde_json::Map::new();
            for f in files {
                let stem = f.file_stem().unwrap().to_string_lossy().to_string();
                let r = run_one(&pdfium, &f, &shots);
                println!("pdfium-rs {:<43} {} {}ms open {}ms render", stem, if r["open"].as_bool().unwrap_or(false) { "OK " } else { "ERR" }, r["t_open_ms"], r["t_render_p1_ms"]);
                out.insert(stem, r);
            }
            std::fs::write(repo.join("tests/acid/results-pdfium-rs.json"), serde_json::to_string_pretty(&serde_json::Value::Object(out)).unwrap()).unwrap();
        }
        "edit" => {
            let input = repo.join("tests/corpus/arabic/generated/raw-amiri-cid-identity-tounicode.pdf");
            let out = repo.join("tests/acid/write-tests/out-pdfium-rs-edit.pdf");
            let mut doc = pdfium.load_pdf_from_file(&input, None).unwrap();
            let mut page = doc.pages_mut().get(0).unwrap();
            let mut edited = 0;
            for mut obj in page.objects_mut().iter() {
                if let Some(t) = obj.as_text_object_mut() {
                    if t.text().contains("زود") { t.set_text("مؤسسة وراق للتقنية").unwrap(); edited += 1; break; }
                }
            }
            page.regenerate_content().unwrap();
            doc.save_to_file(&out).unwrap();
            println!("pdfium-rs edit: replaced {edited} text object(s) via FPDFText_SetText -> {}", out.display());
        }
        _ => eprintln!("usage: proto-pdfium run|edit <repo> <pdfium-lib-dir>"),
    }
}
