#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
//! `standards.*` over the RPC: validate → convert (fonts as blobs) → the new file validates clean.

use serde_json::json;
use warraq_core::warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_core::{registry, Document};

fn liberation() -> Vec<Vec<u8>> {
    let dir = format!(
        "{}/../../../ui/assets/fonts/liberation",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "ttf"))
        .map(|p| std::fs::read(p).unwrap())
        .collect()
}

#[test]
fn validate_convert_revalidate() {
    let orig = sample_pdf(
        2,
        &SampleOptions {
            with_annotation: true,
            title: Some("تقرير".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let mut d = Document::open(orig.clone(), None).unwrap();
    let r = d
        .call("standards.validate", &json!({"profile": "pdfa-2b"}), vec![])
        .unwrap();
    let j = &r.json;
    assert_eq!(j["profile"], "pdfa-2b");
    assert_eq!(j["standard"], "ISO 19005-2:2011");
    assert_eq!(j["conforms"], false);
    assert!(j["errorCount"].as_u64().unwrap() > 0);
    let f = j["findings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["rule"] == "font-embedded")
        .unwrap();
    assert_eq!(f["clause"], "6.2.11.4.1");
    assert_eq!(f["key"], "standards.finding.font-embedded.substitute");
    assert_eq!(f["params"]["font"], "Helvetica");
    assert_eq!(f["fixable"], true);
    assert!(f["object"].as_str().unwrap().ends_with(" R"));
    assert_eq!(j["fontsNeeded"], json!(["LiberationSans-Regular"]));

    let c = d
        .call(
            "standards.convert",
            &json!({"profile": "pdfa-2b", "now": 1_790_000_000_000.0_f64, "tzOffsetMinutes": 180}),
            liberation(),
        )
        .unwrap();
    assert_eq!(c.json["conforms"], true, "{}", c.json["after"]);
    assert_eq!(c.json["suffix"], "PDFA-2b");
    assert!(c.json["actions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["id"] == "embed-font"));
    let out = c.blobs[0].clone();
    // The open document is untouched; the new file is a whole rewrite.
    assert_eq!(d.pdf().bytes(), &orig[..]);
    assert!(!out.starts_with(&orig));
    let mut o = Document::open(out, None).unwrap();
    let again = o
        .call(
            "standards.validate",
            &json!({"profile": "PDF/A-2b"}),
            vec![],
        )
        .unwrap();
    assert_eq!(again.json["conforms"], true);
    assert_eq!(again.json["errorCount"], 0);
    let s = String::from_utf8_lossy(o.pdf().bytes()).into_owned();
    assert!(
        s.contains("<pdfaid:part>2</pdfaid:part>")
            && s.contains("<pdfaid:conformance>B</pdfaid:conformance>")
    );
    assert!(s.contains("/GTS_PDFA1"));
    assert!(s.contains("2026-09-21T"), "ModDate from the UI clock");
}

#[test]
fn preflight_rules_and_errors() {
    let mut d = Document::open(sample_pdf(1, &SampleOptions::default()).unwrap(), None).unwrap();
    let p = d
        .call("standards.preflight", &json!({}), vec![])
        .unwrap()
        .json;
    assert_eq!(p["pageCount"], 1);
    assert_eq!(p["fonts"][0]["name"], "Helvetica");
    assert_eq!(p["fonts"][0]["embedded"], false);
    assert_eq!(p["fonts"][0]["substitute"], "LiberationSans");
    assert_eq!(p["encrypted"], false);
    assert!(p["pageBoxes"][0]["mediaBox"].is_array());
    let r = d.call("standards.rules", &json!({}), vec![]).unwrap().json;
    assert_eq!(r["pdfaRuleCount"], 52);
    assert_eq!(r["rules"].as_array().unwrap().len(), 56);
    let r = d
        .call("standards.rules", &json!({"profile": "pdfx-4"}), vec![])
        .unwrap()
        .json;
    assert_eq!(r["rules"].as_array().unwrap().len(), 14);
    for (m, p) in [
        ("standards.validate", json!({"profile": "pdfa-9"})),
        ("standards.validate", json!({})),
        (
            "standards.convert",
            json!({"profile": "pdfa-2b", "tzOffsetMinutes": 9999}),
        ),
        ("standards.preflight", json!({"x": 1})),
    ] {
        assert_eq!(
            d.call(m, &p, vec![]).unwrap_err().code,
            "invalid_params",
            "{m} {p}"
        );
    }
    let names = registry().doc_names();
    for m in [
        "standards.validate",
        "standards.convert",
        "standards.preflight",
        "standards.rules",
    ] {
        assert!(names.contains(&m));
    }
}
