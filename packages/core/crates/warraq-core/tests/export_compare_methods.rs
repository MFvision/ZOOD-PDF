//! export.* and compare.* through the RPC (warraq-office).
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
fn methods_are_registered() {
    let docs = registry().doc_names();
    for m in [
        "export.docx",
        "export.xlsx",
        "export.pptx",
        "export.html",
        "export.markdown",
        "export.text",
        "compare.text",
    ] {
        assert!(docs.contains(&m), "{m}");
    }
    let stat = registry().static_names();
    for m in ["export.zip", "compare.visual", "compare.report"] {
        assert!(stat.contains(&m), "{m}");
    }
}

#[test]
fn export_docx_and_text_of_arabic_file() {
    let mut d = Document::open(corpus("chrome-news-amiri.pdf"), None).unwrap();
    let r = d.call("export.docx", &json!({"title": "خبر"}), vec![]).unwrap();
    assert_eq!(r.json["extension"], "docx");
    assert_eq!(r.blobs.len(), 1);
    assert!(r.blobs[0].starts_with(b"PK\x03\x04"));
    let files = warraq_office::zip::read(&r.blobs[0], 64 << 20).unwrap();
    let doc = files.iter().find(|f| f.0 == "word/document.xml").unwrap();
    let xml = String::from_utf8(doc.1.clone()).unwrap();
    assert!(xml.contains("<w:bidi/>"));
    assert!(xml.contains("التحول الرقمي في المؤسسات الحكومية العربية"));

    let t = d.call("export.text", &json!({"pages": [0]}), vec![]).unwrap();
    let text = String::from_utf8(t.blobs[0].clone()).unwrap();
    assert!(text.starts_with("التحول الرقمي"));
    // the original document is untouched by exports
    assert!(!d.pdf().has_changes());
}

#[test]
fn export_errors_are_typed() {
    let mut d = Document::open(corpus("chrome-news-amiri.pdf"), None).unwrap();
    let e = d.call("export.docx", &json!({"pages": [99]}), vec![]).unwrap_err();
    assert_eq!(e.code, "page_out_of_range");
    let e = d.call("export.docx", &json!({"pages": "all"}), vec![]).unwrap_err();
    assert_eq!(e.code, "invalid_params");
}

#[test]
fn zip_bundles_named_blobs() {
    let r = call_static(
        "export.zip",
        &json!({"names": ["صفحة-1.png", "صفحة-2.png"]}),
        vec![b"\x89PNG-1".to_vec(), b"\x89PNG-2".to_vec()],
    )
    .unwrap();
    let files = warraq_office::zip::read(&r.blobs[0], 1 << 20).unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!(files[1].0, "صفحة-2.png");
    assert_eq!(files[1].1, b"\x89PNG-2");
    let e = call_static("export.zip", &json!({"names": ["a"]}), vec![]).unwrap_err();
    assert_eq!(e.code, "invalid_params");
    let e = call_static("export.zip", &json!({"names": ["../x"]}), vec![b"1".to_vec()]).unwrap_err();
    assert_eq!(e.code, "invalid_params");
}

#[test]
fn compare_text_between_two_documents() {
    let a = corpus("chrome-news-amiri.pdf");
    let b = corpus("chrome-news-cairo-type3.pdf");
    let mut d = Document::open(a.clone(), None).unwrap();
    let same = d.call("compare.text", &json!({}), vec![a]).unwrap();
    assert_eq!(same.json["summary"]["changed"], 0);
    assert_eq!(same.json["changes"].as_array().unwrap().len(), 0);
    let r = d.call("compare.text", &json!({}), vec![b]).unwrap();
    assert!(r.json["summary"]["wordsB"].as_u64().unwrap() > 10);
    let e = d.call("compare.text", &json!({}), vec![]).unwrap_err();
    assert_eq!(e.code, "invalid_params");
    let e = d.call("compare.text", &json!({}), vec![b"not a pdf".to_vec()]).unwrap_err();
    assert_ne!(e.code, "");
}

#[test]
fn compare_visual_and_report() {
    let (w, h) = (20u32, 10u32);
    let a = vec![255u8; (w * h * 4) as usize];
    let mut b = a.clone();
    b[..8].copy_from_slice(&[0, 0, 0, 255, 0, 0, 0, 255]);
    let r = call_static(
        "compare.visual",
        &json!({"widthA": w, "heightA": h, "widthB": w, "heightB": h, "threshold": 40}),
        vec![a, b],
    )
    .unwrap();
    assert_eq!(r.json["changedPixels"], 2);
    assert_eq!(r.json["boxes"].as_array().unwrap().len(), 1);
    assert!(r.blobs[0].starts_with(b"\x89PNG"));
    let overlay = r.blobs[0].clone();
    let rep = call_static(
        "compare.report",
        &json!({
            "locale": "ar",
            "nameA": "a.pdf",
            "nameB": "b.pdf",
            "text": {"summary": {"inserted": 0, "deleted": 0, "changed": 1, "wordsA": 3, "wordsB": 3, "pagesA": 1, "pagesB": 1, "truncated": false},
                     "changes": [{"kind": "changed", "old": "ثلاثين", "new": "عشرين", "pageA": 0, "pageB": 0, "rectsA": [], "rectsB": []}]},
            "visual": [{"page": 0, "blob": 0, "regions": 1}]
        }),
        vec![overlay],
    )
    .unwrap();
    let html = String::from_utf8(rep.blobs[0].clone()).unwrap();
    assert!(html.contains("dir=\"rtl\""));
    assert!(html.contains("عشرين"));
    assert!(html.contains("data:image/png;base64,"));
}
