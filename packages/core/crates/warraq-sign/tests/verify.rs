#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod common;
use common::*;
use lopdf::{dictionary, Object, Stream};
use warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_pdf::{Pdf, PermissionFlags, SecurityHandler};
use warraq_sign::sign::{sign, sign_unchecked, FieldLock, LockAction, SignOptions};
use warraq_sign::verify::{verify, Report, VerifyOptions};
use warraq_sign::x509::Cert;
use warraq_sign::SoftwareSigner;

const NOW: i64 = 1_790_358_029;

fn signer(name: &str) -> SoftwareSigner {
    SoftwareSigner::from_pkcs12(&read_pki(name), PW).unwrap()
}

fn opts() -> VerifyOptions {
    VerifyOptions {
        trusted_roots: vec![],
        now: NOW,
    }
}

fn trusting() -> VerifyOptions {
    VerifyOptions {
        trusted_roots: Cert::from_pem_or_der(&read_pki("root.pem")).unwrap(),
        now: NOW,
    }
}

fn check(bytes: &[u8], pw: Option<&str>, o: &VerifyOptions) -> Vec<Report> {
    verify(&Pdf::open(bytes.to_vec(), pw).unwrap(), o).unwrap()
}

fn signed(doc: Vec<u8>, p12: &str, o: SignOptions) -> Vec<u8> {
    let pdf = Pdf::open(doc, None).unwrap();
    sign(&pdf, &signer(p12), &SignOptions { time: NOW, ..o })
        .unwrap()
        .bytes
}

fn sample() -> Vec<u8> {
    sample_pdf(2, &SampleOptions::default()).unwrap()
}

fn kinds(r: &Report) -> Vec<&'static str> {
    r.modifications.iter().map(|m| m.kind).collect()
}

fn attack_kinds(r: &Report) -> Vec<&'static str> {
    r.attacks.iter().map(|a| a.kind).collect()
}

/// Append an incremental update made through warraq-pdf's writer.
fn update(bytes: &[u8], f: impl FnOnce(&mut Pdf)) -> Vec<u8> {
    let mut pdf = Pdf::open(bytes.to_vec(), None).unwrap();
    f(&mut pdf);
    pdf.commit().unwrap()
}

/// Append an annotation reference to a page's /Annots (direct or indirect array).
fn append_annot(pdf: &mut Pdf, page: lopdf::ObjectId, aid: lopdf::ObjectId) {
    let mut pd = pdf.get_dict(page).unwrap().clone();
    match pd.get(b"Annots").ok().cloned() {
        Some(Object::Reference(r)) => {
            let mut arr = pdf.get(r).unwrap().as_array().unwrap().clone();
            arr.push(Object::Reference(aid));
            pdf.set(r, Object::Array(arr));
        }
        Some(Object::Array(mut a)) => {
            a.push(Object::Reference(aid));
            pd.set("Annots", a);
            pdf.set(page, Object::Dictionary(pd));
        }
        _ => {
            pd.set("Annots", vec![Object::Reference(aid)]);
            pdf.set(page, Object::Dictionary(pd));
        }
    }
}

fn first_page(pdf: &Pdf) -> lopdf::ObjectId {
    warraq_pdf::pages::flatten(pdf).unwrap()[0].id
}

#[test]
fn untrusted_by_default_valid_with_trusted_root() {
    let b = signed(sample(), "signer-rsa-modern.p12", SignOptions::default());
    let r = &check(&b, None, &opts())[0];
    assert_eq!(r.status, "valid_identity_unknown", "{r:#?}");
    assert!(r.integrity);
    assert!(r.covers_whole_document);
    assert_eq!(r.identity, "unknown");
    assert_eq!(r.signer.as_ref().unwrap().name, "Test Signer RSA");
    assert!(r.modifications.is_empty());
    assert!(r.attacks.is_empty(), "{:?}", r.attacks);
    let r = &check(&b, None, &trusting())[0];
    assert_eq!(r.status, "valid", "{r:#?}");
    assert_eq!(r.chain.len(), 3);
    assert_eq!(r.claimed_time.as_deref(), Some("2026-09-25T17:40:29Z"));
    // JSON shape.
    let j = serde_json::to_value(r).unwrap();
    assert_eq!(j["status"], "valid");
    assert!(j["modifications"].is_array());
}

