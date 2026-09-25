//! text.* methods are reachable through the RPC and read Arabic in logical order.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
use serde_json::json;
use warraq_core::Document;

#[test]
fn text_plain_reads_arabic_corpus_file() {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../tests/corpus");
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(format!("{root}/manifest.json")).unwrap()).unwrap();
    let entry = manifest["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["password"].is_null() && !f["flags"]["scanned"].as_bool().unwrap_or(false))
        .expect("an unencrypted, non-scanned corpus file");
    let bytes = std::fs::read(format!("{root}/{}", entry["path"].as_str().unwrap())).unwrap();
    let mut doc = Document::open(bytes, None).unwrap();
    let r = doc.call("text.plain", &json!({}), vec![]).unwrap();
    let text = r.json["text"].as_str().unwrap();
    assert!(
        text.chars().any(|c| ('\u{0600}'..='\u{06FF}').contains(&c)),
        "{text}"
    );
    let r = doc
        .call("text.search", &json!({"query": "zzzz-not-there"}), vec![])
        .unwrap();
    assert_eq!(r.json["hits"].as_array().unwrap().len(), 0);
}
