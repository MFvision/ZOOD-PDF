//! Write Arabic with the shaper + per-word /ActualText, read it back with the extractor, and
//! exercise the RPC surface on the result.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use lopdf::{dictionary, Document, Object, Stream};
use serde_json::json;
use warraq_text::shape::{actual_text_spans, content_stream, shape};
use warraq_text::{call, LopdfSource};

fn amiri() -> Vec<u8> {
    std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../tests/corpus/fonts/amiri/Amiri-Regular.ttf"
    ))
    .unwrap()
}

/// A one-page PDF drawing each line with an embedded Identity-H Amiri **without ToUnicode**:
/// only /ActualText can give the text back.
fn build_pdf(lines: &[&str]) -> Vec<u8> {
    let font = amiri();
    let mut content = Vec::new();
    let mut widths = Vec::new();
    for (k, line) in lines.iter().enumerate() {
        let run = shape(line, &font, 16.0).unwrap();
        for g in &run.glyphs {
            widths.push((g.glyph_id, g.x_advance / 16.0 * 1000.0));
        }
        let x = 540.0 - run.width; // right aligned
        content.extend(content_stream(&run, "F1", x, 740.0 - 30.0 * k as f64));
    }
    assert!(
        !String::from_utf8_lossy(&content).contains("R2L"),
        "never write /Direction R2L"
    );
    let mut doc = Document::with_version("1.7");
    let ff = doc.add_object(Stream::new(
        dictionary! {"Length1" => font.len() as i64},
        font,
    ));
    let fd = doc.add_object(dictionary! {
        "Type" => "FontDescriptor", "FontName" => "Amiri-Regular", "Flags" => 4,
        "FontBBox" => vec![(-500).into(), (-700).into(), 1500.into(), 1200.into()], "ItalicAngle" => 0,
        "Ascent" => 1100, "Descent" => -600, "CapHeight" => 700, "StemV" => 80, "FontFile2" => ff,
    });
    let w: Vec<Object> = widths
        .iter()
        .flat_map(|(g, w)| {
            [
                Object::Integer(i64::from(*g)),
                Object::Array(vec![Object::Real(*w as f32)]),
            ]
        })
        .collect();
    let cid = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => "Amiri-Regular",
        "CIDSystemInfo" => dictionary! {"Registry" => Object::string_literal("Adobe"), "Ordering" => Object::string_literal("Identity"), "Supplement" => 0},
        "FontDescriptor" => fd, "W" => w, "CIDToGIDMap" => "Identity",
    });
    let f1 = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "Amiri-Regular", "Encoding" => "Identity-H",
        "DescendantFonts" => vec![Object::Reference(cid)],
    });
    let contents = doc.add_object(Stream::new(dictionary! {}, content));
    let pages_id = doc.new_object_id();
    let page = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Resources" => dictionary! {"Font" => dictionary! {"F1" => f1}}, "Contents" => contents,
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(
            dictionary! {"Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1},
        ),
    );
    let catalog = doc.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    doc.trailer.set("Root", catalog);
    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

const LINES: &[&str] = &[
    "لا إله إلا العلم",
    "كَتَبَ الطَّالِبُ الدَّرْسَ",
    "في عام 2024 بنسبة 35% و ١٢٣",
];

#[test]
fn shaped_text_reads_back_in_logical_order() {
    let pdf = build_pdf(LINES);
    let src = LopdfSource::open(&pdf, None).unwrap();
    let reply = call(&src, "text.extract", &json!({})).unwrap().unwrap();
    let mut lines = Vec::new();
    for block in reply["pages"][0]["blocks"].as_array().unwrap() {
        for para in block["paragraphs"].as_array().unwrap() {
            for line in para["lines"].as_array().unwrap() {
                lines.push(line["text"].as_str().unwrap().to_string());
            }
        }
    }
    assert_eq!(lines, LINES);
    let plain = call(&src, "text.plain", &json!({})).unwrap().unwrap();
    assert_eq!(
        plain["text"]
            .as_str()
            .unwrap()
            .split_whitespace()
            .collect::<Vec<_>>(),
        LINES.join(" ").split_whitespace().collect::<Vec<_>>()
    );
}

#[test]
fn per_word_spans_cover_every_glyph_once() {
    let font = amiri();
    for line in LINES {
        let run = shape(line, &font, 12.0).unwrap();
        let spans = actual_text_spans(&run);
        let covered: usize = spans.iter().map(|s| s.glyphs.len()).sum();
        assert_eq!(covered, run.glyphs.len());
        let mut words: Vec<&str> = spans
            .iter()
            .map(|s| s.text.as_str())
            .filter(|t| !t.trim().is_empty())
            .collect();
        words.sort_unstable();
        let mut expected: Vec<&str> = line.split(' ').collect();
        expected.sort_unstable();
        assert_eq!(words, expected);
    }
}

#[test]
fn rpc_extract_and_search() {
    let pdf = build_pdf(LINES);
    let src = LopdfSource::open(&pdf, None).unwrap();
    let ex = call(&src, "text.extract", &json!({"pages": [0], "glyphs": true}))
        .unwrap()
        .unwrap();
    let page = &ex["pages"][0];
    assert_eq!(page["page"], 0);
    let first_line = &page["blocks"][0]["paragraphs"][0]["lines"][0];
    assert_eq!(first_line["dir"], "rtl");
    assert_eq!(first_line["words"][0]["text"], "لا");
    // RTL: the first logical word is the rightmost.
    let w0 = first_line["words"][0]["bbox"]["x0"].as_f64().unwrap();
    let w1 = first_line["words"][1]["bbox"]["x0"].as_f64().unwrap();
    assert!(w0 > w1);

    // Search ignores tashkeel and unifies alef forms and digits.
    let hits = call(&src, "text.search", &json!({"query": "الطالب"}))
        .unwrap()
        .unwrap();
    assert_eq!(hits["hits"].as_array().unwrap().len(), 1);
    assert_eq!(hits["hits"][0]["text"], "الطَّالِبُ");
    assert_eq!(hits["hits"][0]["rects"].as_array().unwrap().len(), 1);
    let hits = call(&src, "text.search", &json!({"query": "اله"}))
        .unwrap()
        .unwrap();
    assert_eq!(hits["hits"].as_array().unwrap().len(), 1, "إله matches اله");
    let hits = call(&src, "text.search", &json!({"query": "123"}))
        .unwrap()
        .unwrap();
    assert_eq!(hits["hits"][0]["text"], "١٢٣");

    // Errors are values.
    let err = call(&src, "text.extract", &json!({"pages": [5]}))
        .unwrap()
        .unwrap_err();
    assert_eq!(err.code(), "page_out_of_range");
    let err = call(&src, "text.search", &json!({})).unwrap().unwrap_err();
    assert_eq!(err.code(), "invalid_params");
    assert!(call(&src, "doc.info", &json!({})).is_none());
}
