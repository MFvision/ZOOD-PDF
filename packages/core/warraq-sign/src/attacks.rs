//! Files built to deceive a verifier, and certificates that must not pass as
//! a document signer — each after a published attack on PDF signatures
//! (Mladenov et al., "1 Trillion Dollar Refund", CCS 2019; Mainka et al.,
//! "Shadow Attacks", NDSS 2021, and "Breaking the Specification: PDF
//! Certification", S&P 2021) or a review of this verifier. Every file here
//! is one a verifier must NOT report as "valid".
//!
//! The hostile certificates are in `tests/fixtures/signatures/hostile`
//! (`make.sh` there): a root of their own, a web-server CA and certificate
//! (what anyone gets for a domain), a document-signing CA and signer, a key
//! that may only encrypt, a CA below a `pathlen:0` CA, and a certificate
//! "issued" by the web-server certificate in a ministry's name.
use lopdf::{dictionary, Dictionary, Object, ObjectId, Stream};
use warraq_pdf::PdfDocument;

use crate::chain::{Anchor, Cert, Trust, TrustStore};
use crate::pades::{self, Report, SignOptions, SignatureReport};
use crate::tests::{corpus, fill_first_text_field, fixture, options, sign_with, trusting, NOW};

const INVOICE: &str = "generated/chrome-cairo-mixed-invoice.pdf";
const FORM: &str = "generated/acroform-pdflib-arabic-fields.pdf";

fn hostile(name: &str) -> Vec<u8> {
    fixture(&format!("hostile/{name}"))
}

/// The hostile root as Mozilla's roots are held: a name and a key, trusted
/// for web sites, not chosen by the person.
fn as_web_root(store: &mut TrustStore) {
    let root = Cert::parse(&hostile("hostile-root.cer")).unwrap();
    store
        .anchors
        .push(Anchor::web_root(root.subject.clone(), root.spki.clone()));
}

fn web_store() -> TrustStore {
    let mut store = TrustStore::mozilla();
    as_web_root(&mut store);
    store
}

fn user_store() -> TrustStore {
    let mut store = TrustStore::mozilla();
    store.add_user(&hostile("hostile-root.cer")).unwrap();
    store
}

fn check(bytes: &[u8], store: &TrustStore) -> Report {
    pades::verify(bytes, None, store, NOW + 60).unwrap()
}

fn has(s: &SignatureReport, problem: &str) -> bool {
    s.problems
        .iter()
        .any(|p| p == problem || p.starts_with(&format!("{problem}:")))
}

fn change<'a>(s: &'a SignatureReport, kind: &str) -> Option<&'a pades::ChangeReport> {
    s.changes.iter().find(|c| c.kind == kind)
}

// ------------------------------------------------------------------- trust

#[test]
fn a_web_server_certificate_is_not_a_trusted_document_signer() {
    let signed = sign_with(
        corpus(INVOICE),
        None,
        "hostile/web-server.p12",
        &options(false),
    );
    // Under a root trusted for web sites, as Mozilla's are.
    let s = &check(&signed, &web_store()).signatures[0];
    assert_eq!(s.status, "untrusted", "{:?}", s.problems);
    assert!(has(s, "eku"), "{:?}", s.problems);
    // Under a root the person trusts, a certificate for web servers is still
    // not one for signing documents.
    let s = &check(&signed, &user_store()).signatures[0];
    assert_eq!(s.status, "untrusted", "{:?}", s.problems);
    assert!(has(s, "eku"), "{:?}", s.problems);
    // Trusting that very certificate is the person's explicit choice.
    let mut store = user_store();
    store.add_user(&hostile("web-server.cer")).unwrap();
    let s = &check(&signed, &store).signatures[0];
    assert_eq!(s.status, "valid", "{:?}", s.problems);
}

