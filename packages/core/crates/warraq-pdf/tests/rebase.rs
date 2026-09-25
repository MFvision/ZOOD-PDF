#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod common;
use common::*;
use warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_pdf::lopdf::{self, Document, Object, ObjectId};
use warraq_pdf::rebase::{rebase, rebase_pdf, RebaseMode};
use warraq_pdf::{pages, revisions, Limits, Pdf, PermissionFlags, Protection, SecurityHandler};

fn original() -> Vec<u8> {
    sample_pdf(
        3,
        &SampleOptions {
            with_annotation: true,
            compress: true,
            title: Some("T".into()),
            ..Default::default()
        },
    )
    .unwrap()
}

fn annot_id(doc: &Document) -> ObjectId {
    let page = doc.page_iter().next().unwrap();
    doc.get_dictionary(page)
        .unwrap()
        .get(b"Annots")
        .unwrap()
        .as_array()
        .unwrap()[0]
        .as_reference()
        .unwrap()
}

/// Simulate PDFium: load everything, change something, write the WHOLE file again.
fn full_rewrite(bytes: &[u8], edit: impl FnOnce(&mut Document)) -> Vec<u8> {
    let mut doc = Document::load_mem(bytes).unwrap();
    edit(&mut doc);
    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

fn appended_ids(orig_len: usize, out: &[u8]) -> Vec<u32> {
    let tail = &out[orig_len..];
    let s = String::from_utf8_lossy(tail);
    let mut ids = Vec::new();
    for line in s.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() == 3 && parts[2] == "obj" {
            ids.push(parts[0].parse().unwrap());
        }
    }
    ids
}

#[test]
fn modified_annotation_is_the_only_appended_object() {
    let orig = original();
    let annot = annot_id(&Document::load_mem(&orig).unwrap());
    // PDFium also recompresses streams differently: decompress them all in the rewrite.
    let edited = full_rewrite(&orig, |d| {
        d.decompress();
        d.get_dictionary_mut(annot)
            .unwrap()
            .set("Contents", Object::string_literal("edited note"));
    });
    assert_ne!(edited, orig);
    let out = rebase(&orig, &edited).unwrap();
    assert_eq!(
        &out[..orig.len()],
        &orig[..],
        "original bytes are an exact prefix"
    );
    assert_eq!(
        appended_ids(orig.len(), &out),
        vec![annot.0],
        "only the annotation is appended"
    );
    let doc = Document::load_mem(&out).unwrap();
    assert_eq!(
        doc.get_dictionary(annot)
            .unwrap()
            .get(b"Contents")
            .unwrap()
            .as_str()
            .unwrap(),
        b"edited note"
    );
    assert_eq!(doc.get_pages().len(), 3);
    assert_eq!(revisions::revisions(&out, &Limits::default()).len(), 2);
}

#[test]
fn added_and_removed_annotations() {
    let orig = original();
    let base = Document::load_mem(&orig).unwrap();
    let annot = annot_id(&base);
    let page = base.page_iter().next().unwrap();
    // Add a new annotation on page 1 and delete the old one.
    let edited = full_rewrite(&orig, |d| {
        let mut a = lopdf::Dictionary::new();
        a.set("Type", Object::Name(b"Annot".to_vec()));
        a.set("Subtype", Object::Name(b"Square".to_vec()));
        a.set(
            "Rect",
            Object::Array(vec![1.into(), 1.into(), 50.into(), 50.into()]),
        );
        let new = d.add_object(Object::Dictionary(a));
        d.get_dictionary_mut(page)
            .unwrap()
            .set("Annots", Object::Array(vec![Object::Reference(new)]));
        d.objects.remove(&annot);
    });
    let orig_pdf = Pdf::open(orig.clone(), None).unwrap();
    let rep = rebase_pdf(&orig_pdf, &edited).unwrap();
    assert_eq!(rep.mode, RebaseMode::Incremental);
    assert!(!rep.renumbered);
    assert_eq!(rep.changed, vec![page]);
    assert_eq!(rep.added.len(), 1);
    assert_eq!(rep.deleted, vec![annot]);
    let out = rep.bytes;
    assert_eq!(&out[..orig.len()], &orig[..]);
    let re = Pdf::open(out, None).unwrap();
    assert!(re.get(annot).is_none(), "freed");
    assert!(re.get(rep.added[0]).is_some());
    assert!(page_text(&re, 0).contains("Page 1"));
}

