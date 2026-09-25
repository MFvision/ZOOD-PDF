#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod common;
use common::*;
use warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_pdf::lopdf::{self, Object};
use warraq_pdf::{pages, revisions, Limits, Pdf, Protection, XrefKind};

fn count_objs(bytes: &[u8]) -> usize {
    bytes.windows(4).filter(|w| w == b" obj").count()
}

fn rotate_first(pdf: &mut Pdf) -> (u32, u16) {
    let p = pages::flatten(pdf).unwrap()[0].id;
    let mut d = pdf.get_dict(p).unwrap().clone();
    d.set("Rotate", Object::Integer(90));
    pdf.set(p, Object::Dictionary(d));
    p
}

#[test]
fn incremental_update_appends_only_changed_objects_table() {
    let orig = sample_pdf(3, &SampleOptions::default()).unwrap();
    let mut pdf = Pdf::open(orig.clone(), None).unwrap();
    assert_eq!(pdf.xref_kind(), XrefKind::Table);
    let id_before = pdf.trailer().get(b"ID").unwrap().as_array().unwrap()[0].clone();
    let page = rotate_first(&mut pdf);
    let out = pdf.commit().unwrap();
    assert_eq!(
        &out[..orig.len()],
        &orig[..],
        "original bytes must be an exact prefix"
    );
    let appended = &out[orig.len()..];
    assert_eq!(
        count_objs(appended),
        1,
        "{}",
        String::from_utf8_lossy(appended)
    );
    assert!(appended.starts_with(format!("{} {} obj", page.0, page.1).as_bytes()));
    assert!(contains(appended, b"\nxref\n"));
    let startxref = revisions::revisions(&orig, &Limits::default())[0]
        .startxref
        .unwrap();
    assert!(contains(appended, format!("/Prev {startxref}").as_bytes()));
    // lopdf (independent reader) sees the change, keeps ID[0].
    let doc = lopdf::Document::load_mem(&out).unwrap();
    assert_eq!(
        doc.get_dictionary(page)
            .unwrap()
            .get(b"Rotate")
            .unwrap()
            .as_i64()
            .unwrap(),
        90
    );
    assert_eq!(
        doc.trailer.get(b"ID").unwrap().as_array().unwrap()[0],
        id_before
    );
    assert_eq!(pages::flatten(&pdf).unwrap()[0].rotate, 90);
    assert_eq!(revisions::revisions(&out, &Limits::default()).len(), 2);
}

#[test]
fn incremental_update_uses_xref_stream_when_original_does() {
    let orig = sample_pdf(
        2,
        &SampleOptions {
            xref_stream: true,
            compress: true,
            ..Default::default()
        },
    )
    .unwrap();
    let mut pdf = Pdf::open(orig.clone(), None).unwrap();
    assert_eq!(pdf.xref_kind(), XrefKind::Stream);
    let page = rotate_first(&mut pdf);
    let out = pdf.commit().unwrap();
    assert_eq!(&out[..orig.len()], &orig[..]);
    let appended = &out[orig.len()..];
    assert!(contains(appended, b"/Type /XRef"));
    assert!(!contains(appended, b"\nxref\n"));
    assert_eq!(count_objs(appended), 2, "page + xref stream");
    let doc = lopdf::Document::load_mem(&out).unwrap();
    assert_eq!(
        doc.get_dictionary(page)
            .unwrap()
            .get(b"Rotate")
            .unwrap()
            .as_i64()
            .unwrap(),
        90
    );
    assert_eq!(pdf.xref_kind(), XrefKind::Stream);
}

#[test]
fn third_party_objstm_file_incremental() {
    let orig = fixture("plain_objstm.pdf");
    let mut pdf = Pdf::open(orig.clone(), None).unwrap();
    assert_eq!(pdf.xref_kind(), XrefKind::Stream);
    rotate_first(&mut pdf);
    let out = pdf.commit().unwrap();
    assert_eq!(&out[..orig.len()], &orig[..]);
    assert!(page_text(&pdf, 0).contains("Hello ZOOD"));
    assert_eq!(pages::flatten(&pdf).unwrap()[0].rotate, 90);
    let script = r#"
import sys, pypdf
r = pypdf.PdfReader(sys.argv[1], strict=True)
print(len(r.pages), r.pages[0].get("/Rotate"))
"#;
    if let Some(o) = python(script, &out) {
        assert_eq!(o.trim(), "2 90");
    }
}

#[test]
fn deleted_objects_become_free_entries() {
    let orig = sample_pdf(
        1,
        &SampleOptions {
            with_annotation: true,
            ..Default::default()
        },
    )
    .unwrap();
    let mut pdf = Pdf::open(orig.clone(), None).unwrap();
    let page = pages::flatten(&pdf).unwrap()[0].id;
    let mut d = pdf.get_dict(page).unwrap().clone();
    let annot = d.get(b"Annots").unwrap().as_array().unwrap()[0]
        .as_reference()
        .unwrap();
    d.remove(b"Annots");
    pdf.set(page, Object::Dictionary(d));
    pdf.delete(annot);
    let out = pdf.commit().unwrap();
    assert!(contains(
        &out[orig.len()..],
        format!("{:010} {:05} f", 0, annot.1 + 1).as_bytes()
    ));
    assert!(pdf.get(annot).is_none());
    // (Plain lopdf ignores free entries and would resurrect the object; our loader walks
    // the xref chain itself — that is what this reopen proves.)
    let re = Pdf::open(out, None).unwrap();
    assert!(re.get(annot).is_none());
}

