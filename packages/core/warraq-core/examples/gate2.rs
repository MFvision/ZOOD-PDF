//! GATE 2 evidence: edit a real Word-exported Arabic PDF and a scanned Arabic PDF,
//! save, and render before/after. Verification in other engines is done by the
//! companion script `tests/acid/verify_gate2.py`.
//!
//! usage: gate2 <repo-root>
use std::path::PathBuf;

fn png(path: &PathBuf, b: &warraq_render::Bitmap) {
    let img = image::RgbaImage::from_raw(b.width, b.height, b.rgba.clone()).unwrap();
    image::DynamicImage::ImageRgba8(img)
        .to_rgb8()
        .save(path)
        .unwrap();
}

fn main() {
    let repo = PathBuf::from(std::env::args().nth(1).expect("repo root"));
    let out = repo.join("docs/gate2");
    std::fs::create_dir_all(&out).unwrap();
    let font = std::fs::read(repo.join("tests/fonts/Amiri-Regular.ttf")).unwrap();

    // 1. a real Microsoft Word export (Arabic, PDFMaker/pdf-tools producer)
    let word = repo.join(
        "tests/corpus/arabic/realworld/A_worldbank_malpass_g7_briefing_AR_word2016_pdftools.pdf",
    );
    let mut doc = warraq_core::Document::open(std::fs::read(&word).unwrap(), None).unwrap();
    png(
        &out.join("word-before.png"),
        &doc.render_page(0, 1.4).unwrap(),
    );
    let paras = doc.paragraphs(0).unwrap();
    println!("Word export: {} paragraphs on page 1", paras.len());
    for (i, p) in paras.iter().enumerate().take(6) {
        println!(
            "  [{i}] {} line(s) {:?} {:?} size {:.1}  {:?}",
            p.lines.len(),
            p.direction,
            p.alignment,
            p.font_size,
            p.text.chars().take(48).collect::<String>()
        );
    }
    let target = paras
        .iter()
        .position(|p| p.lines.len() >= 2 && p.direction == warraq_text::Direction::Rtl)
        .expect("a multi-line Arabic paragraph");
    let new_text = "كلمة حرّرها محرّر وراق داخل ملف صادر عن Microsoft Word — ١٧ سبتمبر ٢٠٢٦";
    let r = doc.replace_paragraph(0, target, new_text, &font).unwrap();
    println!("  replaced paragraph {target}: {} lines at {:.1}pt, shrunk to fit: {}, overflowed: {}, font substituted: {}", r.lines_drawn, r.font_size, r.shrunk, r.overflowed, r.font_substituted);
    let bytes = doc.save().unwrap();
    std::fs::write(out.join("word-after.pdf"), &bytes).unwrap();
    let after = warraq_core::Document::open(bytes, None).unwrap();
    png(
        &out.join("word-after.png"),
        &after.render_page(0, 1.4).unwrap(),
    );

    // 2. a scanned Arabic page: no text layer at all, so editing means adding shaped text
    let scan = repo.join("tests/corpus/arabic/generated/scan-notonaskh-300dpi-skewed-jpeg.pdf");
    let mut doc = warraq_core::Document::open(std::fs::read(&scan).unwrap(), None).unwrap();
    png(
        &out.join("scan-before.png"),
        &doc.render_page(0, 1.0).unwrap(),
    );
    let (w, h) = doc.page_size(0).unwrap();
    println!(
        "Scan: {w:.0}x{h:.0} pt, extracted text is {} characters",
        doc.extract_text(0).unwrap().trim().len()
    );
    warraq_pdf::ops::append_line(
        doc.pdf_mut(),
        0,
        "أضاف وراق هذا السطر فوق صفحة ممسوحة ضوئياً — ١٧ سبتمبر ٢٠٢٦",
        &font,
        16.0,
        w - 48.0,
        40.0,
    )
    .unwrap();
    let bytes = doc.save().unwrap();
    std::fs::write(out.join("scan-after.pdf"), &bytes).unwrap();
    let after = warraq_core::Document::open(bytes, None).unwrap();
    png(
        &out.join("scan-after.png"),
        &after.render_page(0, 1.0).unwrap(),
    );
    println!(
        "  scan now extracts: {:?}",
        after
            .extract_text(0)
            .unwrap()
            .trim()
            .chars()
            .take(60)
            .collect::<String>()
    );
    println!("wrote {}", out.display());
}