#[test]
fn p256_p384_and_encrypted_documents_verify() {
    for p12 in [
        "signer-p256-modern.p12",
        "signer-p384-modern.p12",
        "signer-rsa-rc2.p12",
    ] {
        let b = signed(sample(), p12, SignOptions::default());
        let r = &check(&b, None, &trusting())[0];
        assert_eq!(r.status, "valid", "{p12}: {r:#?}");
    }
    let h = SecurityHandler::new_aes256("pw", "", &PermissionFlags::all()).unwrap();
    let doc = sample_pdf(
        1,
        &SampleOptions {
            security: Some(h),
            ..Default::default()
        },
    )
    .unwrap();
    let pdf = Pdf::open(doc, Some("pw")).unwrap();
    let b = sign(
        &pdf,
        &signer("signer-p256-modern.p12"),
        &SignOptions {
            time: NOW,
            reason: Some("سبب".into()),
            ..Default::default()
        },
    )
    .unwrap()
    .bytes;
    let r = &check(&b, Some("pw"), &trusting())[0];
    assert_eq!(r.status, "valid", "{r:#?}");
    assert_eq!(r.reason.as_deref(), Some("سبب"));
}

#[test]
fn tampered_bytes_are_invalid() {
    let b = signed(sample(), "signer-rsa-modern.p12", SignOptions::default());
    // Flip one byte inside the first signed range (in the page content "Page 1").
    let pos = b.windows(6).position(|w| w == b"Page 1").unwrap();
    let mut t = b.clone();
    t[pos + 5] = b'7';
    let r = &check(&t, None, &trusting())[0];
    assert_eq!(r.status, "invalid");
    assert!(
        r.reasons.iter().any(|n| n.code == "digest_mismatch"),
        "{:?}",
        r.reasons
    );
}

#[test]
fn eku_and_expiry_policies() {
    // serverAuth-only and expired certificates cannot sign through the API; fixtures made
    // with the unchecked path must verify as invalid.
    for (p12, code) in [
        ("signer-server.p12", "certificate_not_for_document_signing"),
        ("signer-expired.p12", "certificate_expired"),
    ] {
        let pdf = Pdf::open(sample(), None).unwrap();
        assert!(sign(
            &pdf,
            &signer(p12),
            &SignOptions {
                time: NOW,
                ..Default::default()
            }
        )
        .is_err());
        let b = sign_unchecked(
            &pdf,
            &signer(p12),
            &SignOptions {
                time: NOW,
                ..Default::default()
            },
        )
        .unwrap()
        .bytes;
        let r = &check(&b, None, &trusting())[0];
        assert_eq!(r.status, "invalid", "{p12}");
        assert!(r.integrity, "the bytes are intact");
        assert!(
            r.reasons.iter().any(|n| n.code == code),
            "{p12}: {:?}",
            r.reasons
        );
    }
    // P-384 cert with Adobe authentic documents + emailProtection is accepted.
    let b = signed(sample(), "signer-p384-modern.p12", SignOptions::default());
    assert_eq!(check(&b, None, &trusting())[0].status, "valid");
}