#[test]
fn broken_xref_is_reconstructed_and_saved_with_a_complete_table() {
    let orig = sample_pdf(2, &SampleOptions::default()).unwrap();
    // Point startxref at garbage.
    let pos = orig.windows(9).rposition(|w| w == b"startxref").unwrap();
    let mut broken = orig[..pos].to_vec();
    broken.extend_from_slice(b"startxref\n12\n%%EOF\n");
    let mut pdf = Pdf::open(broken.clone(), None).unwrap();
    assert!(pdf.was_repaired());
    assert_eq!(pages::count(&pdf).unwrap(), 2);
    rotate_first(&mut pdf);
    let out = pdf.commit().unwrap();
    assert_eq!(&out[..broken.len()], &broken[..]);
    assert!(!contains(&out[broken.len()..], b"/Prev"));
    let doc = lopdf::Document::load_mem(&out).unwrap();
    assert_eq!(doc.get_pages().len(), 2);
    assert!(
        !pdf.was_repaired(),
        "after the repair update the file has a valid xref"
    );
    assert_eq!(pages::flatten(&pdf).unwrap()[0].rotate, 90);
}

#[test]
fn truncated_file_and_leading_junk_still_load() {
    let orig = sample_pdf(2, &SampleOptions::default()).unwrap();
    let cut = &orig[..orig.len() - 40];
    let pdf = Pdf::open(cut.to_vec(), None).unwrap();
    assert_eq!(pages::count(&pdf).unwrap(), 2);
    let mut junk = b"GARBAGE HEADER\n".to_vec();
    junk.extend_from_slice(&orig);
    let mut pdf = Pdf::open(junk.clone(), None).unwrap();
    assert_eq!(pages::count(&pdf).unwrap(), 2);
    rotate_first(&mut pdf);
    let out = pdf.commit().unwrap();
    assert_eq!(&out[..junk.len()], &junk[..]);
}

#[test]
fn full_rewrite_collects_garbage_and_drops_revisions() {
    let orig = sample_pdf(2, &SampleOptions::default()).unwrap();
    let mut pdf = Pdf::open(orig, None).unwrap();
    let orphan = pdf.add(Object::string_literal("orphan secret"));
    rotate_first(&mut pdf);
    let inc = pdf.commit().unwrap();
    assert!(contains(&inc, b"orphan secret"));
    assert!(pdf.get(orphan).is_some());
    let full = pdf.write_full(Protection::Keep).unwrap();
    assert!(!contains(&full, b"orphan secret"));
    assert_eq!(revisions::revisions(&full, &Limits::default()).len(), 1);
    let re = Pdf::open(full, None).unwrap();
    assert_eq!(pages::flatten(&re).unwrap()[0].rotate, 90);
    assert!(page_text(&re, 1).contains("Page 2"));
}

#[test]
fn limits_are_enforced() {
    let orig = sample_pdf(3, &SampleOptions::default()).unwrap();
    let tiny = Limits {
        max_file_size: 100,
        ..Limits::default()
    };
    assert_eq!(
        Pdf::open_with_limits(orig.clone(), None, tiny)
            .unwrap_err()
            .code(),
        "limit_exceeded"
    );
    let few = Limits {
        max_objects: 3,
        ..Limits::default()
    };
    assert_eq!(
        Pdf::open_with_limits(orig.clone(), None, few)
            .unwrap_err()
            .code(),
        "limit_exceeded"
    );
    let pages_cap = Limits {
        max_pages: 2,
        ..Limits::default()
    };
    let pdf = Pdf::open_with_limits(orig, None, pages_cap).unwrap();
    assert_eq!(pages::count(&pdf).unwrap_err().code(), "limit_exceeded");
    assert_eq!(
        Pdf::open(b"not a pdf".to_vec(), None).unwrap_err().code(),
        "parse_error"
    );
}

#[test]
fn self_referencing_page_tree_does_not_loop() {
    // Kids pointing back at the root: flatten must terminate.
    let orig = sample_pdf(1, &SampleOptions::default()).unwrap();
    let mut pdf = Pdf::open(orig, None).unwrap();
    let root = pages::pages_root(&pdf).unwrap();
    let mut d = pdf.get_dict(root).unwrap().clone();
    let mut kids = d.get(b"Kids").unwrap().as_array().unwrap().clone();
    kids.push(Object::Reference(root));
    d.set("Kids", Object::Array(kids));
    pdf.set(root, Object::Dictionary(d));
    let out = pdf.commit().unwrap();
    let re = Pdf::open(out, None).unwrap();
    assert_eq!(pages::count(&re).unwrap(), 1);
}
