//! Created PDFs read back: logical-order Arabic through warraq-text, embedded subsets, tagging,
//! no `/Direction`, lopdf reload.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod common;

use common::*;
use warraq_create::{create, CreateOptions, FileSpec};

#[test]
fn arabic_text_file_round_trips_exactly() {
    let src = "بسم الله الرحمن الرحيم\n\nكتب الطالب درسه في المكتبة العامة بعد صلاة الظهر ثم عاد إلى بيته مسرورا بما تعلمه من علوم نافعة في ذلك اليوم الجميل.\n\nفي عام 2024 بلغت النسبة 35% و ١٢٣ مشاركا.\n\nZOOD PDF يدعم العربية أولا.";
    let pdf = one(
        &[("نص.txt", src.as_bytes())],
        &CreateOptions {
            locale: Some("ar".into()),
            ..opts()
        },
    );
    let text = plain_text(&pdf);
    dump(&pdf, "arabic-text");
    assert_eq!(words(&text), words(src), "extracted:\n{text}");
    assert_pdf_invariants(&pdf);
}

#[test]
fn justified_arabic_with_kashida_still_extracts_logically() {
    let para = "كتب الطالب درسه في المكتبة العامة بعد صلاة الظهر ثم عاد إلى بيته مسرورا بما تعلمه من علوم نافعة. ".repeat(6);
    let md = format!("# عنوان المستند\n\n{para}\n");
    // Markdown paragraphs are start-aligned; use a DOCX-like justified paragraph via the model.
    let pdf = one(&[("a.md", md.as_bytes())], &opts());
    assert_eq!(
        words(&plain_text(&pdf)),
        words(&format!("عنوان المستند {para}"))
    );
    let doc = justified_doc(&para);
    let l = warraq_create::layout::layout(&doc, &Default::default()).unwrap();
    let bytes = warraq_create::pdf::write(&l, &doc, &Default::default()).unwrap();
    dump(&bytes, "justified");
    let text = plain_text(&bytes);
    assert!(!text.contains('\u{0640}'), "no tatweel in extracted text");
    assert_eq!(words(&text), words(&para));
    // The drawing has tatweel glyphs (ActualText spans hide them).
    let content = all_content(&bytes);
    assert!(content.contains("/ActualText"));
}

#[test]
fn fonts_are_embedded_subsets() {
    let pdf = one(&[("a.txt", "سلام Hello".as_bytes())], &opts());
    let fonts = embedded_fonts(&pdf);
    assert!(!fonts.is_empty());
    for (name, len) in fonts {
        assert!(
            name.len() > 7 && name.as_bytes()[6] == b'+',
            "subset tag: {name}"
        );
        assert!(len < 40_000, "{name} FontFile2 is {len} bytes");
    }
}

#[test]
fn one_pdf_per_file_or_merged() {
    let files = [("a.txt", "one".as_bytes()), ("b.md", "# two".as_bytes())];
    let specs: Vec<(FileSpec, Vec<u8>)> = files
        .iter()
        .map(|(n, b)| {
            (
                FileSpec {
                    name: (*n).into(),
                    kind: None,
                },
                b.to_vec(),
            )
        })
        .collect();
    let merged = create(&specs, &opts()).unwrap();
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].page_count, 2);
    assert_eq!(merged[0].name, "a.pdf");
    let separate = create(
        &specs,
        &CreateOptions {
            merge: false,
            ..opts()
        },
    )
    .unwrap();
    assert_eq!(separate.len(), 2);
    assert_eq!(separate[1].name, "b.pdf");
    assert_eq!(plain_text(&separate[1].bytes).trim(), "two");
}

#[test]
fn page_numbers_are_artifacts() {
    let pdf = one(
        &[("a.txt", "نص قصير".as_bytes())],
        &CreateOptions {
            page_numbers: true,
            locale: Some("ar".into()),
            ..opts()
        },
    );
    let content = all_content(&pdf);
    assert!(content.contains("/Artifact BDC"));
    let with = plain_text(&pdf);
    assert!(with.contains("صفحة ١ من ١"), "{with}");
}