fn add_annotation(bytes: &[u8], with_ap: bool) -> Vec<u8> {
    update(bytes, |pdf| {
        let page = first_page(pdf);
        let mut a = dictionary! {
            "Type" => "Annot", "Subtype" => "Square",
            "Rect" => vec![60.into(), 590.into(), 300.into(), 720.into()],
            "P" => Object::Reference(page),
        };
        if with_ap {
            let ap = pdf.add(Object::Stream(Stream::new(
                dictionary! {"Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 240.into(), 130.into()]},
                b"1 1 1 rg 0 0 240 130 re f".to_vec(),
            )));
            a.set("AP", dictionary! {"N" => Object::Reference(ap)});
        }
        let aid = pdf.add(Object::Dictionary(a));
        append_annot(pdf, page, aid);
    })
}

#[test]
fn approval_signature_allows_annotations_but_flags_overlays() {
    let b = signed(sample(), "signer-rsa-modern.p12", SignOptions::default());
    let b2 = add_annotation(&b, true);
    let r = &check(&b2, None, &trusting())[0];
    assert!(!r.covers_whole_document);
    assert_eq!(r.status, "valid", "{r:#?}");
    assert!(kinds(r).contains(&"annotation_added"), "{:?}", kinds(r));
    assert!(
        r.modifications.iter().all(|m| m.allowed),
        "{:?}",
        r.modifications
    );
    assert!(attack_kinds(r).contains(&"overlay"), "{:?}", r.attacks);
}

#[test]
fn certified_no_changes_rejects_annotations() {
    let b = signed(
        sample(),
        "signer-rsa-modern.p12",
        SignOptions {
            certify: Some(1),
            ..Default::default()
        },
    );
    let b2 = add_annotation(&b, false);
    let r = &check(&b2, None, &trusting())[0];
    assert_eq!(r.kind, "certification");
    assert_eq!(r.certification, Some(1));
    assert_eq!(r.status, "modified", "{r:#?}");
    assert!(r
        .modifications
        .iter()
        .any(|m| m.kind == "annotation_added" && !m.allowed));
    // P=3 allows it.
    let b = signed(
        sample(),
        "signer-rsa-modern.p12",
        SignOptions {
            certify: Some(3),
            ..Default::default()
        },
    );
    let r = &check(&add_annotation(&b, false), None, &trusting())[0];
    assert_eq!(r.status, "valid", "{r:#?}");
}

fn with_text_field(name: &str) -> Vec<u8> {
    update(&sample(), |pdf| {
        let page = first_page(pdf);
        let fid = pdf.add(Object::Dictionary(dictionary! {
            "FT" => "Tx", "T" => Object::string_literal(name), "V" => Object::string_literal(""),
            "Type" => "Annot", "Subtype" => "Widget",
            "Rect" => vec![72.into(), 500.into(), 300.into(), 520.into()],
            "P" => Object::Reference(page),
        }));
        append_annot(pdf, page, fid);
        let root = pdf.root_id().unwrap();
        let mut cat = pdf.get_dict(root).unwrap().clone();
        cat.set(
            "AcroForm",
            dictionary! {"Fields" => vec![Object::Reference(fid)]},
        );
        pdf.set(root, Object::Dictionary(cat));
    })
}

fn fill(bytes: &[u8], name: &str, value: &str) -> Vec<u8> {
    update(bytes, |pdf| {
        let f = warraq_sign::pdfobj::fields(pdf)
            .into_iter()
            .find(|f| f.name == name)
            .unwrap();
        let mut d = pdf.get_dict(f.id).unwrap().clone();
        d.set("V", Object::string_literal(value));
        pdf.set(f.id, Object::Dictionary(d));
    })
}

#[test]
fn form_filling_under_docmdp_2_and_field_locks() {
    let doc = with_text_field("Name");
    let b = signed(
        doc.clone(),
        "signer-rsa-modern.p12",
        SignOptions {
            certify: Some(2),
            ..Default::default()
        },
    );
    let r = &check(&fill(&b, "Name", "Ali"), None, &trusting())[0];
    assert_eq!(r.status, "valid", "{r:#?}");
    assert!(r
        .modifications
        .iter()
        .any(|m| m.kind == "form_field_filled" && m.allowed && m.field.as_deref() == Some("Name")));
    // Locked by FieldMDP → disallowed.
    let b = signed(
        doc,
        "signer-rsa-modern.p12",
        SignOptions {
            lock: Some(FieldLock {
                action: LockAction::Include,
                fields: vec!["Name".into()],
            }),
            ..Default::default()
        },
    );
    let r = &check(&fill(&b, "Name", "Ali"), None, &trusting())[0];
    assert_eq!(r.status, "modified", "{r:#?}");
    assert!(r
        .modifications
        .iter()
        .any(|m| m.kind == "form_field_filled" && !m.allowed));
    assert_eq!(r.locks.len(), 1);
}

#[test]
fn second_signature_is_an_allowed_change_for_the_first() {
    let b = signed(
        sample(),
        "signer-rsa-modern.p12",
        SignOptions {
            certify: Some(2),
            ..Default::default()
        },
    );
    let b = signed(b, "signer-p256-modern.p12", SignOptions::default());
    let rs = check(&b, None, &trusting());
    assert_eq!(rs.len(), 2);
    assert_eq!(rs[0].status, "valid", "{:#?}", rs[0]);
    assert!(
        kinds(&rs[0]).iter().any(|k| k.starts_with("signature")),
        "{:?}",
        kinds(&rs[0])
    );
    assert!(rs[1].covers_whole_document);
    assert_eq!(rs[1].status, "valid");
}

#[test]
fn shadow_replace_of_page_content_is_detected() {
    let b = signed(sample(), "signer-rsa-modern.p12", SignOptions::default());
    let b2 = update(&b, |pdf| {
        let page = first_page(pdf);
        let pd = pdf.get_dict(page).unwrap().clone();
        let cid = pd.get(b"Contents").unwrap().as_reference().unwrap();
        pdf.set(
            cid,
            Object::Stream(Stream::new(
                dictionary! {},
                b"BT /F1 24 Tf 72 720 Td (Pay 1,000,000) Tj ET".to_vec(),
            )),
        );
    });
    let r = &check(&b2, None, &trusting())[0];
    assert_eq!(r.status, "modified", "{r:#?}");
    assert!(kinds(r).contains(&"page_content_changed"));
    assert!(
        attack_kinds(r).contains(&"shadow_replace"),
        "{:?}",
        r.attacks
    );
    assert!(attack_kinds(r).contains(&"incremental_saving"));
}

#[test]
fn shadow_hide_and_replace_via_hidden_content_is_detected() {
    // The signed revision already contains an unused content stream; after signing the page
    // is switched to it.
    let doc = update(&sample(), |pdf| {
        pdf.add(Object::Stream(Stream::new(
            dictionary! {},
            b"BT /F1 24 Tf 72 720 Td (Hidden text) Tj ET".to_vec(),
        )));
    });
    let hidden = Pdf::open(doc.clone(), None).unwrap().next_number() - 1;
    let b = signed(doc, "signer-rsa-modern.p12", SignOptions::default());
    let b2 = update(&b, |pdf| {
        let page = first_page(pdf);
        let mut pd = pdf.get_dict(page).unwrap().clone();
        pd.set("Contents", Object::Reference((hidden, 0)));
        pdf.set(page, Object::Dictionary(pd));
    });
    let r = &check(&b2, None, &trusting())[0];
    assert_eq!(r.status, "modified", "{r:#?}");
    assert!(
        attack_kinds(r).contains(&"shadow_hide_and_replace"),
        "{:?}",
        r.attacks
    );
}

#[test]
fn zz_debug_dump() {
    if std::env::var("WARRAQ_DEBUG").is_err() {
        return;
    }
    let b = signed(
        sample(),
        "signer-rsa-modern.p12",
        SignOptions {
            certify: Some(2),
            ..Default::default()
        },
    );
    let b = signed(
        b,
        "signer-p256-modern.p12",
        SignOptions {
            rect: Some([100.0, 100.0, 300.0, 160.0]),
            ..Default::default()
        },
    );
    let b = add_annotation(&b, true);
    for r in check(&b, None, &trusting()) {
        println!("{}", serde_json::to_string_pretty(&r).unwrap());
    }
}
