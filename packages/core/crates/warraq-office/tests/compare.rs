//! Compare proofs: generated Arabic versions with known edits.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod common;

use common::*;
use serde_json::json;
use warraq_office::compare::ChangeKind;
use warraq_office::compare_docs;
use warraq_office::report::{render, ReportInput};
use warraq_text::DocSource;

fn version(lines: &[&str], second_page: &[&str]) -> Vec<u8> {
    let mut p1 = PageBuilder::new();
    for (i, l) in lines.iter().enumerate() {
        p1.text(545.0, 80.0 + 28.0 * i as f64, l, 14.0, true);
    }
    let mut p2 = PageBuilder::new();
    for (i, l) in second_page.iter().enumerate() {
        p2.text(545.0, 80.0 + 28.0 * i as f64, l, 14.0, true);
    }
    build(&[&p1, &p2])
}

const V1: &[&str] = &[
    "عقد توريد أجهزة حاسوب",
    "يلتزم المورد بتسليم الأجهزة خلال ثلاثين يومًا من تاريخ التوقيع.",
    "قيمة العقد 1500 ريال سعودي تدفع على دفعتين.",
];
const V1_P2: &[&str] = &["تُطبق أحكام النظام السعودي على هذا العقد."];

fn diff(a: Vec<u8>, b: Vec<u8>, params: serde_json::Value) -> warraq_office::compare::TextDiff {
    let pa = warraq_pdf::Pdf::open(a, None).unwrap();
    let pb = warraq_pdf::Pdf::open(b, None).unwrap();
    compare_docs(
        &DocSource::borrowed(pa.document()),
        &DocSource::borrowed(pb.document()),
        &params,
    )
    .unwrap()
}

#[test]
fn identical_documents_have_no_changes() {
    let d = diff(version(V1, V1_P2), version(V1, V1_P2), json!({}));
    assert!(d.changes.is_empty(), "{:?}", d.changes);
    assert!(d.summary.words_a > 20);
    assert_eq!(d.summary.words_a, d.summary.words_b);
}

#[test]
fn finds_a_changed_word_with_rectangles_on_both_documents() {
    let v2 = [
        V1[0],
        "يلتزم المورد بتسليم الأجهزة خلال عشرين يومًا من تاريخ التوقيع.",
        V1[2],
    ];
    let d = diff(version(V1, V1_P2), version(&v2, V1_P2), json!({}));
    assert_eq!(d.changes.len(), 1, "{:?}", d.changes);
    let c = &d.changes[0];
    assert_eq!(c.kind, ChangeKind::Changed);
    assert_eq!(c.old, "ثلاثين");
    assert_eq!(c.new, "عشرين");
    assert_eq!((c.page_a, c.page_b), (0, 0));
    assert_eq!(c.rects_a.len(), 1);
    assert_eq!(c.rects_b.len(), 1);
    // The word sits on the second line (baseline 108 pt from the top) near the right margin.
    let r = c.rects_a[0];
    assert!(r.y0 < 108.0 && r.y1 > 100.0, "{r:?}");
    assert!(r.x1 < 545.0 && r.x0 > 200.0, "{r:?}");
    assert_eq!(d.summary.changed, 1);
}

#[test]
fn insertions_deletions_and_page_moves() {
    let v2 = [
        V1[0],
        V1[1],
        "قيمة العقد 1500 ريال سعودي تدفع على ثلاث دفعات متساوية.",
        "ويجوز تمديد العقد باتفاق الطرفين.",
    ];
    let p2: &[&str] = &[];
    let d = diff(version(V1, V1_P2), version(&v2, p2), json!({}));
    let kinds: Vec<ChangeKind> = d.changes.iter().map(|c| c.kind).collect();
    assert!(kinds.contains(&ChangeKind::Changed), "{:?}", d.changes);
    // page 2's sentence is gone in B
    let del = d.changes.iter().find(|c| c.old.contains("أحكام")).unwrap();
    // The removed page-2 sentence is highlighted on page 2 of A (a change may span pages).
    assert!(del.rects_a.iter().any(|r| r.page == 1), "{del:?}");
    assert!(del.rects_b.iter().all(|r| r.page == 0), "{del:?}");
    assert!(
        d.changes.iter().any(|c| c.new.contains("تمديد")),
        "{:?}",
        d.changes
    );
}

#[test]
fn tashkeel_is_ignored_by_default_and_detected_on_request() {
    let v2 = [
        V1[0],
        "يلتزم المورِّد بتسليم الأجهزة خلال ثلاثين يومًا من تاريخ التوقيع.",
        V1[2],
    ];
    let d = diff(version(V1, V1_P2), version(&v2, V1_P2), json!({}));
    assert!(d.changes.is_empty(), "{:?}", d.changes);
    let strict = diff(
        version(V1, V1_P2),
        version(&v2, V1_P2),
        json!({"options": {"ignoreDiacritics": false}}),
    );
    assert_eq!(strict.changes.len(), 1);
    assert_eq!(strict.changes[0].new, "المورِّد");
}

#[test]
fn html_report_contains_the_change_and_no_scripts() {
    let v2 = [
        V1[0],
        "يلتزم المورد بتسليم الأجهزة خلال عشرين يومًا من تاريخ التوقيع.",
        V1[2],
    ];
    let d = diff(version(V1, V1_P2), version(&v2, V1_P2), json!({}));
    let overlay = warraq_office::png::encode(2, 2, 4, &[255; 16]).unwrap();
    let input: ReportInput = serde_json::from_value(json!({
        "locale": "ar",
        "nameA": "عقد-1.pdf",
        "nameB": "عقد-2.pdf",
        "labels": {"title": "تقرير المقارنة", "changed": "معدَّل"},
        "text": serde_json::to_value(&d).unwrap(),
        "visual": [{"page": 0, "blob": 0, "regions": 1}],
    }))
    .unwrap();
    let html = String::from_utf8(render(&input, &[overlay])).unwrap();
    assert!(html.contains("<html lang=\"ar\" dir=\"rtl\">"));
    assert!(html.contains("<del dir=\"rtl\">ثلاثين</del>"));
    assert!(html.contains("<ins dir=\"rtl\">عشرين</ins>"));
    assert!(html.contains("تقرير المقارنة"));
    assert!(html.contains("data:image/png;base64,"));
    assert!(html.contains("<b>١</b>معدَّل"), "Arabic-Indic counts");
    assert!(!html.to_lowercase().contains("<script"));
    assert!(
        !html.contains("http://") && !html.contains("https://"),
        "self-contained"
    );
}
