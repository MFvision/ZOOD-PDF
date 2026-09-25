//! RPC surface of the Redact tool: `redact.find`, `redact.apply`, `redact.sanitize`, and the
//! protection rules around them.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use serde_json::{json, Value};
use warraq_core::warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_core::{registry, Document, Reply};

fn sample() -> Vec<u8> {
    sample_pdf(
        2,
        &SampleOptions {
            with_annotation: true,
            title: Some("Page 2 report".into()),
            ..Default::default()
        },
    )
    .unwrap()
}

fn call(doc: &mut Document, m: &str, p: Value) -> Reply {
    doc.call(m, &p, vec![])
        .unwrap_or_else(|e| panic!("{m}: {e}"))
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

#[test]
fn methods_are_registered() {
    let names = registry().doc_names();
    for m in ["redact.find", "redact.apply", "redact.sanitize"] {
        assert!(names.contains(&m), "{m}");
    }
}

#[test]
fn find_then_apply_is_a_single_revision_without_the_text() {
    let mut d = Document::open(sample(), None).unwrap();
    let r = call(&mut d, "redact.find", json!({"query": "page 2"}));
    let hits = r.json["hits"].as_array().unwrap();
    assert_eq!(hits.len(), 1, "{hits:?}");
    assert_eq!(hits[0]["page"], 1);
    assert_eq!(hits[0]["kind"], "query");
    let rect = hits[0]["rects"][0].clone();
    assert!(hits[0]["viewRects"][0].is_array());
    assert!(r.json["pages"][0]["width"].as_f64().unwrap() > 0.0);
    let r = call(
        &mut d,
        "redact.apply",
        json!({"areas": [{"page": 1, "rect": rect}], "annotations": true}),
    );
    assert_eq!(r.json["revisions"], 1);
    assert!(
        r.json["report"]["content"]["glyphsRemoved"]
            .as_u64()
            .unwrap()
            >= 6
    );
    let out = &r.blobs[0];
    let mut again = Document::open(out.clone(), None).unwrap();
    let text = call(&mut again, "text.plain", json!({}));
    let t = text.json["text"].as_str().unwrap();
    assert!(t.contains("Page 1") && !t.contains("Page 2"), "{t}");
    assert!(!contains(out, b"(Page 2)"));
    // The document itself now holds the redacted bytes.
    let info = call(&mut d, "doc.info", json!({}));
    assert_eq!(
        info.json["byteLength"].as_u64().unwrap() as usize,
        out.len()
    );
    // Words of 3+ letters are scrubbed from other strings ("2" is too short to scrub safely).
    assert_eq!(info.json["title"], " 2 report", "title scrubbed");
}

#[test]
fn bad_params_and_patterns() {
    let mut d = Document::open(sample(), None).unwrap();
    let e = d
        .call("redact.find", &json!({"patterns": ["nope"]}), vec![])
        .unwrap_err();
    assert_eq!(e.code, "invalid_params");
    let e = d
        .call("redact.find", &json!({"regex": "("}), vec![])
        .unwrap_err();
    assert_eq!(e.code, "invalid_pattern");
    let e = d
        .call("redact.apply", &json!({"annotations": false}), vec![])
        .unwrap_err();
    assert_eq!(e.code, "invalid_params");
    let r = call(
        &mut d,
        "redact.find",
        json!({"patterns": ["email", "phone", "saudiId", "iban", "card", "date"]}),
    );
    assert_eq!(r.json["hits"].as_array().unwrap().len(), 0);
}

#[test]
fn sanitize_reports_and_rewrites() {
    let mut d = Document::open(sample(), None).unwrap();
    let r = call(&mut d, "redact.sanitize", json!({}));
    assert_eq!(r.json["revisions"], 1);
    assert_eq!(r.json["report"]["metadata"], 1);
    assert_eq!(r.json["report"]["comments"], 1, "{}", r.json);
    let e = d
        .call("redact.sanitize", &json!({"unknown": true}), vec![])
        .unwrap_err();
    assert_eq!(e.code, "invalid_params");
    let r = call(
        &mut d,
        "redact.sanitize",
        json!({"forms": "flatten", "links": true, "bookmarks": true}),
    );
    assert_eq!(r.json["revisions"], 1);
}

#[test]
fn encrypted_document_keeps_its_password_through_redaction() {
    let mut d = Document::open(sample(), None).unwrap();
    let r = call(
        &mut d,
        "protect.set",
        json!({"userPassword": "كلمة", "ownerPassword": "owner"}),
    );
    let enc = r.blobs[0].clone();
    let mut e = Document::open(enc, Some("owner")).unwrap();
    let hits = call(&mut e, "redact.find", json!({"query": "Page 1"}));
    let rect = hits.json["hits"][0]["rects"][0].clone();
    let r = call(
        &mut e,
        "redact.apply",
        json!({"areas": [{"page": 0, "rect": rect}]}),
    );
    let out = r.blobs[0].clone();
    assert_eq!(
        Document::open(out.clone(), None).unwrap_err().code,
        "password_required"
    );
    let mut again = Document::open(out, Some("كلمة")).unwrap();
    let t = call(&mut again, "text.plain", json!({}));
    assert!(!t.json["text"].as_str().unwrap().contains("Page 1"));
}
