//! Checker before/after auto-tagging and every automatic fix.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod common;

use common::*;
use lopdf::{dictionary, Object};
use warraq_a11y::autotag::{autotag, Options};
use warraq_a11y::check::{check, fix, Report, RULES};
use warraq_a11y::edit;
use warraq_a11y::structure::list;
use warraq_pdf::Pdf;

fn rules(r: &Report) -> Vec<&'static str> {
    r.counts.keys().copied().collect()
}

fn fixed(bytes: &[u8], only: &[&str], title: Option<&str>) -> (Vec<u8>, Report) {
    let mut pdf = Pdf::open(bytes.to_vec(), None).unwrap();
    let only: Vec<String> = only.iter().map(|s| s.to_string()).collect();
    fix(&mut pdf, &only, title).unwrap();
    let out = pdf.commit().unwrap();
    assert!(out.starts_with(bytes));
    let r = check(&Pdf::open(out.clone(), None).unwrap()).unwrap();
    (out, r)
}

#[test]
fn every_finding_has_clause_key_and_known_rule() {
    let pdf = Pdf::open(fixture("a11y-ar.pdf"), None).unwrap();
    let r = check(&pdf).unwrap();
    assert!(!r.certified);
    for f in &r.findings {
        assert!(RULES.iter().any(|x| x.id == f.rule));
        assert_eq!(f.key, format!("a11y.finding.{}.{}", f.rule, f.variant));
        assert!(!f.clause.is_empty());
    }
}

#[test]
fn untagged_file_fails_then_passes_after_fixes_and_alt_text() {
    let original = fixture("a11y-ar.pdf");
    let before = check(&Pdf::open(original.clone(), None).unwrap()).unwrap();
    let r = rules(&before);
    for id in [
        "struct-tree",
        "marked",
        "untagged-content",
        "title",
        "display-doc-title",
        "doc-lang",
        "annot-tagged",
    ] {
        assert!(r.contains(&id), "{id} missing from {r:?}");
    }
    assert!(!before.passed);
    assert!(before
        .findings
        .iter()
        .find(|f| f.rule == "title")
        .is_some_and(|f| f.fixable));

    // Fix everything (title given, as the UI asks for it).
    let (out, after) = fixed(&original, &[], Some("تقرير إمكانية الوصول"));
    let left = rules(&after);
    assert_eq!(left, vec!["figure-alt"], "{:?}", after.findings);
    assert_eq!(render_all(&original), render_all(&out));

    // Alt text on the figure → no errors left.
    let pdf = Pdf::open(out.clone(), None).unwrap();
    let fig = list(&pdf)
        .unwrap()
        .elements
        .iter()
        .find(|e| e.role == "Figure")
        .unwrap()
        .id
        .unwrap();
    let mut pdf = Pdf::open(out.clone(), None).unwrap();
    edit::set_alt(&mut pdf, fig, "رسم بلونين", Some("ar")).unwrap();
    let done = pdf.commit().unwrap();
    let r = check(&Pdf::open(done, None).unwrap()).unwrap();
    assert!(r.passed, "{:?}", r.findings);
    assert_eq!(r.error_count, 0);
}

fn autotagged() -> Vec<u8> {
    let mut pdf = Pdf::open(fixture("a11y-ar.pdf"), None).unwrap();
    autotag(
        &mut pdf,
        &Options {
            title: Some("t".into()),
            ..Options::default()
        },
    )
    .unwrap();
    pdf.commit().unwrap()
}

fn id_of(bytes: &[u8], pred: impl Fn(&warraq_a11y::structure::Item) -> bool) -> u32 {
    let pdf = Pdf::open(bytes.to_vec(), None).unwrap();
    list(&pdf)
        .unwrap()
        .elements
        .iter()
        .find(|e| pred(e))
        .unwrap()
        .id
        .unwrap()
}

fn apply(bytes: &[u8], f: impl FnOnce(&mut Pdf)) -> Vec<u8> {
    let mut pdf = Pdf::open(bytes.to_vec(), None).unwrap();
    f(&mut pdf);
    pdf.commit().unwrap()
}

#[test]
fn heading_skip_is_found_and_fixed() {
    let b = autotagged();
    let h2 = id_of(&b, |e| e.text == "مقدمة");
    let b = apply(&b, |pdf| edit::set_type(pdf, h2, "H4").unwrap());
    let r = check(&Pdf::open(b.clone(), None).unwrap()).unwrap();
    let f = r
        .findings
        .iter()
        .find(|f| f.rule == "heading-skip")
        .expect("finding");
    assert_eq!(f.params.get("level").map(String::as_str), Some("4"));
    assert_eq!(f.element, Some(h2));
    assert_eq!(f.clause, "7.4.2");
    assert_eq!(f.matterhorn, Some("14-003"));
    let (out, r2) = fixed(&b, &["heading-skip"], None);
    assert!(!r2.counts.contains_key("heading-skip"));
    let l = list(&Pdf::open(out, None).unwrap()).unwrap();
    assert_eq!(
        l.elements.iter().find(|e| e.id == Some(h2)).unwrap().role,
        "H2"
    );
}

