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
