//! edit.* through the RPC: incremental updates, failed edits leave the document untouched,
//! encrypted documents stay encrypted, permissions are enforced.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
use serde_json::json;
use warraq_core::{call_static, registry, Document};

fn corpus(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../../../../tests/corpus/pdf/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

#[test]
fn all_edit_methods_are_registered() {
    let names = registry().doc_names();
    for m in [
        "edit.textBlocks",
        "edit.replaceText",
        "edit.addText",
        "edit.images",
        "edit.imageTransform",
        "edit.imageCrop",
        "edit.imageReplace",
        "edit.imageDelete",
        "edit.imageAdd",
        "edit.links",
        "edit.linkAdd",
        "edit.linkUpdate",
        "edit.linkDelete",
    ] {
        assert!(names.contains(&m), "{m}");
    }
    assert!(registry().static_names().contains(&"edit.checkUrl"));
}

#[test]
fn replace_text_commits_an_incremental_update() {
    let original = corpus("chrome-news-amiri.pdf");
    let mut doc = Document::open(original.clone(), None).unwrap();
    let blocks = doc
        .call("edit.textBlocks", &json!({"page": 0}), vec![])
        .unwrap()
        .json["blocks"]
        .clone();
    let b = blocks
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["editable"] == true && b["dir"] == "rtl")
        .unwrap()
        .clone();
    let r = doc
        .call(
            "edit.replaceText",
            &json!({"page": 0, "block": b["id"], "text": "نصٌّ جديدٌ تماماً", "expect": b["text"]}),
            vec![],
        )
        .unwrap();
    let bytes = &r.blobs[0];
    assert!(bytes.starts_with(&original));
    assert_eq!(r.json["revisions"], 2);
    let plain = doc.call("text.plain", &json!({}), vec![]).unwrap().json["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(plain.contains("نصٌّ جديدٌ تماماً"), "{plain}");
    // A failing edit (stale list) changes nothing.
    let len = doc.call("doc.info", &json!({}), vec![]).unwrap().json["byteLength"].clone();
    let e = doc
        .call(
            "edit.replaceText",
            &json!({"page": 0, "block": 0, "text": "x", "expect": "wrong"}),
            vec![],
        )
        .unwrap_err();
    assert_eq!(e.code, "stale");
    let e = doc
        .call(
            "edit.linkAdd",
            &json!({"page": 0, "box": [10, 10, 100, 30], "uri": "https://a.com/\u{202E}x"}),
            vec![],
        )
        .unwrap_err();
    assert_eq!(e.code, "url_refused");
    let info = doc.call("doc.info", &json!({}), vec![]).unwrap().json;
    assert_eq!(info["byteLength"], len);
    assert_eq!(info["unsavedChanges"], false);
}

#[test]
fn encrypted_documents_stay_encrypted_after_edits() {
    let root = format!("{}/../../../../tests/corpus", env!("CARGO_MANIFEST_DIR"));
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(format!("{root}/manifest.json")).unwrap()).unwrap();
    let entry = manifest["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["password"].is_string())
        .unwrap();
    let bytes = std::fs::read(format!("{root}/{}", entry["path"].as_str().unwrap())).unwrap();
    let pw = entry["password"].as_str().unwrap();
    let mut doc = Document::open(bytes.clone(), Some(pw)).unwrap();
    let r = doc
        .call(
            "edit.addText",
            &json!({"page": 0, "x": 50, "y": 790, "width": 400, "text": "مضاف بعد الحماية"}),
            vec![],
        )
        .unwrap();
    let out = r.blobs[0].clone();
    assert!(out.starts_with(&bytes));
    let tail = String::from_utf8_lossy(&out[bytes.len()..]).into_owned();
    assert!(tail.contains("/Encrypt"));
    assert!(
        !tail.contains("Amiri-Regular") || !tail.contains("/ActualText"),
        "content is ciphertext"
    );
    let mut re = Document::open(out, Some(pw)).unwrap();
    let plain = re.call("text.plain", &json!({}), vec![]).unwrap().json["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(plain.contains("مضاف بعد الحماية"), "{plain}");
}

#[test]
fn check_url_static() {
    let r = call_static(
        "edit.checkUrl",
        &json!({"url": "https://xn--mgbh0fb.example/"}),
        vec![],
    )
    .unwrap();
    assert_eq!(r.json["host"], "مثال.example");
    assert_eq!(r.json["verdict"], "ok");
}