#[test]
fn a_certificate_issued_by_a_web_server_certificate_is_invalid() {
    let signed = sign_with(corpus(INVOICE), None, "hostile/forged.p12", &options(false));
    for store in [web_store(), user_store()] {
        let s = &check(&signed, &store).signatures[0];
        assert_eq!(s.status, "invalid", "{:?}", s.problems);
        assert!(has(s, "notCa"), "{:?}", s.problems);
        let chain = s.chain.as_ref().unwrap();
        assert!(
            matches!(chain.trust, Trust::Broken { .. }),
            "{:?}",
            chain.trust
        );
    }
}

#[test]
fn mozillas_roots_do_not_vouch_for_who_signs_a_document() {
    let signed = sign_with(
        corpus(INVOICE),
        None,
        "hostile/docs-signer.p12",
        &options(false),
    );
    let s = &check(&signed, &web_store()).signatures[0];
    assert_eq!(s.status, "untrusted", "{:?}", s.problems);
    let chain = s.chain.as_ref().unwrap();
    assert_eq!(
        chain.trust,
        Trust::WebRoot {
            anchor: "Warraq TEST Hostile Root".into()
        }
    );
    assert!(s.trust_candidate.is_some(), "the person may trust it");
    // The same signer under a root the person trusts for documents.
    let s = &check(&signed, &user_store()).signatures[0];
    assert_eq!(s.status, "valid", "{:?}", s.problems);
}

#[test]
fn a_key_that_may_not_sign_or_a_path_too_long_is_invalid() {
    let signed = sign_with(
        corpus(INVOICE),
        None,
        "hostile/keyenc-signer.p12",
        &options(false),
    );
    let s = &check(&signed, &user_store()).signatures[0];
    assert_eq!(s.status, "invalid", "{:?}", s.problems);
    assert!(has(s, "keyUsage"), "{:?}", s.problems);

    let signed = sign_with(
        corpus(INVOICE),
        None,
        "hostile/nested-signer.p12",
        &options(false),
    );
    let s = &check(&signed, &user_store()).signatures[0];
    assert_eq!(s.status, "invalid", "{:?}", s.problems);
    assert!(has(s, "pathLen"), "{:?}", s.problems);
}

// ------------------------------------------------------ who, and which dict

#[test]
fn the_signer_is_named_by_the_certificate_not_by_the_file() {
    let o = SignOptions {
        name: Some("وزارة العدل".into()),
        ..options(false)
    };
    let signed = sign_with(corpus(INVOICE), None, "signer-rsa-legacy.p12", &o);
    let s = &trusting_rsa(&signed).signatures[0];
    assert_eq!(s.signed_by, "محمد التجريبي (TEST)");
    assert_eq!(s.claimed_name.as_deref(), Some("وزارة العدل"));
}

fn trusting_rsa(bytes: &[u8]) -> Report {
    check(bytes, &trusting(&["root-rsa.cer"]))
}

/// The signature field's object and its signature dictionary's.
fn signature_objects(doc: &PdfDocument) -> (ObjectId, ObjectId) {
    let f = doc.signature_fields().remove(0);
    (f.field, f.value.and_then(|v| v.id).unwrap())
}

