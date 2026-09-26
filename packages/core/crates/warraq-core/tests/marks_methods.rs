//! marks.* through the RPC: incremental updates, listing, removal, failed calls leave the
//! document untouched, permissions are enforced, text.search / text.plain see the marks.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
use serde_json::json;
use warraq_core::{registry, Document};

fn corpus(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../../../../tests/corpus/pdf/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

#[test]
fn all_marks_methods_are_registered() {
    let names = registry().doc_names();
    for m in ["marks.list", "marks.add", "marks.update", "marks.remove"] {
        assert!(names.contains(&m), "{m}");
    }
}

#[test]
fn add_list_search_and_remove_through_the_rpc() {
    let original = corpus("chrome-news-amiri.pdf");
    let mut doc = Document::open(original.clone(), None).unwrap();
    let r = doc
        .call(
            "marks.add",
            &json!({ "mark": { "kind": "footer", "slots": { "center": "صفحة {page} من {pages}" }, "digits": "arabic", "lang": "ar", "rtl": true } }),
            vec![],
        )
        .unwrap();
    assert!(r.blobs[0].starts_with(&original));
    assert_eq!(r.json["revisions"], 2);
    let id = r.json["id"].as_str().unwrap().to_string();
    let hits = doc
        .call("text.search", &json!({ "query": "صفحة ١ من ١" }), vec![])
        .unwrap()
        .json["hits"]
        .clone();
    assert_eq!(hits.as_array().unwrap().len(), 1, "{hits}");
    let l = doc.call("marks.list", &json!({}), vec![]).unwrap().json;
    assert_eq!(l["marks"][0]["id"], id.as_str());
    assert_eq!(l["marks"][0]["spec"]["kind"], "footer");
    // A failing call changes nothing.
    let len = doc.call("doc.info", &json!({}), vec![]).unwrap().json["byteLength"].clone();
    let e = doc
        .call(
            "marks.add",
            &json!({ "mark": { "kind": "watermark", "picture": true } }),
            vec![b"junk".to_vec()],
        )
        .unwrap_err();
    assert_eq!(e.code, "image_error");
    let info = doc.call("doc.info", &json!({}), vec![]).unwrap().json;
    assert_eq!(info["byteLength"], len);
    assert_eq!(info["unsavedChanges"], false);
    let r = doc
        .call("marks.remove", &json!({ "id": id }), vec![])
        .unwrap();
    assert_eq!(r.json["revisions"], 3);
    let plain = doc.call("text.plain", &json!({}), vec![]).unwrap().json["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(!plain.contains("صفحة ١ من ١"), "{plain}");
}

#[test]
fn restricted_documents_refuse_marks() {
    let mut d = Document::open(corpus("chrome-english-inter.pdf"), None).unwrap();
    let enc = d
        .call(
            "protect.set",
            &json!({"userPassword": "افتح", "ownerPassword": "مالك", "permissions": {"modify": false}}),
            vec![],
        )
        .unwrap()
        .blobs[0]
        .clone();
    let mut u = Document::open(enc.clone(), Some("افتح")).unwrap();
    let e = u
        .call(
            "marks.add",
            &json!({ "mark": { "kind": "pageNumber" } }),
            vec![],
        )
        .unwrap_err();
    assert_eq!(e.code, "permission_denied");
    assert!(u.call("marks.list", &json!({}), vec![]).is_ok());
    // The owner can, and the file stays protected.
    let mut o = Document::open(enc.clone(), Some("مالك")).unwrap();
    let r = o
        .call(
            "marks.add",
            &json!({ "mark": { "kind": "pageNumber" } }),
            vec![],
        )
        .unwrap();
    assert!(r.blobs[0].starts_with(&enc));
    assert!(Document::open(r.blobs[0].clone(), None).is_err());
}
