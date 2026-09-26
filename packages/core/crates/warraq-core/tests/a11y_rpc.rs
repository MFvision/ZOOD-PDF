//! a11y.* through the RPC: registration, incremental updates, failed calls leave the document
//! untouched, encrypted documents stay encrypted, permissions are enforced.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
use serde_json::{json, Value};
use warraq_core::{registry, Document};

fn file(rel: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../../../../tests/{rel}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn elements(doc: &mut Document) -> Vec<Value> {
    doc.call("a11y.structure", &json!({}), vec![]).unwrap().json["elements"]
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn all_a11y_methods_are_registered() {
    let names = registry().doc_names();
    for (m, _) in warraq_a11y::api::DOC_METHODS {
        assert!(names.contains(m), "{m}");
    }
}

#[test]
fn autotag_alt_text_and_check_through_the_rpc() {
    let original = file("fixtures/a11y-ar.pdf");
    let mut doc = Document::open(original.clone(), None).unwrap();
    let before = doc.call("a11y.check", &json!({}), vec![]).unwrap().json;
    assert_eq!(before["passed"], false);
    assert_eq!(before["certified"], false);
    let r = doc
        .call(
            "a11y.autotag",
            &json!({"title": "تقرير", "mode": "untagged"}),
            vec![],
        )
        .unwrap();
    assert!(r.blobs[0].starts_with(&original));
    assert_eq!(r.json["lang"], "ar");
    assert_eq!(r.json["revisions"], 2);
    let els = elements(&mut doc);
    let fig = els.iter().find(|e| e["role"] == "Figure").unwrap()["id"].clone();
    let r = doc
        .call(
            "a11y.setAlt",
            &json!({"id": fig, "alt": "صورة ملونة", "lang": "ar"}),
            vec![],
        )
        .unwrap();
    let saved = r.blobs[0].clone();
    let mut again = Document::open(saved, None).unwrap();
    let els = elements(&mut again);
    let f = els.iter().find(|e| e["id"] == fig).unwrap();
    assert_eq!(f["alt"], "صورة ملونة");
    let rep = again.call("a11y.check", &json!({}), vec![]).unwrap().json;
    assert_eq!(rep["passed"], true, "{rep}");

    // Failed calls change nothing.
    let len = doc.call("doc.info", &json!({}), vec![]).unwrap().json["byteLength"].clone();
    let e = doc
        .call("a11y.setType", &json!({"id": fig, "type": "Nope"}), vec![])
        .unwrap_err();
    assert_eq!(e.code, "invalid_params");
    let e = doc
        .call("a11y.move", &json!({"id": 999999, "index": 0}), vec![])
        .unwrap_err();
    assert_eq!(e.code, "not_found");
    let e = doc
        .call("a11y.autotag", &json!({"mode": "everything"}), vec![])
        .unwrap_err();
    assert_eq!(e.code, "invalid_params");
    let e = doc
        .call("a11y.structure", &json!({"x": 1}), vec![])
        .unwrap_err();
    assert_eq!(e.code, "invalid_params");
    assert_eq!(
        doc.call("doc.info", &json!({}), vec![]).unwrap().json["byteLength"],
        len
    );

    // Fix with a rule list; unknown rules are refused.
    let e = doc
        .call("a11y.fix", &json!({"rules": ["nope"]}), vec![])
        .unwrap_err();
    assert_eq!(e.code, "invalid_params");
}

#[test]
fn encrypted_documents_stay_encrypted_and_permissions_hold() {
    let original = file("corpus/pdf/encrypted/synthetic-word-naskh-aes-256.pdf");
    let mut doc = Document::open(original.clone(), Some("zood-word-aes")).unwrap();
    let r = doc.call("a11y.autotag", &json!({}), vec![]).unwrap();
    let out = r.blobs[0].clone();
    assert!(out.starts_with(&original));
    assert_eq!(
        Document::open(out.clone(), None).unwrap_err().code,
        "password_required"
    );
    let mut again = Document::open(out, Some("zood-word-aes")).unwrap();
    let info = again.call("doc.info", &json!({}), vec![]).unwrap().json;
    assert_eq!(info["encryption"]["method"], "AES-256");
    assert!(!elements(&mut again).is_empty());

    // A document whose owner forbids changes refuses tagging.
    let mut d = Document::open(file("fixtures/a11y-ar.pdf"), None).unwrap();
    let r = d
        .call(
            "protect.set",
            &json!({"userPassword": "u", "ownerPassword": "o", "permissions": {"modify": false}}),
            vec![],
        )
        .unwrap();
    let mut locked = Document::open(r.blobs[0].clone(), Some("u")).unwrap();
    let e = locked.call("a11y.autotag", &json!({}), vec![]).unwrap_err();
    assert_eq!(e.code, "permission_denied");
    // Reading and checking still work.
    locked.call("a11y.check", &json!({}), vec![]).unwrap();
}
