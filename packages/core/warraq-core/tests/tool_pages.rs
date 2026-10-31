//! The pages tool through `Document::call` and `call_static`, the way every
//! host reaches it: the text moves with its page, and every change survives a
//! save and a reopen.
use serde_json::Value;
use warraq_core::{call_static, Document};

fn corpus(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../../../tests/corpus/arabic/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

const THREE: &str = "generated/chrome-notonaskh-justified-3pages.pdf";

fn texts(doc: &Document) -> Vec<String> {
    (0..doc.page_count())
        .map(|i| doc.extract_text(i).unwrap())
        .collect()
}

fn json(reply: &warraq_core::Reply) -> Value {
    serde_json::from_str(&reply.json).unwrap()
}

fn reopen(doc: &mut Document) -> Document {
    Document::open(doc.save().unwrap(), None).unwrap()
}

#[test]
fn the_three_pages_read_differently() {
    let doc = Document::open(corpus(THREE), None).unwrap();
    let t = texts(&doc);
    assert!(
        t.iter().all(|t| t.chars().count() > 50),
        "every page has text"
    );
    assert!(t[0] != t[1] && t[1] != t[2] && t[0] != t[2]);
}

#[test]
fn reorder_moves_each_page_with_its_text() {
    let mut doc = Document::open(corpus(THREE), None).unwrap();
    let before = texts(&doc);
    let reply = doc
        .call("pages.reorder", r#"{"order":[2,0,1]}"#, vec![])
        .unwrap();
    assert_eq!(json(&reply)["pageCount"], 3);
    let expected = vec![before[2].clone(), before[0].clone(), before[1].clone()];
    assert_eq!(texts(&doc), expected);
    assert_eq!(texts(&reopen(&mut doc)), expected);
}

#[test]
fn rotate_reports_the_turned_page_size() {
    let mut doc = Document::open(corpus(THREE), None).unwrap();
    let (w, h) = doc.page_size(0).unwrap();
    let reply = doc
        .call("pages.rotate", r#"{"pages":[0],"quarterTurns":1}"#, vec![])
        .unwrap();
    let size = &json(&reply)["pageSizes"][0];
    assert_eq!(
        (
            size[0].as_f64().unwrap() as f32,
            size[1].as_f64().unwrap() as f32
        ),
        (h, w)
    );
    assert_eq!(reopen(&mut doc).page_size(0).unwrap(), (h, w));
}

#[test]
fn delete_and_insert_blank_change_the_page_count() {
    let mut doc = Document::open(corpus(THREE), None).unwrap();
    let before = texts(&doc);
    doc.call("pages.delete", r#"{"pages":[1]}"#, vec![])
        .unwrap();
    assert_eq!(texts(&doc), vec![before[0].clone(), before[2].clone()]);
    let reply = doc
        .call("pages.insert_blank", r#"{"at":1,"like":0}"#, vec![])
        .unwrap();
    assert_eq!(json(&reply)["pageCount"], 3);
    let back = reopen(&mut doc);
    assert_eq!(back.page_count(), 3);
    assert_eq!(back.extract_text(1).unwrap().trim(), "");
    assert_eq!(back.extract_text(2).unwrap(), before[2]);
}

#[test]
fn extract_returns_a_new_file_and_leaves_the_open_one_alone() {
    let mut doc = Document::open(corpus(THREE), None).unwrap();
    let before = texts(&doc);
    let reply = doc
        .call("pages.extract", r#"{"pages":[2,0]}"#, vec![])
        .unwrap();
    assert_eq!(reply.blobs.len(), 1);
    let out = Document::open(reply.blobs[0].clone(), None).unwrap();
    assert_eq!(texts(&out), vec![before[2].clone(), before[0].clone()]);
    assert_eq!(texts(&doc), before);
}

#[test]
fn insert_file_puts_another_file_s_pages_at_the_position_with_their_text() {
    let mut doc = Document::open(corpus(THREE), None).unwrap();
    let before = texts(&doc);
    let other_bytes = corpus("realworld/A_worldbank_malpass_g7_briefing_AR_word2016_pdftools.pdf");
    let other = texts(&Document::open(other_bytes.clone(), None).unwrap());
    let reply = doc
        .call("pages.insert_file", r#"{"at":1}"#, vec![other_bytes])
        .unwrap();
    assert_eq!(json(&reply)["pageCount"], 3 + other.len());
    let expected: Vec<String> = [&before[..1], &other[..], &before[1..]].concat();
    assert_eq!(texts(&doc), expected);
    assert_eq!(texts(&reopen(&mut doc)), expected);
}

#[test]
fn insert_file_opens_a_protected_file_with_its_password_and_keeps_the_open_one_protected() {
    let locked = corpus("generated/variant-encrypted-aes256.pdf");
    let mut plain = Document::open(corpus(THREE), None).unwrap();
    assert!(plain
        .call("pages.insert_file", r#"{"at":0}"#, vec![locked.clone()])
        .is_err());
    assert_eq!(
        plain.page_count(),
        3,
        "a file that did not open changes nothing"
    );
    plain
        .call(
            "pages.insert_file",
            r#"{"at":0,"password":"warraq"}"#,
            vec![locked.clone()],
        )
        .unwrap();
    assert_eq!(plain.page_count(), 6);

    // Into a protected file: the new pages are encrypted with the rest.
    let mut doc = Document::open(locked, Some("warraq")).unwrap();
    let n = doc.page_count();
    let three = corpus(THREE);
    doc.call(
        "pages.insert_file",
        &format!(r#"{{"at":{n}}}"#),
        vec![three.clone()],
    )
    .unwrap();
    let saved = doc.save().unwrap();
    assert!(
        Document::open(saved.clone(), None).is_err(),
        "still protected"
    );
    let back = Document::open(saved, Some("warraq")).unwrap();
    assert_eq!(
        texts(&back)[n..],
        texts(&Document::open(three, None).unwrap())[..]
    );
}

#[test]
fn crop_cuts_margins_as_shown_and_keeps_the_text() {
    let mut doc = Document::open(corpus(THREE), None).unwrap();
    let text = texts(&doc);
    let (w, h) = doc.page_size(0).unwrap();
    let reply = doc
        .call(
            "pages.crop",
            r#"{"pages":[0],"margins":{"top":10,"right":20,"bottom":30,"left":40}}"#,
            vec![],
        )
        .unwrap();
    let size = &json(&reply)["pageSizes"][0];
    assert_eq!(
        (
            size[0].as_f64().unwrap() as f32,
            size[1].as_f64().unwrap() as f32
        ),
        (w - 60.0, h - 40.0)
    );
    let mut back = reopen(&mut doc);
    assert_eq!(back.page_size(0).unwrap(), (w - 60.0, h - 40.0));
    assert_eq!(
        texts(&back)[1..],
        text[1..],
        "the other pages are as they were"
    );
    assert!(back
        .call(
            "pages.crop",
            r#"{"pages":[0],"margins":{"top":900,"right":0,"bottom":0,"left":0}}"#,
            vec![]
        )
        .is_err());
}

#[test]
fn trim_margins_cuts_to_what_is_printed_and_leaves_a_blank_page_alone() {
    let mut doc = Document::open(corpus(THREE), None).unwrap();
    let (w, h) = doc.page_size(0).unwrap();
    doc.call("pages.insert_blank", r#"{"at":3,"like":0}"#, vec![])
        .unwrap();
    let reply = doc
        .call(
            "pages.trim_margins",
            r#"{"pages":[0,3],"padding":6}"#,
            vec![],
        )
        .unwrap();
    let sizes = &json(&reply)["pageSizes"];
    let (tw, th) = (
        sizes[0][0].as_f64().unwrap() as f32,
        sizes[0][1].as_f64().unwrap() as f32,
    );
    assert!(
        tw < w - 40.0 && th < h - 40.0,
        "{w}x{h} trimmed to {tw}x{th}"
    );
    assert_eq!(
        (
            sizes[3][0].as_f64().unwrap() as f32,
            sizes[3][1].as_f64().unwrap() as f32
        ),
        (w, h),
        "nothing printed: nothing to trim to"
    );
    let before = texts(&Document::open(corpus(THREE), None).unwrap());
    assert_eq!(
        texts(&reopen(&mut doc))[0],
        before[0],
        "the text is all still there"
    );
}

#[test]
fn file_rebase_keeps_the_file_s_own_bytes_under_another_engine_s_changes() {
    let fixture = |name: &str| {
        std::fs::read(format!(
            "{}/../../../tests/fixtures/rewrites/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    };
    let original = corpus(THREE);
    let reply = call_static(
        "file.rebase",
        "{}",
        vec![original.clone(), fixture("three-square.pdf")],
    )
    .unwrap();
    assert_eq!(json(&reply)["rebased"], true);
    assert!(reply.blobs[0].starts_with(&original));
    assert_eq!(
        texts(&Document::open(reply.blobs[0].clone(), None).unwrap()),
        texts(&Document::open(original, None).unwrap())
    );

    // A password taken off cannot be an update: the rewrite is the file.
    let locked = corpus("generated/variant-encrypted-aes256.pdf");
    let reply = call_static(
        "file.rebase",
        r#"{"password":"warraq"}"#,
        vec![locked, fixture("aes256-unprotected.pdf")],
    )
    .unwrap();
    assert_eq!(json(&reply)["rebased"], false);
    assert!(reply.blobs.is_empty());
}

#[test]
fn combine_needs_no_open_document() {
    let three = corpus(THREE);
    let word = corpus("realworld/A_worldbank_malpass_g7_briefing_AR_word2016_pdftools.pdf");
    let reply = call_static("pages.combine", "{}", vec![three.clone(), word.clone()]).unwrap();
    assert_eq!(json(&reply)["pageCount"], 5);
    let out = Document::open(reply.blobs[0].clone(), None).unwrap();
    let a = texts(&Document::open(three, None).unwrap());
    let b = texts(&Document::open(word, None).unwrap());
    assert_eq!(texts(&out), [a, b].concat());
}

#[test]
fn combine_opens_a_protected_file_with_its_password() {
    let reply = call_static(
        "pages.combine",
        r#"{"passwords":[null,"warraq"]}"#,
        vec![
            corpus(THREE),
            corpus("generated/variant-encrypted-aes256.pdf"),
        ],
    )
    .unwrap();
    assert_eq!(json(&reply)["pageCount"], 6);
    let err = call_static(
        "pages.combine",
        "{}",
        vec![
            corpus(THREE),
            corpus("generated/variant-encrypted-aes256.pdf"),
        ],
    )
    .unwrap_err();
    assert!(err.to_string().starts_with("E_PASSWORD"), "{err}");
}

#[test]
fn unknown_operations_and_bad_arguments_say_so() {
    let mut doc = Document::open(corpus(THREE), None).unwrap();
    let unknown = doc.call("pages.shuffle", "{}", vec![]).unwrap_err();
    assert!(unknown.to_string().starts_with("E_UNKNOWN_OP"), "{unknown}");
    let bad = doc
        .call("pages.rotate", r#"{"pages":"all"}"#, vec![])
        .unwrap_err();
    assert!(bad.to_string().starts_with("E_ARGS"), "{bad}");
    let range = doc
        .call("pages.delete", r#"{"pages":[9]}"#, vec![])
        .unwrap_err();
    assert!(range.to_string().starts_with("E_PAGE"), "{range}");
}

/// A file whose page tree holds no page this engine can read — what a
/// cut-off download often is — was inserted or combined as nothing, with a
/// reply that it worked.
fn file_with_no_pages() -> Vec<u8> {
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [] /Count 0 >>",
    ];
    let mut out = b"%PDF-1.7\n".to_vec();
    let mut offsets = vec![];
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", i + 1).as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(b"xref\n0 3\n0000000000 65535 f \n");
    for offset in offsets {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!("trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
    );
    out
}

#[test]
fn a_file_with_no_readable_page_is_refused_by_insert_and_combine() {
    let mut doc = Document::open(corpus(THREE), None).unwrap();
    let inserted = doc.call(
        "pages.insert_file",
        r#"{"at":1}"#,
        vec![file_with_no_pages()],
    );
    assert!(inserted.is_err(), "inserting nothing must not succeed");
    assert_eq!(doc.page_count(), 3);
    let combined = call_static(
        "pages.combine",
        "{}",
        vec![corpus(THREE), file_with_no_pages()],
    );
    let error = combined.err().map(|e| e.to_string()).unwrap_or_default();
    assert!(error.contains("file 2"), "{error}");
}

#[test]
fn forms_fix_appearances_draws_arabic_values_and_keeps_protection() {
    let font = std::fs::read(format!(
        "{}/../../../tests/fonts/Amiri-Regular.ttf",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    // pdf-lib's Arabic form: one field holds Arabic.
    let form = corpus("generated/acroform-pdflib-arabic-fields.pdf");
    let reply = call_static(
        "forms.fix_appearances",
        "{}",
        vec![form.clone(), font.clone()],
    )
    .unwrap();
    assert_eq!(json(&reply)["fields"], 1);
    assert!(reply.blobs[0].starts_with(&form), "an incremental update");
    // Nothing to fix: the file comes back as it was.
    let plain = corpus(THREE);
    let reply = call_static(
        "forms.fix_appearances",
        "{}",
        vec![plain.clone(), font.clone()],
    )
    .unwrap();
    assert_eq!(json(&reply)["fields"], 0);
    assert_eq!(reply.blobs[0], plain);
    // A protected file needs its password, and stays protected.
    let locked = corpus("generated/variant-encrypted-aes256.pdf");
    assert!(call_static(
        "forms.fix_appearances",
        "{}",
        vec![locked.clone(), font.clone()]
    )
    .unwrap_err()
    .to_string()
    .starts_with("E_PASSWORD"));
    let reply = call_static(
        "forms.fix_appearances",
        r#"{"password":"warraq"}"#,
        vec![locked, font],
    )
    .unwrap();
    assert!(Document::open(reply.blobs[0].clone(), None).is_err());
}

#[test]
fn compress_keeps_every_page_s_text_and_shrinks_a_scan() {
    let word = corpus("realworld/A_un_rome_statute_A-CONF.183-9-AR_word_pdfmaker6.pdf");
    let reply = call_static("compress.file", "{}", vec![word.clone()]).unwrap();
    let answer = json(&reply);
    assert_eq!(answer["before"], word.len());
    let out = Document::open(reply.blobs[0].clone(), None).unwrap();
    let original = Document::open(word, None).unwrap();
    assert_eq!(
        texts(&out),
        texts(&original),
        "not one character of text lost"
    );

    let scan = corpus("generated/scan-notonaskh-300dpi-skewed-jpeg.pdf");
    let reply = call_static(
        "compress.file",
        r#"{"imageDpi":150,"jpegQuality":75}"#,
        vec![scan.clone()],
    )
    .unwrap();
    let answer = json(&reply);
    assert_eq!(answer["images"], 2);
    assert!(
        answer["after"].as_u64().unwrap() * 2 < scan.len() as u64,
        "{answer}"
    );

    let locked = corpus("generated/variant-encrypted-aes256.pdf");
    let reply = call_static("compress.file", r#"{"password":"warraq"}"#, vec![locked]).unwrap();
    assert_eq!(json(&reply)["refused"], "protected");
    assert!(reply.blobs.is_empty());
}

#[test]
fn a_text_layer_turned_with_a_crooked_scan_reads_line_by_line() {
    // Words read off a scan straightened by 8°: two lines across the page,
    // in the straightened page's frame. Turned back over the crooked page,
    // each line drifts several lines' height from end to end.
    let font = std::fs::read(format!(
        "{}/../../../tests/fonts/Amiri-Regular.ttf",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let scan = corpus("generated/scan-arial-200dpi-bilevel.pdf");
    let (w, _) = Document::open(scan.clone(), None)
        .unwrap()
        .page_size(0)
        .unwrap();
    let line = |top: f32, words: &[&str]| -> Vec<Value> {
        let step = (w - 144.0) / words.len() as f32;
        words
            .iter()
            .enumerate()
            .map(|(k, word)| {
                let x0 = 72.0 + k as f32 * step;
                serde_json::json!({ "text": format!("{word} "), "bbox": [x0, top, x0 + step * 0.8, top + 14.0] })
            })
            .collect()
    };
    let words: Vec<Value> = line(100.0, &["one", "two", "three", "four", "five", "six"])
        .into_iter()
        .chain(line(
            124.0,
            &["alpha", "beta", "gamma", "delta", "epsilon", "zeta"],
        ))
        .collect();
    let args = serde_json::json!({ "pages": [{ "index": 0, "angle": 8.0, "words": words }] });
    let reply = call_static("ocr.add_text_layer", &args.to_string(), vec![scan, font]).unwrap();
    let doc = Document::open(reply.blobs[0].clone(), None).unwrap();
    let text = doc.extract_text(0).unwrap();
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    assert_eq!(
        lines,
        [
            "one two three four five six",
            "alpha beta gamma delta epsilon zeta"
        ]
    );
    // Turned, and the right way: counter-clockwise about the page's centre,
    // as the scan is, which takes a line above the centre to the left — by
    // its distance from the centre times sin 8°, some 40 points here.
    let first = &doc.text_lines(0).unwrap()[0];
    assert!(
        first.x + first.width / 2.0 < w / 2.0 - 20.0,
        "moved left about the centre: {first:?}"
    );
}

#[test]
fn ocr_text_layer_is_read_back_by_warraq_s_own_reader() {
    let font = std::fs::read(format!(
        "{}/../../../tests/fonts/Amiri-Regular.ttf",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let scan = corpus("generated/scan-arial-200dpi-bilevel.pdf");
    assert_eq!(
        Document::open(scan.clone(), None)
            .unwrap()
            .extract_text(0)
            .unwrap()
            .trim(),
        ""
    );
    let args = r#"{"pages":[{"index":0,"words":[
        {"text":"مرحبا","bbox":[300,100,380,120]},
        {"text":"بالعالم","bbox":[210,100,290,120]},
        {"text":"Warraq","bbox":[72,140,150,156]}]}]}"#;
    let reply = call_static("ocr.add_text_layer", args, vec![scan.clone(), font]).unwrap();
    assert_eq!(json(&reply)["words"], 3);
    assert!(reply.blobs[0].starts_with(&scan));
    let text = Document::open(reply.blobs[0].clone(), None)
        .unwrap()
        .extract_text(0)
        .unwrap();
    for word in ["مرحبا", "بالعالم", "Warraq"] {
        assert!(text.contains(word), "{word} in {text:?}");
    }
}

#[test]
fn a_corrected_ocr_layer_takes_the_place_of_the_first_and_its_words_come_back() {
    let font = std::fs::read(format!(
        "{}/../../../tests/fonts/Amiri-Regular.ttf",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let scan = corpus("generated/scan-arial-200dpi-bilevel.pdf");
    let first = r#"{"pages":[{"index":0,"words":[
        {"text":"مرحيا","bbox":[300,100,380,120]},
        {"text":"Warraq","bbox":[72,140,150,156]}]}],"modified":"D:20260919120000Z"}"#;
    let reply = call_static(
        "ocr.add_text_layer",
        first,
        vec![scan.clone(), font.clone()],
    )
    .unwrap();
    let read = reply.blobs[0].clone();

    // The words kept with the page: what a correction starts from.
    let kept = call_static("ocr.layer_words", "{}", vec![read.clone()]).unwrap();
    let kept = json(&kept);
    assert_eq!(kept["pages"][0]["index"], 0);
    assert_eq!(kept["pages"][0]["words"][0]["text"], "مرحيا");
    assert_eq!(kept["pages"][0]["words"][1]["bbox"][0], 72.0);

    // The correction replaces the layer: the new word is read, the old one gone.
    let fixed = r#"{"pages":[{"index":0,"replace":true,"words":[
        {"text":"مرحبا","bbox":[300,100,380,120]},
        {"text":"Warraq","bbox":[72,140,150,156]}]}]}"#;
    let reply = call_static("ocr.add_text_layer", fixed, vec![read.clone(), font]).unwrap();
    assert_eq!(json(&reply)["pages"], 1);
    assert!(reply.blobs[0].starts_with(&read), "an update of the file");
    let text = Document::open(reply.blobs[0].clone(), None)
        .unwrap()
        .extract_text(0)
        .unwrap();
    assert!(
        text.contains("مرحبا") && !text.contains("مرحيا"),
        "{text:?}"
    );
    let kept = call_static(
        "ocr.layer_words",
        r#"{"pages":[0,7]}"#,
        vec![reply.blobs[0].clone()],
    )
    .unwrap();
    assert_eq!(json(&kept)["pages"][0]["words"][0]["text"], "مرحبا");
    // A page with no layer has nothing to give back.
    let none = call_static("ocr.layer_words", "{}", vec![scan]).unwrap();
    assert_eq!(json(&none)["pages"], serde_json::json!([]));
}