#[test]
fn a_dictionary_borrowing_another_signatures_byte_range_is_invalid() {
    let signed = sign_with(
        corpus(INVOICE),
        None,
        "signer-rsa-legacy.p12",
        &options(true),
    );
    // A copy of the signature dictionary, under a name, reason and time of
    // the attacker's choosing, keeping the genuine /ByteRange.
    let copy = |doc: &mut PdfDocument| -> ObjectId {
        let (_, sig) = signature_objects(doc);
        let mut d = doc.doc_ref().get_dictionary(sig).unwrap().clone();
        d.set("Name", Object::string_literal("Ministry of Justice"));
        d.set("Reason", Object::string_literal("Approved: 10,000,000"));
        // A time inside the certificate's validity, so only the borrowing is wrong.
        d.set("M", Object::string_literal("D:20260919180000Z"));
        doc.doc_mut().add_object(d)
    };

    // (1) In a new field of its own.
    let mut doc = PdfDocument::open(signed.clone(), None).unwrap();
    let b = copy(&mut doc);
    let page = doc.page_id(0).unwrap();
    let field = doc.doc_mut().add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Widget", "FT" => "Sig", "T" => Object::string_literal("Signature2"),
        "Rect" => vec![0.into(), 0.into(), 0.into(), 0.into()], "P" => page, "V" => b,
    });
    push_to_fields(&mut doc, field);
    let attacked = doc.save_incremental().unwrap();
    let r = trusting_rsa(&attacked);
    let forged = r
        .signatures
        .iter()
        .find(|s| s.field == "Signature2")
        .expect("listed");
    assert_eq!(forged.status, "invalid", "{:?}", forged.problems);
    assert!(has(forged, "notInRevision"), "{:?}", forged.problems);

    // (2) The genuine field re-pointed at it.
    let mut doc = PdfDocument::open(signed, None).unwrap();
    let b = copy(&mut doc);
    let (f, _) = signature_objects(&doc);
    doc.doc_mut()
        .get_dictionary_mut(f)
        .unwrap()
        .set("V", Object::Reference(b));
    doc.mark_touched(f);
    let attacked = doc.save_incremental().unwrap();
    let r = trusting_rsa(&attacked);
    assert_eq!(r.signatures.len(), 1);
    assert_eq!(r.signatures[0].status, "invalid", "{:?}", r.signatures[0]);
}

/// Adds `field` to the form's `/Fields`, wherever that array is kept.
fn push_to_fields(doc: &mut PdfDocument, field: ObjectId) {
    let root = doc
        .doc_ref()
        .trailer
        .get(b"Root")
        .unwrap()
        .as_reference()
        .unwrap();
    let form = doc
        .doc_ref()
        .get_dictionary(root)
        .unwrap()
        .get(b"AcroForm")
        .unwrap()
        .as_reference()
        .unwrap();
    let fields = doc
        .doc_ref()
        .get_dictionary(form)
        .unwrap()
        .get(b"Fields")
        .unwrap()
        .clone();
    match fields {
        Object::Reference(array) => {
            doc.doc_mut()
                .get_object_mut(array)
                .unwrap()
                .as_array_mut()
                .unwrap()
                .push(Object::Reference(field));
            doc.mark_touched(array);
        }
        Object::Array(mut items) => {
            items.push(Object::Reference(field));
            doc.doc_mut()
                .get_dictionary_mut(form)
                .unwrap()
                .set("Fields", items);
            doc.mark_touched(form);
        }
        other => panic!("fields: {other:?}"),
    }
}

/// Adds `annot` to the first page's `/Annots`.
fn push_to_page(doc: &mut PdfDocument, annot: ObjectId) {
    let page = doc.page_id(0).unwrap();
    let annots = doc
        .doc_ref()
        .get_dictionary(page)
        .unwrap()
        .get(b"Annots")
        .ok()
        .cloned();
    match annots {
        Some(Object::Reference(array)) => {
            doc.doc_mut()
                .get_object_mut(array)
                .unwrap()
                .as_array_mut()
                .unwrap()
                .push(Object::Reference(annot));
            doc.mark_touched(array);
        }
        Some(Object::Array(mut items)) => {
            items.push(Object::Reference(annot));
            doc.doc_mut()
                .get_dictionary_mut(page)
                .unwrap()
                .set("Annots", items);
            doc.mark_touched(page);
        }
        _ => {
            doc.doc_mut()
                .get_dictionary_mut(page)
                .unwrap()
                .set("Annots", vec![Object::Reference(annot)]);
            doc.mark_touched(page);
        }
    }
}

/// An opaque box over most of the page: what an overlay shows.
fn overlay(doc: &mut PdfDocument) -> ObjectId {
    doc.doc_mut().add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), 400.into(), 300.into()],
        },
        b"q 1 1 1 rg 0 0 400 300 re f 0 0 0 rg 20 20 360 260 re S Q".to_vec(),
    ))
}

fn rect() -> Vec<Object> {
    vec![100.into(), 300.into(), 500.into(), 600.into()]
}

