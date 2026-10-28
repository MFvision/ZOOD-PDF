//! `redact.apply`, attacked: after the marks are applied, what was under
//! them must be gone for every way of reading the file — the core's own
//! reader (logical order, ActualText, the Arabic-aware search), the bytes
//! of the file as written, and every stream in it inflated, in each of the
//! encodings a PDF can hold text in — while the words beside them read back
//! exactly as before, from exactly where they were drawn.
use crate::{call_static, Document};

fn fixture(path: &str) -> Vec<u8> {
    std::fs::read(format!("{}/../../../{path}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn json(reply: &crate::tools::Reply) -> serde_json::Value {
    serde_json::from_str(&reply.json).unwrap()
}

fn find(bytes: &[u8], args: serde_json::Value) -> Vec<serde_json::Value> {
    let mut doc = Document::open(bytes.to_vec(), None).unwrap();
    let reply = doc.call("redact.find", &args.to_string(), vec![]).unwrap();
    json(&reply)["matches"].as_array().unwrap().clone()
}

/// The matches as `redact.apply` takes them.
fn marks_of(found: &[serde_json::Value]) -> serde_json::Value {
    serde_json::Value::Array(
        found
            .iter()
            .map(|m| serde_json::json!({ "page": m["page"], "rects": m["rects"] }))
            .collect(),
    )
}

fn apply(bytes: &[u8], marks: serde_json::Value) -> (serde_json::Value, Vec<u8>) {
    let reply = call_static(
        "redact.apply",
        &serde_json::json!({ "marks": marks }).to_string(),
        vec![bytes.to_vec()],
    )
    .unwrap();
    (json(&reply), reply.blobs[0].clone())
}

/// Every way the file's bytes can be read without a PDF reader: as they
/// are, and every stream inflated (lopdf decodes the filters).
fn readable(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut out = vec![bytes.to_vec()];
    let doc = lopdf::Document::load_mem(bytes).unwrap();
    for object in doc.objects.values() {
        if let Ok(stream) = object.as_stream() {
            if let Ok(plain) = stream.decompressed_content() {
                out.push(plain);
            }
        }
    }
    out
}

/// `word` in each encoding a PDF writes text in: UTF-8 (and PDFDocEncoding
/// for ASCII), UTF-16BE as bytes, UTF-16BE in hex either case (a hex
/// string, an ActualText the core writes, a ToUnicode entry), UTF-16LE.
fn encodings(word: &str) -> Vec<(&'static str, Vec<u8>)> {
    let be: Vec<u8> = word.encode_utf16().flat_map(u16::to_be_bytes).collect();
    let le: Vec<u8> = word.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let hex: String = be.iter().map(|b| format!("{b:02x}")).collect();
    vec![
        ("UTF-8", word.as_bytes().to_vec()),
        ("UTF-16BE", be),
        ("UTF-16LE", le),
        ("UTF-16BE hex", hex.clone().into_bytes()),
        ("UTF-16BE HEX", hex.to_uppercase().into_bytes()),
    ]
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

/// `word` is nowhere in the file in any encoding, no page reads it, and
/// the Arabic-aware search finds it nowhere.
fn gone(bytes: &[u8], word: &str) {
    for part in readable(bytes) {
        for (name, needle) in encodings(word) {
            assert!(
                !contains(&part, &needle),
                "{word} is still in the file, {name}"
            );
        }
    }
    let doc = Document::open(bytes.to_vec(), None).unwrap();
    for page in 0..doc.page_count() {
        let text = doc.extract_text(page).unwrap();
        assert!(
            !text.contains(word),
            "page {page} still reads {word}: {text}"
        );
    }
    assert!(
        find(bytes, serde_json::json!({ "query": word })).is_empty(),
        "the search still finds {word}"
    );
}

/// `word` is in the file as text the reader reads: so its absence after is
/// the redaction's doing.
fn there(bytes: &[u8], word: &str) {
    assert!(
        !find(bytes, serde_json::json!({ "query": word })).is_empty(),
        "{word} is not there to begin with"
    );
}

struct Line {
    text: String,
    spans: Vec<(f32, f32)>,
}

/// Each line of a page as the reader reads it, with where each char was
/// drawn, keyed by how far down the page it is.
fn lines(bytes: &[u8], page: usize) -> Vec<(f32, Line)> {
    let doc = Document::open(bytes.to_vec(), None).unwrap();
    doc.text_lines(page)
        .unwrap()
        .into_iter()
        .map(|l| {
            (
                l.y,
                Line {
                    text: l.text,
                    spans: l.spans,
                },
            )
        })
        .collect()
}

fn line_at(bytes: &[u8], page: usize, y: f32) -> Line {
    lines(bytes, page)
        .into_iter()
        .find(|(at, _)| (at - y).abs() < 0.5)
        .unwrap_or_else(|| panic!("no line at {y} on page {page}"))
        .1
}

/// The chars of `kept` (a run of the line after) were drawn exactly where
/// the same chars of the line before were.
fn in_place(before: &Line, after: &Line, kept: &str) {
    let at = |line: &Line| -> Vec<(f32, f32)> {
        let start = line
            .text
            .find(kept)
            .unwrap_or_else(|| panic!("{kept:?} not in {:?}", line.text));
        let first = line.text[..start].chars().count();
        line.spans[first..first + kept.chars().count()].to_vec()
    };
    for ((a0, a1), (b0, b1)) in at(before).iter().zip(at(after)) {
        assert!(
            (a0 - b0).abs() < 0.01 && (a1 - b1).abs() < 0.01,
            "{kept:?} moved: {a0}..{a1} to {b0}..{b1}"
        );
    }
}

#[test]
fn english_words_and_emails_are_gone_and_the_rest_reads_and_sits_as_before() {
    let before = fixture("tests/fixtures/redact/contract.pdf");
    for word in ["Haddad", "nadia.haddad@example.com", "nadia@example.sa"] {
        there(&before, word);
    }
    let found = [
        find(&before, serde_json::json!({ "query": "Haddad" })),
        find(&before, serde_json::json!({ "patterns": ["email"] })),
    ]
    .concat();
    assert_eq!(found.len(), 4);
    let (report, after) = apply(&before, marks_of(&found));
    assert_eq!(report["pages"], 1);
    assert_eq!(report["runs"], 0, "every glyph was placed: {report}");
    for word in [
        "Haddad",
        "haddad",
        "nadia.haddad@example.com",
        "nadia@example.sa",
        "example.com",
        "example.sa",
    ] {
        gone(&after, word);
    }
    // Read back exactly, and drawn exactly where they were.
    let (b, a) = (line_at(&before, 0, 50.0), line_at(&after, 0, 50.0));
    assert_eq!(a.text, "Contract between Warraq Labs and Nadia");
    in_place(&b, &a, "Contract between Warraq Labs and Nadia");
    let (b, a) = (line_at(&before, 0, 72.0), line_at(&after, 0, 72.0));
    assert_eq!(a.text, "Contact: , phone +966 50 123 4567");
    in_place(&b, &a, ", phone +966 50 123 4567");
    for y in [94.0, 116.0, 138.0, 398.0, 432.0] {
        assert_eq!(line_at(&after, 0, y).text, line_at(&before, 0, y).text);
    }
    assert_eq!(
        line_at(&after, 0, 364.0).text,
        "البريد:  والجوال ٠٥٠١٢٣٤٥٦٧"
    );
}

#[test]
fn arabic_found_without_its_tashkeel_is_gone_and_its_neighbours_stay() {
    let before = fixture("tests/fixtures/redact/contract.pdf");
    there(&before, "ورّاق");
    there(&before, "نادية");
    // Searched for without the shadda, as a person types it.
    let found = [
        find(&before, serde_json::json!({ "query": "وراق" })),
        find(&before, serde_json::json!({ "query": "نادية" })),
    ]
    .concat();
    assert_eq!(found.len(), 2);
    assert_eq!(found[0]["text"], "ورّاق");
    let (_, after) = apply(&before, marks_of(&found));
    gone(&after, "ورّاق");
    gone(&after, "وراق");
    gone(&after, "نادية");
    let (b, a) = (line_at(&before, 0, 330.0), line_at(&after, 0, 330.0));
    assert_eq!(a.text, "العقد بين شركة  والسيدة");
    in_place(&b, &a, "العقد بين شركة");
    in_place(&b, &a, " والسيدة");
}

#[test]
fn arabic_the_core_wrote_loses_its_actual_text_and_the_rest_reads_back() {
    let amiri = fixture("tests/fonts/Amiri-Regular.ttf");
    let mut doc = Document::open(fixture("tests/fixtures/redact/contract.pdf"), None).unwrap();
    doc.add_text(0, 300.0, 600.0, 14.0, "اسم الموظف سلامة الحربي", &amiri)
        .unwrap();
    let before = doc.save().unwrap();
    there(&before, "الحربي");
    // The core writes the letters of a word whose glyphs would not read
    // back alone (this one: the font moves its letters) with an /ActualText
    // in UTF-16BE, letter by letter in a right-to-left word, so its letters
    // are in the bytes until it is redacted. Searched for with a dotless yaa.
    assert!(readable(&before).iter().any(|p| contains(p, b"ActualText")));
    let found = find(&before, serde_json::json!({ "query": "الحربى" }));
    assert_eq!(found.len(), 1);
    let (_, after) = apply(&before, marks_of(&found));
    gone(&after, "الحربي");
    let (b, a) = (line_at(&before, 0, 600.0), line_at(&after, 0, 600.0));
    assert_eq!(a.text, "اسم الموظف سلامة");
    in_place(&b, &a, "اسم الموظف سلامة");
}

#[test]
fn text_on_turned_and_slanting_pages_and_in_a_footer_is_cut_where_it_is_drawn() {
    let before = fixture("tests/fixtures/redact/turned.pdf");
    let found = find(&before, serde_json::json!({ "query": "Haddad" }));
    assert_eq!(found.len(), 7);
    let (report, after) = apply(&before, marks_of(&found));
    assert_eq!(report["glyphs"], 42, "six letters seven times: {report}");
    gone(&after, "Haddad");
    for page in 0..6 {
        let read: Vec<String> = lines(&after, page)
            .into_iter()
            .map(|(_, l)| l.text)
            .collect();
        assert!(
            read.contains(&"Nadia  keeps the rest".to_string()),
            "page {page}: {read:?}"
        );
        if page < 5 {
            assert!(
                read.contains(&"Line above stays".to_string()),
                "page {page}: {read:?}"
            );
            assert!(
                read.contains(&"Line below stays".to_string()),
                "page {page}: {read:?}"
            );
        }
    }
    let foot: Vec<String> = lines(&after, 5).into_iter().map(|(_, l)| l.text).collect();
    assert!(
        foot.contains(&"Prepared for Nadia , +966 50 123 4567".to_string()),
        "{foot:?}"
    );
}

/// A scan made into a page with a text layer: the word's invisible glyphs,
/// the pixels it was read from, and the copy of it the layer keeps in the
/// page's private data all go; the other word stays readable.
#[test]
fn a_scans_pixels_and_its_text_layer_go_under_a_mark() {
    let jpeg = fixture("tests/fixtures/scan/page-crooked.jpg");
    let made = call_static("create.images", r#"{"paper":"own"}"#, vec![jpeg]).unwrap();
    let pdf = made.blobs[0].clone();
    let doc = Document::open(pdf.clone(), None).unwrap();
    let (w, h) = doc.page_size(0).unwrap();
    let layer = serde_json::json!({ "pages": [{ "index": 0, "words": [
        { "text": "سرّي", "bbox": [w * 0.6, h * 0.1, w * 0.8, h * 0.15] },
        { "text": "عام", "bbox": [w * 0.2, h * 0.1, w * 0.4, h * 0.15] },
    ] }] });
    let amiri = fixture("tests/fonts/Amiri-Regular.ttf");
    let before = call_static("ocr.add_text_layer", &layer.to_string(), vec![pdf, amiri])
        .unwrap()
        .blobs[0]
        .clone();
    there(&before, "سري");
    let found = find(&before, serde_json::json!({ "query": "سري" }));
    assert_eq!(found.len(), 1);
    let (report, after) = apply(&before, marks_of(&found));
    assert_eq!(
        report["images"], 1,
        "the scan's pixels were blanked: {report}"
    );
    assert_eq!(report["imagesRemoved"], 0);
    gone(&after, "سرّي");
    gone(&after, "سري");
    there(&after, "عام");
    let words = call_static("ocr.layer_words", "{}", vec![after.clone()]).unwrap();
    assert!(!json(&words).to_string().contains("سر"), "{}", json(&words));
    // The scan as the page draws it now: black under the mark (the box over
    // it) and the scan's own pixels beside it — rendered, then read back.
    let mut doc = Document::open(after, None).unwrap();
    let page = doc.render_page(0, 0.5).unwrap();
    let r = &found[0]["rects"][0];
    let f = |k: &str| r[k].as_f64().unwrap() as f32 * 0.5;
    let (cx, cy) = (
        (f("x") + f("width") / 2.0) as usize,
        (f("y") + f("height") / 2.0) as usize,
    );
    let at = |x: usize, y: usize| page.rgba[(y * page.width as usize + x) * 4];
    assert_eq!(at(cx, cy), 0, "under the mark");
    let _ = doc
        .call("redact.find", r#"{"query":"عام"}"#, vec![])
        .unwrap();
}

/// A header محرر PDF drew keeps its words in the page's private data, to be
/// listed and taken off again: the redaction takes them from there too.
#[test]
fn a_page_mark_and_the_words_it_keeps_are_cut() {
    let amiri = fixture("tests/fonts/Amiri-Regular.ttf");
    let base = fixture("tests/fixtures/redact/contract.pdf");
    let mark = serde_json::json!({ "fontBlob": 1, "mark": { "kind": "header", "slots": ["", "سري: عبدالله الحربي", ""] } });
    let added = call_static("marks.add", &mark.to_string(), vec![base, amiri]).unwrap();
    let before = added.blobs[0].clone();
    let found = find(&before, serde_json::json!({ "query": "عبدالله" }));
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0]["pageMark"], true);
    let (_, after) = apply(&before, marks_of(&found));
    gone(&after, "عبدالله");
    let listed = call_static("marks.list", "{}", vec![after.clone()]).unwrap();
    assert!(
        !json(&listed).to_string().contains("عبدالله"),
        "{}",
        json(&listed)
    );
    there(&after, "الحربي");
}

/// A form field over a mark goes, and its value with it.
#[test]
fn a_form_field_under_a_mark_goes_with_its_value() {
    let before = fixture("tests/corpus/arabic/generated/acroform-pdflib-arabic-fields.pdf");
    let form = json(&call_static("forms.inspect", "{}", vec![before.clone()]).unwrap());
    let field = form["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["value"].as_str().is_some_and(|v| v.chars().count() > 3))
        .unwrap_or_else(|| panic!("no filled field: {form}"))
        .clone();
    let value = field["value"].as_str().unwrap().to_string();
    let widget = &field["widgets"][0];
    let r: Vec<f64> = widget["rect"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    let marks = serde_json::json!([{ "page": widget["page"], "rects": [{ "x": r[0], "y": r[1], "width": r[2] - r[0], "height": r[3] - r[1] }] }]);
    let (report, after) = apply(&before, marks);
    assert!(report["annotations"].as_u64().unwrap() >= 1, "{report}");
    let form = json(&call_static("forms.inspect", "{}", vec![after.clone()]).unwrap());
    assert!(!form.to_string().contains(&value), "{form}");
    for part in readable(&after) {
        for (name, needle) in encodings(&value) {
            assert!(
                !contains(&part, &needle),
                "{value} is still in the file, {name}"
            );
        }
    }
}

#[test]
fn the_file_is_written_whole_and_a_protected_one_is_refused() {
    let before = fixture("tests/fixtures/redact/contract.pdf");
    let found = find(&before, serde_json::json!({ "query": "Haddad" }));
    let (_, after) = apply(&before, marks_of(&found));
    assert!(!after.starts_with(&before[..before.len() / 2]));
    assert_eq!(warraq_pdf::hidden::earlier_revisions(&after), 0);
    let locked = fixture("tests/corpus/arabic/generated/variant-encrypted-aes256.pdf");
    let reply = call_static(
        "redact.apply",
        r#"{"password":"warraq","marks":[{"page":0,"rects":[{"x":10,"y":10,"width":50,"height":20}]}]}"#,
        vec![locked],
    )
    .unwrap();
    assert_eq!(json(&reply)["refused"], "protected");
    assert!(reply.blobs.is_empty());
    assert!(call_static("redact.apply", r#"{"marks":[]}"#, vec![before.clone()]).is_err());
    assert!(call_static(
        "redact.apply",
        r#"{"marks":[{"page":9,"rects":[{"x":10,"y":10,"width":50,"height":20}]}]}"#,
        vec![before]
    )
    .is_err());
}

/// The contract with bytes flipped all through it: every redaction either
/// answers or refuses, and none panics.
#[test]
fn damaged_files_are_refused_or_redacted_never_a_panic() {
    let before = fixture("tests/fixtures/redact/contract.pdf");
    let marks = r#"{"marks":[{"page":0,"rects":[{"x":0,"y":0,"width":600,"height":800}]}]}"#;
    let mut seed = 0x9e3779b9u32;
    for _ in 0..60 {
        let mut bytes = before.clone();
        for _ in 0..40 {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let at = seed as usize % bytes.len();
            bytes[at] = (seed >> 8) as u8;
        }
        let _ = call_static("redact.apply", marks, vec![bytes]);
    }
}
