//! Reading order, types, alt text, language, decorative, merge/split and title on an auto-tagged
//! document: every change is an incremental update and reads back from the saved bytes.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

mod common;

use common::*;
use warraq_a11y::autotag::{autotag, Options};
use warraq_a11y::edit;
use warraq_a11y::structure::{list, Item, Listing};
use warraq_a11y::A11yError;
use warraq_pdf::Pdf;

fn tagged() -> Vec<u8> {
    let mut pdf = Pdf::open(fixture("a11y-ar.pdf"), None).unwrap();
    autotag(&mut pdf, &Options::default()).unwrap();
    pdf.commit().unwrap()
}

/// Apply `f`, commit, check the prefix property, reopen and list.
fn step(bytes: &[u8], f: impl FnOnce(&mut Pdf)) -> (Vec<u8>, Listing) {
    let mut pdf = Pdf::open(bytes.to_vec(), None).unwrap();
    f(&mut pdf);
    let out = pdf.commit().unwrap();
    assert!(out.starts_with(bytes));
    let l = list(&Pdf::open(out.clone(), None).unwrap()).unwrap();
    (out, l)
}

fn find(l: &Listing, pred: impl Fn(&Item) -> bool) -> &Item {
    l.elements.iter().find(|e| pred(e)).expect("element")
}

fn top_texts(l: &Listing) -> Vec<String> {
    l.elements
        .iter()
        .filter(|e| e.depth == 1)
        .map(|e| e.text.clone())
        .collect()
}

#[test]
fn move_changes_reading_order() {
    let b = tagged();
    let l = list(&Pdf::open(b.clone(), None).unwrap()).unwrap();
    let en = find(&l, |e| e.text.starts_with("This paragraph"))
        .id
        .unwrap();
    let before = top_texts(&l);
    let pos = before
        .iter()
        .position(|t| t.starts_with("This paragraph"))
        .unwrap();
    assert!(pos >= 1);
    let (_, l2) = step(&b, |pdf| edit::move_to(pdf, en, pos - 1).unwrap());
    let after = top_texts(&l2);
    assert!(after[pos - 1].starts_with("This paragraph"), "{after:?}");
    assert!(after[pos].starts_with("يشرح"));
    assert_eq!(after.len(), before.len());
}

#[test]
fn alt_text_in_arabic_with_language() {
    let b = tagged();
    let l = list(&Pdf::open(b.clone(), None).unwrap()).unwrap();
    let fig = find(&l, |e| e.role == "Figure").id.unwrap();
    let alt = "شعار زود باللونين الأزرق والبرتقالي";
    let (out, l2) = step(&b, |pdf| edit::set_alt(pdf, fig, alt, Some("ar")).unwrap());
    let f = find(&l2, |e| e.role == "Figure");
    assert_eq!(f.alt.as_deref(), Some(alt));
    assert_eq!(f.lang.as_deref(), Some("ar"));
    // UTF-16BE with BOM in the file.
    let hex: String = std::iter::once("FEFF".to_string())
        .chain(alt.encode_utf16().map(|u| format!("{u:04X}")))
        .collect();
    assert!(String::from_utf8_lossy(&out).contains(&hex));
}

#[test]
fn type_and_language_changes() {
    let b = tagged();
    let l = list(&Pdf::open(b.clone(), None).unwrap()).unwrap();
    let p = find(&l, |e| e.text.starts_with("الفقرة الأخيرة"))
        .id
        .unwrap();
    let (b2, l2) = step(&b, |pdf| edit::set_type(pdf, p, "H3").unwrap());
    assert_eq!(find(&l2, |e| e.id == Some(p)).role, "H3");
    let (_, l3) = step(&b2, |pdf| edit::set_lang(pdf, p, Some("fa")).unwrap());
    let e = find(&l3, |e| e.id == Some(p));
    assert_eq!(e.lang.as_deref(), Some("fa"));
    assert_eq!(e.effective_lang.as_deref(), Some("fa"));
    // Bad input is refused.
    let mut pdf = Pdf::open(b.clone(), None).unwrap();
    assert!(matches!(
        edit::set_type(&mut pdf, p, "Bogus"),
        Err(A11yError::Params(_))
    ));
    assert!(matches!(
        edit::set_lang(&mut pdf, p, Some("ar\u{202e}")),
        Err(A11yError::Params(_))
    ));
    assert!(matches!(
        edit::set_type(&mut pdf, 999_999, "P"),
        Err(A11yError::NotFound(_))
    ));
}

