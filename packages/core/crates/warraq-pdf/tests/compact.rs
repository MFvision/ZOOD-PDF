//! Compact whole rewrite (object streams + cross-reference stream), used by Compress.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod common;

use common::{contains, page_text, python};
use warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_pdf::crypt::PermissionFlags;
use warraq_pdf::{pages, Pdf, Protection, SecurityHandler, XrefKind};

#[test]
fn compact_rewrite_packs_objects_into_object_streams() {
    let orig = sample_pdf(
        5,
        &SampleOptions {
            with_annotation: true,
            title: Some("Report".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let pdf = Pdf::open(orig.clone(), None).unwrap();
    let out = pdf.rewrite(pdf.objects(), Protection::Keep, true).unwrap();
    assert!(out.starts_with(b"%PDF-1.5"));
    assert!(contains(&out, b"/ObjStm"));
    assert!(contains(&out, b"/XRef"));
    // Dictionaries are no longer top-level objects in the file body.
    assert!(!contains(&out, b"/Type /Catalog"));
    let re = Pdf::open(out.clone(), None).unwrap();
    assert_eq!(re.xref_kind(), XrefKind::Stream);
    assert_eq!(pages::count(&re).unwrap(), 5);
    for i in 0..5 {
        assert!(page_text(&re, i).contains(&format!("Page {}", i + 1)));
    }
    assert!(out.len() < orig.len(), "{} >= {}", out.len(), orig.len());
    // An incremental update on top of the compact file works (xref stream section).
    let mut again = Pdf::open(out.clone(), None).unwrap();
    pages::rotate(&mut again, &[0], 90).unwrap();
    let upd = again.commit().unwrap();
    assert!(upd.starts_with(&out));
    assert_eq!(
        pages::flatten(&Pdf::open(upd, None).unwrap()).unwrap()[0].rotate,
        90
    );
    if let Some(s) = python(
        "import sys,pypdf;r=pypdf.PdfReader(sys.argv[1]);print(len(r.pages), r.metadata.title, r.pages[4].extract_text())",
        &out,
    ) {
        assert!(s.contains("5 Report Page 5"), "{s}");
    }
}

#[test]
fn compact_rewrite_keeps_protection() {
    let plain = sample_pdf(2, &SampleOptions::default()).unwrap();
    let h = SecurityHandler::new_aes256("user", "owner", &PermissionFlags::default()).unwrap();
    let enc = Pdf::open(plain, None)
        .unwrap()
        .write_full(Protection::New(h))
        .unwrap();
    let pdf = Pdf::open(enc, Some("owner")).unwrap();
    let out = pdf.rewrite(pdf.objects(), Protection::Keep, true).unwrap();
    assert!(contains(&out, b"/ObjStm"));
    assert!(Pdf::open(out.clone(), None).is_err());
    let re = Pdf::open(out.clone(), Some("user")).unwrap();
    assert_eq!(re.security().unwrap().r, 6);
    assert!(page_text(&re, 1).contains("Page 2"));
    if let Some(s) = python(
        "import sys,pypdf;r=pypdf.PdfReader(sys.argv[1]);r.decrypt('user');print(len(r.pages), r.pages[1].extract_text())",
        &out,
    ) {
        assert!(s.contains("2 Page 2"), "{s}");
    }
}