fn certify(pdf: Vec<u8>, p: u8, visible: bool) -> Vec<u8> {
    sign_with(
        pdf,
        None,
        "signer-rsa-legacy.p12",
        &SignOptions {
            certify: Some(p),
            ..options(visible)
        },
    )
}

// ------------------------------------------------------------ shadow attacks

/// The file the victim signs, prepared by the attacker: a second catalog and
/// page tree (with other content) that nothing refers to yet.
fn with_shadow_document(pdf: Vec<u8>) -> (Vec<u8>, ObjectId) {
    let mut doc = PdfDocument::open(pdf, None).unwrap();
    let root = doc
        .doc_ref()
        .trailer
        .get(b"Root")
        .unwrap()
        .as_reference()
        .unwrap();
    let page_id = doc.page_id(0).unwrap();
    let mut page = doc.doc_ref().get_dictionary(page_id).unwrap().clone();
    let content = doc.doc_mut().add_object(Stream::new(
        Dictionary::new(),
        b"q 0.8 0 0 rg 72 500 300 120 re f Q".to_vec(),
    ));
    let pages = doc.doc_mut().add_object(dictionary! {
        "Type" => "Pages", "Kids" => Vec::<Object>::new(), "Count" => 1,
    });
    page.set("Contents", content);
    page.set("Parent", pages);
    page.remove(b"Annots");
    let shadow_page = doc.doc_mut().add_object(page);
    doc.doc_mut()
        .get_dictionary_mut(pages)
        .unwrap()
        .set("Kids", vec![Object::Reference(shadow_page)]);
    let mut catalog = doc.doc_ref().get_dictionary(root).unwrap().clone();
    catalog.set("Pages", pages);
    let shadow_root = doc.doc_mut().add_object(catalog);
    (doc.save_incremental().unwrap(), shadow_root)
}

#[test]
fn a_catalog_hidden_before_signing_and_swapped_in_after_is_a_change() {
    let (prepared, shadow) = with_shadow_document(corpus(FORM));
    for p in [None, Some(1u8)] {
        let signed = match p {
            Some(p) => certify(prepared.clone(), p, false),
            None => sign_with(
                prepared.clone(),
                None,
                "signer-rsa-legacy.p12",
                &options(false),
            ),
        };
        let mut doc = PdfDocument::open(signed, None).unwrap();
        doc.doc_mut().trailer.set("Root", Object::Reference(shadow));
        doc.mark_touched(shadow);
        let attacked = doc.save_incremental().unwrap();
        let r = trusting_rsa(&attacked);
        assert_eq!(r.signatures.len(), 1, "the signature is still found");
        let s = &r.signatures[0];
        assert_eq!(s.status, "modified", "{p:?}: {:?}", s.changes);
        assert!(
            change(s, "document").is_some_and(|c| !c.allowed),
            "{p:?}: {:?}",
            s.changes
        );
        if p.is_some() {
            assert_eq!(r.certified, p, "the certification is not lost");
        }
    }
}

#[test]
fn an_annotation_hidden_before_signing_and_shown_after_is_a_change() {
    let mut doc = PdfDocument::open(corpus(FORM), None).unwrap();
    let ap = overlay(&mut doc);
    let annot = doc.doc_mut().add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Square", "Rect" => rect(), "F" => 4,
        "AP" => dictionary! { "N" => ap },
    });
    let prepared = doc.save_incremental().unwrap();
    let signed = certify(prepared, 2, false);
    let mut doc = PdfDocument::open(signed, None).unwrap();
    push_to_page(&mut doc, annot);
    let attacked = doc.save_incremental().unwrap();
    let s = &trusting_rsa(&attacked).signatures[0];
    assert_eq!(s.status, "modified", "{:?}", s.changes);
    assert!(
        change(s, "comments").is_some_and(|c| !c.allowed),
        "{:?}",
        s.changes
    );
}

// ------------------------------------------- overlays on a certified document

