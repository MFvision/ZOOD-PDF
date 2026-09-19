//! Page marks through `call_static`, the way the interface reaches them:
//! each kind is written, read back by Warraq's own reader in the right words
//! and in the right place, kept out of the page's text, drawn where it
//! should be, and taken off again without a trace.
use serde_json::{json, Value};
use warraq_core::{call_static, Document, Reply};

const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");

fn corpus(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../../../tests/corpus/arabic/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

const THREE: &str = "generated/chrome-notonaskh-justified-3pages.pdf";

fn value(reply: &Reply) -> Value {
    serde_json::from_str(&reply.json).unwrap()
}

/// `marks.add` with the font as blob 1; the marked file.
fn add(pdf: &[u8], mark: Value, pages: &[usize]) -> Vec<u8> {
    let reply = call_static(
        "marks.add",
        &json!({ "mark": mark, "pages": pages, "fontBlob": 1 }).to_string(),
        vec![pdf.to_vec(), AMIRI.to_vec()],
    )
    .unwrap();
    reply.blobs.into_iter().next().unwrap()
}

fn marks_text(pdf: &[u8], page: usize) -> (String, String) {
    let reply = call_static(
        "marks.text",
        &json!({ "page": page }).to_string(),
        vec![pdf.to_vec()],
    )
    .unwrap();
    let v = value(&reply);
    (
        v["marks"].as_str().unwrap().to_string(),
        v["page"].as_str().unwrap().to_string(),
    )
}

/// Where a line saying `needle` is on the page as shown: its box.
fn line_at(pdf: &[u8], page: usize, needle: &str) -> (f32, f32, f32, f32) {
    let doc = Document::open(pdf.to_vec(), None).unwrap();
    let line = doc
        .artifact_lines(page)
        .unwrap()
        .into_iter()
        .find(|l| l.text.contains(needle))
        .unwrap_or_else(|| panic!("no mark line with {needle:?}"));
    (line.x, line.y, line.width, line.height)
}

#[test]
fn an_arabic_header_footer_and_page_numbers_read_back_and_stay_out_of_the_text() {
    let original = corpus(THREE);
    let before = Document::open(original.clone(), None).unwrap();
    let page_text: Vec<String> = (0..3).map(|i| before.extract_text(i).unwrap()).collect();

    let pdf = add(
        &original,
        json!({ "kind": "header", "slots": ["التقرير السنوي", "", "{date}"], "date": "١٨ ربيع الأول ١٤٤٨ هـ", "size": 11 }),
        &[],
    );
    let pdf = add(
        &pdf,
        json!({ "kind": "footer", "slots": ["{file}", "", ""], "fileName": "تقرير.pdf", "size": 10, "marginY": 60 }),
        &[],
    );
    let pdf = add(
        &pdf,
        json!({ "kind": "pageNumber", "format": "pageOfArabic", "position": "bottom", "numerals": "arabic", "size": 10 }),
        &[],
    );
    assert!(pdf.starts_with(&original), "an incremental update");

    for page in 0..3 {
        let (marks, text) = marks_text(&pdf, page);
        assert!(marks.contains("التقرير السنوي"), "page {page}: {marks}");
        assert!(
            marks.contains("١٨ ربيع الأول ١٤٤٨ هـ"),
            "page {page}: {marks}"
        );
        assert!(marks.contains("تقرير.pdf"), "page {page}: {marks}");
        let number = format!("صفحة {} من ٣", ["١", "٢", "٣"][page]);
        assert!(marks.contains(&number), "page {page}: {marks}");
        assert_eq!(
            text, page_text[page],
            "page {page}: the marks leaked into the text"
        );
    }

    // An Arabic header starts on the right, the date is at the left end,
    // both at the top; the footer and the number are at the bottom.
    let doc = Document::open(pdf.clone(), None).unwrap();
    let (width, height) = doc.page_size(0).unwrap();
    let (x, y, w, _) = line_at(&pdf, 0, "التقرير السنوي");
    assert!(y < 60.0, "the header is at the top: {y}");
    assert!(
        (x + w - (width - 36.0)).abs() < 3.0,
        "ends at the right margin: {x} + {w}"
    );
    let (x, _, _, _) = line_at(&pdf, 0, "ربيع");
    assert!((x - 36.0).abs() < 3.0, "the date is at the left: {x}");
    let (x, y, w, _) = line_at(&pdf, 1, "صفحة");
    assert!(y > height - 60.0, "the number is at the bottom: {y}");
    assert!(((x + w / 2.0) - width / 2.0).abs() < 3.0, "and centred");
}

#[test]
fn bates_numbers_run_across_the_file_and_an_english_footer_starts_on_the_left() {
    let original = corpus(THREE);
    let pdf = add(
        &original,
        json!({ "kind": "bates", "prefix": "WRQ-", "start": 41, "width": 6, "position": "topRight", "size": 9 }),
        &[],
    );
    let pdf = add(
        &pdf,
        json!({ "kind": "footer", "slots": ["Confidential", "", "Page {page} of {pages}"], "size": 9, "marginY": 40 }),
        &[1, 2],
    );
    for (page, bates) in ["WRQ-000041", "WRQ-000042", "WRQ-000043"]
        .iter()
        .enumerate()
    {
        let (marks, _) = marks_text(&pdf, page);
        assert!(marks.contains(bates), "page {page}: {marks}");
    }
    let (marks, _) = marks_text(&pdf, 0);
    assert!(!marks.contains("Confidential"), "not on the first page");
    let (marks, _) = marks_text(&pdf, 2);
    assert!(marks.contains("Page 3 of 3"), "{marks}");
    let doc = Document::open(pdf.clone(), None).unwrap();
    let (width, _) = doc.page_size(1).unwrap();
    let (x, _, _, _) = line_at(&pdf, 1, "Confidential");
    assert!(
        (x - 36.0).abs() < 3.0,
        "a Latin footer starts on the left: {x}"
    );
    let (x, _, w, _) = line_at(&pdf, 1, "WRQ-");
    assert!(
        (x + w - (width - 36.0)).abs() < 3.0,
        "Bates at the top right"
    );

    // Listed, each with the pages it is on and what it was made with.
    let listed = value(&call_static("marks.list", "{}", vec![pdf.clone()]).unwrap());
    let marks = listed["marks"].as_array().unwrap();
    assert_eq!(marks.len(), 2);
    assert_eq!(marks[0]["kind"], "bates");
    assert_eq!(marks[0]["pages"], json!([0, 1, 2]));
    assert_eq!(marks[0]["spec"]["prefix"], "WRQ-");
    assert_eq!(marks[1]["pages"], json!([1, 2]));
}

#[test]
fn on_a_turned_page_a_header_is_at_the_top_the_reader_sees() {
    let mut doc = Document::open(corpus(THREE), None).unwrap();
    doc.call("pages.rotate", r#"{"pages":[0],"quarterTurns":1}"#, vec![])
        .unwrap();
    let turned = doc.save().unwrap();
    let pdf = add(
        &turned,
        json!({ "kind": "header", "slots": ["Quarterly", "", ""], "size": 12, "marginY": 20 }),
        &[0],
    );
    let doc = Document::open(pdf.clone(), None).unwrap();
    let (width, height) = doc.page_size(0).unwrap();
    assert!(width > height, "shown landscape");
    let (x, y, _, h) = line_at(&pdf, 0, "Quarterly");
    assert!(
        y < 40.0 && h < 30.0,
        "upright, at the top: y {y}, height {h}"
    );
    assert!((x - 36.0).abs() < 3.0, "at the left: {x}");
}

/// Share of the pixels in a box that are strongly red.
fn red_share(pdf: &[u8], page: usize, (x0, y0, x1, y1): (f32, f32, f32, f32)) -> f32 {
    let doc = Document::open(pdf.to_vec(), None).unwrap();
    let bitmap = doc.render_page(page, 1.0).unwrap();
    let (w, h) = (bitmap.width as f32, bitmap.height as f32);
    let (mut red, mut all) = (0, 0);
    for y in (y0 * h) as u32..(y1 * h) as u32 {
        for x in (x0 * w) as u32..(x1 * w) as u32 {
            let k = ((y * bitmap.width + x) * 4) as usize;
            let p = &bitmap.rgba[k..k + 3];
            all += 1;
            if p[0] > 150 && p[1] < 120 && p[2] < 120 {
                red += 1;
            }
        }
    }
    red as f32 / all.max(1) as f32
}

#[test]
fn a_watermark_is_drawn_where_it_should_be_and_comes_off_without_a_trace() {
    let original = corpus(THREE);
    let pdf = add(
        &original,
        json!({ "kind": "watermark", "text": "سري", "size": 150, "color": "#e01010", "opacity": 0.8, "rotation": 45, "front": true }),
        &[],
    );
    let centre = (0.35, 0.4, 0.65, 0.6);
    assert!(red_share(&original, 0, centre) < 0.01);
    let drawn = red_share(&pdf, 1, centre);
    assert!(drawn > 0.05, "red in the middle of the page: {drawn}");
    let (marks, _) = marks_text(&pdf, 1);
    assert!(marks.contains("سري"), "{marks}");

    // Off again: the page's content is what it was, byte for byte.
    let reply = call_static("marks.remove", "{}", vec![pdf.clone()]).unwrap();
    assert_eq!(value(&reply)["removed"], 3);
    let cleaned = reply.blobs.into_iter().next().unwrap();
    let a = warraq_pdf::PdfDocument::open(original.clone(), None).unwrap();
    let b = warraq_pdf::PdfDocument::open(cleaned.clone(), None).unwrap();
    for page in 0..3 {
        let id = a.page_id(page).unwrap();
        assert_eq!(
            a.doc_ref().get_dictionary(id).unwrap(),
            b.doc_ref().get_dictionary(id).unwrap(),
            "page {page}"
        );
        assert_eq!(
            a.doc_ref().get_page_content(id),
            b.doc_ref().get_page_content(id),
            "page {page}: content"
        );
    }
    assert!(red_share(&cleaned, 1, centre) < 0.01);
}

#[test]
fn a_behind_watermark_with_a_picture_and_a_protected_file_that_stays_protected() {
    let mut png = Vec::new();
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(40, 40, image::Rgb([230, 0, 0])))
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    let original = corpus("generated/variant-encrypted-aes256.pdf");
    let reply = call_static(
        "marks.add",
        &json!({
            "password": "warraq",
            "mark": { "kind": "watermark", "imageWidth": 0.3, "front": false, "opacity": 0.5 },
            "imageBlob": 1,
        })
        .to_string(),
        vec![original.clone(), png],
    )
    .unwrap();
    let pdf = reply.blobs.into_iter().next().unwrap();
    assert!(pdf.starts_with(&original));
    assert!(
        Document::open(pdf.clone(), None).is_err(),
        "still needs its password"
    );
    let doc = Document::open(pdf, Some("warraq")).unwrap();
    assert!(doc.extract_text(0).unwrap().contains("وراق") || doc.page_count() == 3);
}

#[test]
fn the_preview_draws_one_page_as_the_mark_would() {
    let original = corpus(THREE);
    let reply = call_static(
        "marks.preview",
        &json!({
            "mark": { "kind": "pageNumber", "format": "ofTotal", "position": "bottom", "color": "#e01010", "size": 40 },
            "page": 2, "scale": 0.5, "fontBlob": 1,
        })
        .to_string(),
        vec![original, AMIRI.to_vec()],
    )
    .unwrap();
    let v = value(&reply);
    let (w, h) = (v["width"].as_u64().unwrap(), v["height"].as_u64().unwrap());
    assert_eq!(reply.blobs[0].len() as u64, w * h * 4);
    // Red ink near the bottom of the page.
    let bottom = &reply.blobs[0][((h * 9 / 10) * w * 4) as usize..];
    assert!(bottom.chunks(4).any(|p| p[0] > 150 && p[1] < 120));
}

#[test]
fn bad_arguments_are_errors_not_panics() {
    let pdf = corpus(THREE);
    for args in [
        json!({ "mark": { "kind": "nonsense" } }),
        json!({ "mark": { "kind": "header" } }),
        json!({ "mark": { "kind": "watermark", "text": "x" } }),
        json!({ "mark": { "kind": "watermark", "text": "x", "size": -3 }, "fontBlob": 1 }),
        json!({ "mark": { "kind": "watermark", "text": "x", "position": "nowhere" }, "fontBlob": 1 }),
        json!({ "mark": { "kind": "watermark" }, "imageBlob": 1 }),
        json!({ "mark": { "kind": "bates" }, "pages": [99], "fontBlob": 1 }),
    ] {
        let r = call_static(
            "marks.add",
            &args.to_string(),
            vec![pdf.clone(), b"not a font or a picture".to_vec()],
        );
        assert!(r.is_err(), "{args}");
    }
    assert!(call_static("marks.list", "{}", vec![b"%PDF-1.7 junk".to_vec()]).is_err());
}

#[test]
fn a_mark_being_changed_takes_the_place_of_the_old_one() {
    let pdf = add(
        &corpus(THREE),
        json!({ "kind": "watermark", "text": "مسودة", "size": 40 }),
        &[0, 1],
    );
    let reply = call_static(
        "marks.add",
        &json!({
            "mark": { "kind": "watermark", "text": "نهائي", "size": 40 },
            "pages": [1, 2],
            "replace": false,
            "replaceIds": [1],
            "fontBlob": 1,
        })
        .to_string(),
        vec![pdf, AMIRI.to_vec()],
    )
    .unwrap();
    let pdf = reply.blobs.into_iter().next().unwrap();
    let listed = value(&call_static("marks.list", "{}", vec![pdf.clone()]).unwrap());
    let marks = listed["marks"].as_array().unwrap();
    assert_eq!(marks.len(), 1, "{listed}");
    assert_eq!(marks[0]["pages"], json!([1, 2]));
    assert_eq!(marks[0]["spec"]["text"], "نهائي");
    assert!(!marks_text(&pdf, 0).0.contains("مسودة"));
}