#[test]
fn decorative_figure_becomes_an_artifact_without_moving_pixels() {
    let b = tagged();
    let l = list(&Pdf::open(b.clone(), None).unwrap()).unwrap();
    let fig = find(&l, |e| e.role == "Figure").id.unwrap();
    let (out, l2) = step(&b, |pdf| edit::decorative(pdf, fig).unwrap());
    assert!(!l2.elements.iter().any(|e| e.role == "Figure"));
    let pdf = Pdf::open(out.clone(), None).unwrap();
    assert!(untagged_ops(&pdf, 0).is_empty());
    let data = warraq_edit::page::load(&pdf, 0).unwrap().data;
    assert!(String::from_utf8_lossy(&data).contains("/Artifact BMC"));
    assert_eq!(render_all(&b), render_all(&out));
    // Setting the type Artifact does the same.
    let p = find(&l, |e| e.text.starts_with("زوروا")).id.unwrap();
    let mut pdf = Pdf::open(b.clone(), None).unwrap();
    // A paragraph holding a link annotation cannot become an artifact.
    assert!(matches!(
        edit::set_type(&mut pdf, p, "Artifact"),
        Err(A11yError::NotPossible(_))
    ));
}

#[test]
fn merge_and_split_paragraphs() {
    let b = tagged();
    let l = list(&Pdf::open(b.clone(), None).unwrap()).unwrap();
    let h2 = find(&l, |e| e.text == "مقدمة").id.unwrap();
    let n = l.elements.len();
    let (b2, l2) = step(&b, |pdf| edit::merge_next(pdf, h2).unwrap());
    let merged = find(&l2, |e| e.id == Some(h2));
    assert!(merged.text.starts_with("مقدمة يشرح"), "{}", merged.text);
    assert!(merged.text.contains("PDF"));
    assert!(l2.elements.len() < n);
    // Split back at the middle boundary: two elements of the same type, text preserved in order.
    let mut new_id = 0;
    let (_, l3) = step(&b2, |pdf| new_id = edit::split(pdf, h2, None).unwrap());
    let a = find(&l3, |e| e.id == Some(h2));
    let c = find(&l3, |e| e.id == Some(new_id));
    assert_eq!(a.role, c.role);
    assert_eq!(
        squash(&format!("{}{}", a.text, c.text)),
        squash(&merged.text)
    );
    // The page stays fully tagged and the parent tree consistent.
    let pdf = Pdf::open(b2, None).unwrap();
    let r = warraq_a11y::check::check(&pdf).unwrap();
    assert_eq!(r.counts.get("parent-tree"), None, "{:?}", r.findings);
}

#[test]
fn title_and_document_language() {
    let b = tagged();
    let (_, l) = step(&b, |pdf| {
        edit::set_title(pdf, "تقرير الوصول").unwrap();
        edit::set_doc_lang(pdf, "ar-SA").unwrap();
    });
    assert_eq!(l.title.as_deref(), Some("تقرير الوصول"));
    assert!(l.display_doc_title);
    assert_eq!(l.lang.as_deref(), Some("ar-SA"));
}

#[test]
fn untagged_documents_refuse_structure_edits() {
    let mut pdf = Pdf::open(fixture("a11y-ar.pdf"), None).unwrap();
    assert!(matches!(
        edit::move_to(&mut pdf, 1, 0),
        Err(A11yError::NotTagged)
    ));
    let l = list(&pdf).unwrap();
    assert!(!l.tagged && l.elements.is_empty());
}