#[test]
fn a_new_signature_widget_over_a_no_changes_certification_is_a_change() {
    // The "sneaky signature": a signature field nobody signed, drawn over
    // the page, left out of the form.
    let signed = certify(corpus(INVOICE), 1, false);
    let mut doc = PdfDocument::open(signed, None).unwrap();
    let ap = overlay(&mut doc);
    let page = doc.page_id(0).unwrap();
    let widget = doc.doc_mut().add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Widget", "FT" => "Sig", "T" => Object::string_literal("Overlay"),
        "Rect" => rect(), "F" => 4, "P" => page, "AP" => dictionary! { "N" => ap },
    });
    push_to_page(&mut doc, widget);
    let attacked = doc.save_incremental().unwrap();
    let s = &trusting_rsa(&attacked).signatures[0];
    assert_eq!(s.status, "modified", "{:?}", s.changes);
}

#[test]
fn a_new_text_field_over_a_forms_only_certification_is_a_change() {
    // The "evil annotation": a new form field, drawn over the page, is not
    // the filling in of a form.
    let signed = certify(corpus(FORM), 2, false);
    let mut doc = PdfDocument::open(signed, None).unwrap();
    let ap = overlay(&mut doc);
    let page = doc.page_id(0).unwrap();
    let widget = doc.doc_mut().add_object(dictionary! {
        "Type" => "Annot", "Subtype" => "Widget", "FT" => "Tx", "T" => Object::string_literal("Overlay"),
        "V" => Object::string_literal("PAID"), "Rect" => rect(), "F" => 4, "P" => page,
        "AP" => dictionary! { "N" => ap },
    });
    push_to_page(&mut doc, widget);
    push_to_fields(&mut doc, widget);
    let attacked = doc.save_incremental().unwrap();
    let s = &trusting_rsa(&attacked).signatures[0];
    assert_eq!(s.status, "modified", "{:?}", s.changes);

    // Filling in a field that was there is what P=2 permits.
    let filled = fill_first_text_field(certify(corpus(FORM), 2, false), "قيمة");
    let s = &trusting_rsa(&filled).signatures[0];
    assert_eq!(s.status, "valid", "{:?}", s.changes);
}

#[test]
fn a_signatures_own_appearance_cannot_be_redrawn() {
    for p in [1u8, 2] {
        let signed = certify(corpus(INVOICE), p, true);
        let mut doc = PdfDocument::open(signed, None).unwrap();
        let widget = doc.signature_fields()[0].widget.unwrap();
        let ap = doc
            .doc_ref()
            .get_dictionary(widget)
            .unwrap()
            .get(b"AP")
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"N")
            .unwrap()
            .as_reference()
            .unwrap();
        let stream = doc
            .doc_mut()
            .get_object_mut(ap)
            .unwrap()
            .as_stream_mut()
            .unwrap();
        stream.set_plain_content(b"q 1 0 0 rg 0 0 100 30 re f Q".to_vec());
        doc.mark_touched(ap);
        let attacked = doc.save_incremental().unwrap();
        let s = &trusting_rsa(&attacked).signatures[0];
        assert_eq!(s.status, "modified", "P={p}: {:?}", s.changes);
        assert!(change(s, "signatureAltered").is_some(), "{:?}", s.changes);
    }
}

#[test]
fn a_document_timestamp_after_a_no_changes_certification_is_permitted() {
    let signed = certify(corpus(INVOICE), 1, false);
    let mut doc = PdfDocument::open(signed, None).unwrap();
    let (prepared, request) = pades::prepare_doc_timestamp(&mut doc).unwrap();
    let stamped = pades::finish_doc_timestamp(
        prepared,
        &request,
        &crate::tsp::tests::answer(&request, NOW + 30),
    )
    .unwrap();
    let r = trusting_rsa(&stamped);
    assert_eq!(r.signatures.len(), 2);
    assert_eq!(
        r.signatures[0].status, "valid",
        "{:?}",
        r.signatures[0].changes
    );
    assert_eq!(r.signatures[1].kind, "timestamp");
}
