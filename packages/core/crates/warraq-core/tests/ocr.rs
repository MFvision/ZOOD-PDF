//! Scan & OCR text layer (`ocr.addTextLayer`, `ocr.createPdf`): invisible text over page images,
//! read back by warraq-text in logical order.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use serde_json::{json, Value};
use warraq_core::warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_core::warraq_pdf::lopdf::{Document as LoDoc, Object};
use warraq_core::{call_static, Document, Reply};

fn a4() -> Vec<u8> {
    sample_pdf(2, &SampleOptions::default()).unwrap()
}

fn call(doc: &mut Document, m: &str, p: Value) -> Reply {
    doc.call(m, &p, vec![])
        .unwrap_or_else(|e| panic!("{m}: {e}"))
}

fn plain(bytes: &[u8]) -> Vec<String> {
    let mut d = Document::open(bytes.to_vec(), None).unwrap();
    let r = call(&mut d, "text.plain", json!({}));
    r.json["pages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap().to_string())
        .collect()
}

/// A4 at 300 dpi = 2480 × 3508 px (595 × 842 pt).
fn arabic_line_words() -> Value {
    // One RTL line: the first (logical) word is the RIGHTMOST box.
    json!([
        { "text": "التحول", "bbox": [1900, 400, 2200, 470], "conf": 93.0, "line": 0 },
        { "text": "الرقمي", "bbox": [1600, 400, 1860, 470], "conf": 91.0, "line": 0 },
        { "text": "في", "bbox": [1480, 400, 1560, 470], "conf": 95.0, "line": 0 },
        { "text": "المؤسسات", "bbox": [1000, 400, 1440, 470], "conf": 88.0, "line": 0 },
        { "text": "Report", "bbox": [300, 700, 600, 770], "conf": 96.0, "line": 1 },
        { "text": "2026", "bbox": [640, 700, 820, 770], "conf": 97.0, "line": 1 },
    ])
}

fn layer(words: Value, angle: f64) -> Value {
    json!({ "page": 0, "imageWidth": 2480, "imageHeight": 3508, "imageDpi": 300, "angle": angle, "words": words })
}

fn page_content(bytes: &[u8], page: usize) -> String {
    let doc = LoDoc::load_mem(bytes).unwrap();
    let pid = *doc.get_pages().values().nth(page).unwrap();
    String::from_utf8_lossy(&doc.get_page_content(pid)).into_owned()
}

#[test]
fn text_layer_reads_back_in_logical_order_and_is_incremental() {
    let original = a4();
    let mut d = Document::open(original.clone(), None).unwrap();
    let r = call(&mut d, "ocr.addTextLayer", layer(arabic_line_words(), 0.0));
    assert_eq!(r.json["words"], 6);
    let out = &r.blobs[0];
    // incremental update: the original bytes are an exact prefix
    assert!(out.len() > original.len());
    assert_eq!(&out[..original.len()], &original[..]);
    assert_eq!(r.json["revisions"], 2);

    let pages = plain(out);
    let p0 = &pages[0];
    assert!(
        p0.contains("التحول الرقمي في المؤسسات"),
        "logical order expected, got {p0:?}"
    );
    assert!(p0.contains("Report 2026"), "{p0:?}");
    assert!(p0.contains("Page 1"), "existing text kept: {p0:?}");
    // page 2 untouched
    assert!(!pages[1].contains("التحول"));

    let content = page_content(out, 0);
    assert!(content.contains("3 Tr"), "invisible text: {content}");
    assert!(
        content.contains("/ActualText"),
        "LTR words carry ActualText: {content}"
    );
    assert!(
        content.contains("/ReversedChars BMC"),
        "RTL words: {content}"
    );
    assert!(content.contains(" Tz"), "horizontal scaling to the bbox");
    assert!(!String::from_utf8_lossy(out).contains("/Direction"));
}

#[test]
fn search_finds_ocr_words_with_arabic_normalisation() {
    let mut d = Document::open(a4(), None).unwrap();
    let r = call(&mut d, "ocr.addTextLayer", layer(arabic_line_words(), 0.0));
    let mut d2 = Document::open(r.blobs[0].clone(), None).unwrap();
    let hits = call(&mut d2, "text.search", json!({ "query": "المؤسسات" }));
    let hits = hits.json["hits"].as_array().unwrap();
    assert_eq!(hits.len(), 1, "{hits:?}");
}

#[test]
fn words_land_on_their_image_boxes() {
    let mut d = Document::open(a4(), None).unwrap();
    let words = json!([{ "text": "Report", "bbox": [300, 700, 600, 770], "conf": 96.0 }]);
    let r = call(&mut d, "ocr.addTextLayer", layer(words, 0.0));
    let mut d2 = Document::open(r.blobs[0].clone(), None).unwrap();
    let hits = call(&mut d2, "text.search", json!({ "query": "Report" }));
    let s = serde_json::to_string(&hits.json).unwrap();
    // x ≈ 300/300*72 = 72 pt … 144 pt
    let rects = find_numbers(&hits.json);
    assert!(
        rects.iter().any(|v| (v - 72.0).abs() < 3.0)
            && rects.iter().any(|v| (v - 144.0).abs() < 3.0),
        "{s}"
    );
}

fn find_numbers(v: &Value) -> Vec<f64> {
    match v {
        Value::Number(n) => n.as_f64().into_iter().collect(),
        Value::Array(a) => a.iter().flat_map(find_numbers).collect(),
        Value::Object(o) => o.values().flat_map(find_numbers).collect(),
        _ => vec![],
    }
}

#[test]
fn crooked_page_gets_a_rotated_text_layer() {
    let mut d = Document::open(a4(), None).unwrap();
    let r = call(&mut d, "ocr.addTextLayer", layer(arabic_line_words(), 8.0));
    let content = page_content(&r.blobs[0], 0);
    // Every word, RTL or LTR, is drawn with the same upright matrix rotated by the skew.
    let (c, s) = (8f64.to_radians().cos(), 8f64.to_radians().sin());
    let tm = format!("{:.4} {:.4} {:.4} {:.4}", c, s, -s, c);
    assert_eq!(
        content.matches(&tm).count(),
        6 + 4,
        "6 words and 4 RTL spaces, {tm} in {content}"
    );
    let mirrored = format!("{:.4} {:.4}", -c, -s);
    assert!(
        !content.contains(&mirrored),
        "no mirrored matrix: {content}"
    );
    let p0 = &plain(&r.blobs[0])[0];
    for w in ["التحول", "الرقمي", "المؤسسات", "Report"] {
        assert!(p0.contains(w), "{w} in {p0:?}");
    }
}

fn utf16_hex(s: &str) -> String {
    s.encode_utf16().map(|u| format!("{u:04X}")).collect()
}

#[test]
fn rtl_words_are_visual_order_reversed_chars_and_read_back_logically() {
    // PDFium (Chrome, the viewer) reads visual-order runs inside /ReversedChars in logical order;
    // it would reverse an /ActualText, so RTL words carry none.
    let mut d = Document::open(a4(), None).unwrap();
    let words = json!([
        { "text": "الرقمي", "bbox": [700, 100, 900, 140] },
        { "text": "عام2026م", "bbox": [400, 100, 650, 140] },
        { "text": "مُحَمَّد", "bbox": [150, 100, 380, 140] },
    ]);
    let r = call(&mut d, "ocr.addTextLayer", layer(words, 0.0));
    let content = page_content(&r.blobs[0], 0);
    assert!(!content.contains("ActualText"), "{content}");
    assert!(
        content.contains(&format!(
            "/ReversedChars BMC <{}> Tj EMC",
            utf16_hex("يمقرلا")
        )),
        "visual glyphs: {content}"
    );
    // digits keep their left-to-right order inside the right-to-left word
    assert!(
        content.contains(&format!("<{}> Tj", utf16_hex("م2026ماع"))),
        "{content}"
    );
    let p0 = &plain(&r.blobs[0])[0];
    assert!(
        p0.contains("الرقمي") && p0.contains("عام2026م") && p0.contains("مُحَمَّد"),
        "{p0:?}"
    );
    assert!(!p0.contains("  "), "one space between words: {p0:?}");
}

#[test]
fn tightly_set_words_stay_separate() {
    // Arabic words often sit a hair apart; the space glyph after each word keeps them apart.
    let mut d = Document::open(a4(), None).unwrap();
    let words = json!([
        { "text": "باسم", "bbox": [900, 100, 1000, 140] },
        { "text": "الوزارة", "bbox": [760, 100, 898, 140] },
    ]);
    let r = call(&mut d, "ocr.addTextLayer", layer(words, 0.0));
    let p0 = &plain(&r.blobs[0])[0];
    assert!(p0.contains("باسم الوزارة"), "{p0:?}");
}

#[test]
fn rotated_page_maps_display_coordinates() {
    // /Rotate 90: the rendered image is landscape (3508 × 2480 px at 300 dpi).
    let mut d = Document::open(a4(), None).unwrap();
    call(
        &mut d,
        "pages.rotate",
        json!({ "pages": [0], "degrees": 90 }),
    );
    let words = json!([{ "text": "Report", "bbox": [300, 300, 600, 370], "conf": 90 }]);
    let r = call(
        &mut d,
        "ocr.addTextLayer",
        json!({ "page": 0, "imageWidth": 3508, "imageHeight": 2480, "words": words }),
    );
    let content = page_content(&r.blobs[0], 0);
    // Display x runs along page +y for /Rotate 90: advance vector (0, 1).
    assert!(
        content.contains("0.0000 1.0000 -1.0000 0.0000"),
        "{content}"
    );
    assert!(plain(&r.blobs[0])[0].contains("Report"));
}

#[test]
fn deferred_commit_batches_pages_into_one_update() {
    let original = a4();
    let mut d = Document::open(original.clone(), None).unwrap();
    for page in 0..2 {
        let mut p = layer(arabic_line_words(), 0.0);
        p["page"] = json!(page);
        p["commit"] = json!(false);
        let r = d.call("ocr.addTextLayer", &p, vec![]).unwrap();
        assert!(r.blobs.is_empty());
    }
    let r = call(&mut d, "doc.save", json!({}));
    assert_eq!(r.json["revisions"], 2);
    let pages = plain(&r.blobs[0]);
    assert!(pages[0].contains("المؤسسات") && pages[1].contains("المؤسسات"));
    // one shared font for both pages
    let lo = LoDoc::load_mem(&r.blobs[0]).unwrap();
    let cid_fonts = lo
        .objects
        .values()
        .filter(|o| {
            o.as_dict()
                .ok()
                .and_then(|d| d.get(b"Subtype").ok())
                .and_then(|s| s.as_name().ok())
                == Some(b"CIDFontType2".as_slice())
        })
        .count();
    assert_eq!(cid_fonts, 1);
}

#[test]
fn low_confidence_and_empty_words_are_skipped() {
    let mut d = Document::open(a4(), None).unwrap();
    let words = json!([
        { "text": "   ", "bbox": [10, 10, 20, 20], "conf": 90 },
        { "text": "noise", "bbox": [10, 10, 20, 20], "conf": 5 },
        { "text": "kept", "bbox": [300, 300, 400, 340], "conf": 60 },
    ]);
    let mut p = layer(words, 0.0);
    p["minConf"] = json!(20);
    let r = call(&mut d, "ocr.addTextLayer", p);
    assert_eq!(r.json["words"], 1);
    let p0 = &plain(&r.blobs[0])[0];
    assert!(p0.contains("kept") && !p0.contains("noise"));
}

#[test]
fn hostile_parameters_are_rejected_without_panicking() {
    let mut d = Document::open(a4(), None).unwrap();
    let bad = [
        json!({ "page": 9, "imageWidth": 10, "imageHeight": 10, "words": [] }),
        json!({ "page": 0, "imageWidth": 0, "imageHeight": 10, "words": [] }),
        json!({ "page": 0, "imageWidth": 1e12, "imageHeight": 10, "words": [] }),
        json!({ "page": 0, "imageWidth": 10, "imageHeight": 10, "angle": 400, "words": [] }),
        json!({ "page": 0, "words": [] }),
        json!({ "page": 0, "imageWidth": 10, "imageHeight": 10, "words": [{ "text": "x", "bbox": [1, 2, 3] }] }),
        json!({ "page": 0, "imageWidth": 10, "imageHeight": 10, "words": [{ "text": "x", "bbox": [3, 2, 1, 1] }] }),
        json!({ "page": 0, "imageWidth": 10, "imageHeight": 10, "words": [{ "text": "x".repeat(5000), "bbox": [0, 0, 1, 1] }] }),
    ];
    for p in bad {
        let e = d.call("ocr.addTextLayer", &p, vec![]).unwrap_err();
        assert_eq!(e.code, "invalid_params", "{p}");
    }
    let many: Vec<Value> = (0..20_001)
        .map(|_| json!({ "text": "a", "bbox": [0, 0, 1, 1] }))
        .collect();
    let e = d
        .call(
            "ocr.addTextLayer",
            &json!({ "page": 0, "imageWidth": 10, "imageHeight": 10, "words": many }),
            vec![],
        )
        .unwrap_err();
    assert_eq!(e.code, "invalid_params");
}

#[test]
fn glyphless_font_is_a_valid_truetype_font() {
    use read_fonts::TableProvider;
    let ttf = warraq_core::ocr::glyphless_font();
    let font = read_fonts::FontRef::new(&ttf).expect("parses");
    assert_eq!(font.maxp().unwrap().num_glyphs(), 2);
    assert_eq!(font.head().unwrap().units_per_em(), 1000);
    let hmtx = font.hmtx().unwrap();
    assert_eq!(hmtx.h_metrics()[1].advance(), 500);
    // Whole-font checksum: head.checkSumAdjustment makes the sum 0xB1B0AFBA.
    let mut sum = 0u32;
    for c in ttf.chunks(4) {
        let mut b = [0u8; 4];
        b[..c.len()].copy_from_slice(c);
        sum = sum.wrapping_add(u32::from_be_bytes(b));
    }
    assert_eq!(sum, 0xB1B0_AFBA);
}

// ---------------------------------------------------------------------------------------------
// ocr.createPdf: new pages from scanned images

/// 16×8 grayscale baseline JPEG header + data (made by Pillow, quality 90).
fn tiny_jpeg() -> Vec<u8> {
    let hex = include_str!("data/tiny-gray.jpg.hex");
    let clean: String = hex.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    (0..clean.len() / 2)
        .map(|i| u8::from_str_radix(&clean[2 * i..2 * i + 2], 16).unwrap())
        .collect()
}

#[test]
fn create_pdf_from_gray_and_jpeg_images_with_text_layers() {
    let (w, h) = (200usize, 100usize);
    let mut gray = vec![255u8; w * h];
    for y in 40..60 {
        for x in 20..180 {
            gray[y * w + x] = 0;
        }
    }
    let words = json!([{ "text": "زود", "bbox": [120, 30, 180, 70], "conf": 90 },
                       { "text": "PDF", "bbox": [20, 30, 100, 70], "conf": 90 }]);
    let params = json!({
        "title": "مسح ضوئي",
        "lang": "ar",
        "pages": [
            { "image": { "format": "gray", "blob": 0, "pixelWidth": w, "pixelHeight": h }, "imageDpi": 100, "words": words, "angle": 0 },
            { "image": { "format": "jpeg", "blob": 1 }, "imageDpi": 72, "words": [] }
        ]
    });
    let r = call_static("ocr.createPdf", &params, vec![gray, tiny_jpeg()]).unwrap();
    assert_eq!(r.json["pageCount"], 2);
    let bytes = &r.blobs[0];
    let lo = LoDoc::load_mem(bytes).unwrap();
    let pages: Vec<_> = lo.get_pages().values().copied().collect();
    // page size from the image size and dpi: 200 px at 100 dpi = 144 pt
    let mb = lo
        .get_dictionary(pages[0])
        .unwrap()
        .get(b"MediaBox")
        .unwrap()
        .as_array()
        .unwrap()
        .clone();
    let f = |o: &Object| o.as_float().unwrap() as f64;
    assert!((f(&mb[2]) - 144.0).abs() < 0.01 && (f(&mb[3]) - 72.0).abs() < 0.01);
    let s = String::from_utf8_lossy(bytes).into_owned();
    assert!(s.contains("/DCTDecode"), "jpeg passed through");
    assert!(
        s.contains("/BitsPerComponent 1"),
        "bilevel gray packed to 1 bit"
    );
    let p = plain(bytes);
    assert!(p[0].contains("زود") && p[0].contains("PDF"), "{:?}", p[0]);
}

#[test]
fn create_pdf_rejects_hostile_images() {
    let bad_jpeg = b"\xFF\xD8\xFF\xC0\x00\x0B\x08\xFF\xFF\xFF\xFF\x01\x01\x11\x00".to_vec();
    let gray = |w: u64, h: u64, dpi: f64| json!({ "pages": [{ "image": { "format": "gray", "blob": 0, "pixelWidth": w, "pixelHeight": h }, "imageDpi": dpi }] });
    let jpeg = |blob: u64| json!({ "pages": [{ "image": { "format": "jpeg", "blob": blob }, "imageDpi": 300 }] });
    let cases: Vec<(Value, Vec<Vec<u8>>)> = vec![
        (json!({ "pages": [] }), vec![]),
        (jpeg(0), vec![b"not a jpeg".to_vec()]),
        (jpeg(0), vec![bad_jpeg]),
        (jpeg(3), vec![]),
        (gray(10, 10, 300.0), vec![vec![0u8; 99]]),
        (gray(100_000, 100_000, 300.0), vec![vec![0u8; 16]]),
        (gray(10, 10, 0.5), vec![vec![0u8; 100]]),
    ];
    for (p, blobs) in cases {
        let e = call_static("ocr.createPdf", &p, blobs).unwrap_err();
        assert_eq!(e.code, "invalid_params", "{p}");
    }
}

#[test]
fn jpeg_header_parser_survives_truncation() {
    let j = tiny_jpeg();
    for n in 0..j.len() {
        let _ = warraq_core::ocr::jpeg_info(&j[..n]);
    }
    let info = warraq_core::ocr::jpeg_info(&j).unwrap();
    assert_eq!((info.width, info.height, info.components), (16, 8, 1));
}
