//! Demo: detect the paragraphs of a page, reflow one, save, and render before/after.
//! usage: reflow_demo <repo> <corpus-stem> <paragraph-index> <new text>
use std::path::PathBuf;

fn png(path: &PathBuf, b: &warraq_render::Bitmap) {
    let img = image::RgbaImage::from_raw(b.width, b.height, b.rgba.clone()).unwrap();
    image::DynamicImage::ImageRgba8(img)
        .to_rgb8()
        .save(path)
        .unwrap();
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let repo = PathBuf::from(&a[1]);
    let src = repo.join(format!("tests/corpus/arabic/generated/{}.pdf", a[2]));
    let idx: usize = a[3].parse().unwrap();
    let new_text = &a[4];
    let out_dir = repo.join("tests/acid/write-tests");
    let font = std::fs::read(repo.join("tests/fonts/Amiri-Regular.ttf")).unwrap();

    let mut doc = warraq_core::Document::open(std::fs::read(&src).unwrap(), None).unwrap();
    png(
        &out_dir.join("reflow-before.png"),
        &doc.render_page(0, 1.3).unwrap(),
    );
    for (i, p) in doc.paragraphs(0).unwrap().iter().enumerate() {
        println!(
            "para {i}: {} line(s) {:?} {:?} bbox={:?} leading={:.1} size={:.1}\n    {:?}",
            p.lines.len(),
            p.direction,
            p.alignment,
            p.bbox,
            p.leading,
            p.font_size,
            p.text.chars().take(60).collect::<String>()
        );
    }
    let r = doc.replace_paragraph(0, idx, new_text, &font).unwrap();
    println!(
        "replaced paragraph {idx}: {} lines drawn, font substituted: {}",
        r.lines_drawn, r.font_substituted
    );
    let bytes = doc.save().unwrap();
    let out = out_dir.join("reflow-after.pdf");
    std::fs::write(&out, &bytes).unwrap();
    let after = warraq_core::Document::open(bytes, None).unwrap();
    png(
        &out_dir.join("reflow-after.png"),
        &after.render_page(0, 1.3).unwrap(),
    );
    println!("--- text of the edited page after reopening ---");
    for l in after.extract_text(0).unwrap().lines().take(8) {
        println!("  {l}");
    }
}