#[test]
fn table_without_headers_is_found_and_fixed() {
    let b = autotagged();
    let pdf = Pdf::open(b.clone(), None).unwrap();
    let ths: Vec<u32> = list(&pdf)
        .unwrap()
        .elements
        .iter()
        .filter(|e| e.role == "TH")
        .map(|e| e.id.unwrap())
        .collect();
    let b = apply(&b, |pdf| {
        for id in &ths {
            edit::set_type(pdf, *id, "TD").unwrap();
        }
    });
    let r = check(&Pdf::open(b.clone(), None).unwrap()).unwrap();
    assert!(r.counts.contains_key("table-th"));
    let (_, r2) = fixed(&b, &["table-th"], None);
    assert!(!r2.counts.contains_key("table-th"));
}

#[test]
fn language_mismatch_is_found_and_fixed() {
    let b = autotagged();
    let p = id_of(&b, |e| e.text.starts_with("الفقرة الأخيرة"));
    let b = apply(&b, |pdf| edit::set_lang(pdf, p, Some("en")).unwrap());
    let r = check(&Pdf::open(b.clone(), None).unwrap()).unwrap();
    let f = r
        .findings
        .iter()
        .find(|f| f.rule == "lang-mismatch")
        .expect("mismatch");
    assert_eq!(f.params.get("detected").map(String::as_str), Some("ar"));
    let (out, r2) = fixed(&b, &["lang-mismatch"], None);
    assert!(
        !r2.counts.contains_key("lang-mismatch"),
        "{:?}",
        r2.findings
    );
    let l = list(&Pdf::open(out, None).unwrap()).unwrap();
    assert_eq!(
        l.elements
            .iter()
            .find(|e| e.id == Some(p))
            .unwrap()
            .lang
            .as_deref(),
        Some("ar")
    );
}

#[test]
fn direction_trap_and_new_annotations() {
    let b = autotagged();
    // /Direction /R2L plus a new sticky note that is not in the tree.
    let b = apply(&b, |pdf| {
        let root = pdf.root_id().unwrap();
        let mut cat = pdf.catalog().unwrap().clone();
        cat.set(
            "ViewerPreferences",
            dictionary! { "Direction" => "R2L", "DisplayDocTitle" => true },
        );
        pdf.set(root, Object::Dictionary(cat));
        let page = warraq_pdf::pages::flatten(pdf).unwrap()[1].id;
        let note = pdf.add(Object::Dictionary(dictionary! {
            "Type" => "Annot", "Subtype" => "Text",
            "Rect" => vec![100.into(), 100.into(), 120.into(), 120.into()],
            "Contents" => Object::string_literal("note"),
        }));
        let mut pd = pdf.get_dict(page).unwrap().clone();
        pd.set("Annots", vec![Object::Reference(note)]);
        pdf.set(page, Object::Dictionary(pd));
    });
    let r = check(&Pdf::open(b.clone(), None).unwrap()).unwrap();
    assert!(r.counts.contains_key("direction-trap"));
    assert!(r.counts.contains_key("annot-tagged"));
    let (_, r2) = fixed(&b, &["direction-trap", "annot-tagged"], None);
    assert!(!r2.counts.contains_key("direction-trap"));
    assert!(!r2.counts.contains_key("annot-tagged"), "{:?}", r2.findings);
    let raw = String::from_utf8_lossy(&b).into_owned();
    assert!(raw.contains("/Direction"));
}

#[test]
fn form_field_gets_an_accessible_name_from_its_label() {
    let b = autotagged();
    // A text field just left of the English paragraph's line end («…language test.» ends near x=365).
    let b = apply(&b, |pdf| {
        let page = warraq_pdf::pages::flatten(pdf).unwrap()[0].id;
        let w = pdf.add(Object::Dictionary(dictionary! {
            "Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx",
            "T" => Object::string_literal("f1"),
            "Rect" => vec![372.into(), 646.into(), 470.into(), 662.into()],
            "P" => Object::Reference(page),
        }));
        let mut pd = pdf.get_dict(page).unwrap().clone();
        let mut annots = match pd.get(b"Annots") {
            Ok(Object::Array(a)) => a.clone(),
            _ => Vec::new(),
        };
        annots.push(Object::Reference(w));
        pd.set("Annots", annots);
        pdf.set(page, Object::Dictionary(pd));
    });
    let r = check(&Pdf::open(b.clone(), None).unwrap()).unwrap();
    let f = r
        .findings
        .iter()
        .find(|f| f.rule == "field-tu")
        .expect("field-tu");
    assert!(f.fixable, "{:?}", f.params);
    let (out, r2) = fixed(&b, &["field-tu", "annot-tagged"], None);
    assert!(!r2.counts.contains_key("field-tu"), "{:?}", r2.findings);
    assert!(String::from_utf8_lossy(&out).contains("/TU"));
}

#[test]
fn corpus_files_check_without_panicking() {
    let dir = root().join("tests/corpus/pdf");
    for entry in std::fs::read_dir(dir).unwrap() {
        let p = entry.unwrap().path();
        if p.extension().is_none_or(|e| e != "pdf") {
            continue;
        }
        let bytes = std::fs::read(&p).unwrap();
        let Ok(pdf) = Pdf::open(bytes, None) else {
            continue;
        };
        let r = check(&pdf).unwrap();
        // Chromium files are tagged by Chrome: never "untagged".
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        if name.starts_with("chrome-") {
            assert!(!r.counts.contains_key("struct-tree"), "{name}");
        }
        let _ = list(&pdf).unwrap();
    }
}