#[test]
fn unchanged_rewrite_returns_original_bytes() {
    let orig = original();
    let edited = full_rewrite(&orig, |d| {
        d.decompress();
    });
    let rep = rebase_pdf(&Pdf::open(orig.clone(), None).unwrap(), &edited).unwrap();
    assert_eq!(rep.mode, RebaseMode::Unchanged);
    assert_eq!(rep.bytes, orig);
}

#[test]
fn renumbered_rewrite_falls_back_to_appending_everything() {
    let orig = original();
    let edited = full_rewrite(&orig, |d| {
        // Shift every object number (PDFium's renumbering pitfall).
        d.renumber_objects_with(100);
    });
    let rep = rebase_pdf(&Pdf::open(orig.clone(), None).unwrap(), &edited).unwrap();
    assert!(rep.renumbered);
    assert_eq!(&rep.bytes[..orig.len()], &orig[..]);
    let re = Pdf::open(rep.bytes, None).unwrap();
    assert_eq!(pages::count(&re).unwrap(), 3);
    assert!(page_text(&re, 2).contains("Page 3"));
}

#[test]
fn earlier_revisions_and_signature_bytes_survive() {
    // Original already has an incremental revision (as a signed file would).
    let mut p = Pdf::open(original(), None).unwrap();
    pages::rotate(&mut p, &[1], 90).unwrap();
    let signed_like = p.commit().unwrap();
    let annot = annot_id(&Document::load_mem(&signed_like).unwrap());
    let edited = full_rewrite(&signed_like, |d| {
        d.get_dictionary_mut(annot)
            .unwrap()
            .set("Contents", Object::string_literal("x"));
    });
    let out = rebase(&signed_like, &edited).unwrap();
    assert_eq!(&out[..signed_like.len()], &signed_like[..]);
    assert_eq!(revisions::revisions(&out, &Limits::default()).len(), 3);
    let first = revisions::revision_bytes(&out, 0, &Limits::default()).unwrap();
    assert_eq!(first, &signed_like[..first.len()]);
}

#[test]
fn encrypted_original_decrypted_edit_is_reencrypted_with_original_key() {
    let orig = fixture("qpdf_r6.pdf");
    let orig_pdf = Pdf::open(orig.clone(), Some("owner")).unwrap();
    // PDFium-style decrypted full save with the same object numbers.
    let mut doc = orig_pdf.document().clone();
    let info = doc.trailer.get(b"Info").unwrap().as_reference().unwrap();
    doc.get_dictionary_mut(info)
        .unwrap()
        .set("Title", Object::string_literal("Edited Secret Title"));
    let mut edited = Vec::new();
    doc.save_to(&mut edited).unwrap();
    assert!(
        Pdf::open(edited.clone(), None).is_ok(),
        "edited copy is unencrypted"
    );

    let rep = rebase_pdf(&orig_pdf, &edited).unwrap();
    assert_eq!(rep.mode, RebaseMode::Incremental);
    assert_eq!(rep.changed, vec![info]);
    assert_eq!(&rep.bytes[..orig.len()], &orig[..]);
    assert!(
        !contains(&rep.bytes[orig.len()..], b"Edited Secret"),
        "appended objects are encrypted"
    );
    let re = Pdf::open(rep.bytes.clone(), Some("user")).unwrap();
    assert!(re
        .security()
        .unwrap()
        .same_key(orig_pdf.security().unwrap()));
    assert_eq!(title(&re).as_deref(), Some("Edited Secret Title"));
    assert!(matches!(
        Pdf::open(rep.bytes, None),
        Err(warraq_pdf::PdfError::PasswordRequired)
    ));
}

#[test]
fn protection_changed_in_editor_returns_edited_bytes() {
    let orig = original();
    let p = Pdf::open(orig, None).unwrap();
    let h = SecurityHandler::new_aes256("a", "b", &PermissionFlags::all()).unwrap();
    let edited = p.write_full(Protection::New(h)).unwrap();
    let rep = rebase_pdf(&p, &edited).unwrap();
    assert_eq!(rep.mode, RebaseMode::ProtectionChanged);
    assert_eq!(rep.bytes, edited);
}

#[test]
fn garbage_edited_input_is_an_error_not_a_panic() {
    let orig = original();
    assert!(rebase(&orig, b"%PDF-1.7 garbage").is_err());
    assert!(rebase(&orig, b"").is_err());
}
