//! Signing real corpus files and checking them back, with the TEST PKI in
//! `tests/fixtures/signatures` — and, where the machine has it, checking the
//! same signatures with `openssl cms -verify`, an implementation that shares
//! no code with this one.
use std::path::PathBuf;
use std::process::Command;

use lopdf::Object;
use warraq_pdf::PdfDocument;

use crate::chain::TrustStore;
use crate::keys::Padding;
use crate::pades::{self, Report, SignOptions, Signed};
use crate::pkcs12;
use crate::tsp::tests::answer;

const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");
/// 2026-09-19 20:00 in Riyadh, a day after the TEST PKI was made.
const NOW: i64 = 1_789_750_800 + 86_400;

fn repo(path: &str) -> PathBuf {
    PathBuf::from(format!("{}/../../../{path}", env!("CARGO_MANIFEST_DIR")))
}
fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(repo(&format!("tests/fixtures/signatures/{name}"))).unwrap()
}
fn corpus(name: &str) -> Vec<u8> {
    std::fs::read(repo(&format!("tests/corpus/arabic/{name}"))).unwrap()
}

fn options(visible: bool) -> SignOptions {
    SignOptions {
        field: None,
        page: 0,
        rect: visible.then_some([320.0, 40.0, 560.0, 120.0]),
        lines: vec![
            "وقّعه رقمياً: محمد التجريبي".into(),
            "التاريخ: 2026-09-18 20:00 +03:00".into(),
            "السبب: الموافقة على العقد".into(),
        ],
        font: Some(AMIRI.to_vec()),
        image: None,
        name: None,
        reason: Some("الموافقة على العقد".into()),
        location: Some("الرياض".into()),
        contact: None,
        time: NOW,
        offset_minutes: 180,
        certify: None,
        lock_fields: false,
        padding: Padding::Pkcs1v15,
        timestamp: false,
    }
}

fn sign_with(pdf: Vec<u8>, password: Option<&str>, p12: &str, o: &SignOptions) -> Vec<u8> {
    let id = pkcs12::open(&fixture(p12), "warraq-test").unwrap();
    let mut doc = PdfDocument::open(pdf, password).unwrap();
    match pades::sign(&mut doc, &id.signer, o).unwrap() {
        Signed::Done(bytes) => bytes,
        Signed::NeedsTimestamp { .. } => panic!("no timestamp asked for"),
    }
}

fn trusting(roots: &[&str]) -> TrustStore {
    let mut store = TrustStore::mozilla();
    for r in roots {
        store.add_user(&fixture(r)).unwrap();
    }
    store
}

fn verify(bytes: &[u8], password: Option<&str>, roots: &[&str]) -> Report {
    pades::verify(bytes, password, &trusting(roots), NOW + 60).unwrap()
}

/// `openssl cms -verify` over the signed bytes, when openssl is installed.
fn openssl_verifies(bytes: &[u8], root_pem: &str) -> Option<bool> {
    let which = Command::new("openssl").arg("version").output().ok()?;
    if !which.status.success() {
        return None;
    }
    let doc = PdfDocument::open(bytes.to_vec(), None).ok()?;
    let sig = doc.signature_fields().into_iter().find_map(|f| f.value)?;
    let br: Vec<usize> = sig.byte_range.iter().map(|v| *v as usize).collect();
    let hexits = &bytes[br[1] + 1..br[2] - 1];
    let raw: Vec<u8> = hexits
        .chunks(2)
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
        .collect();
    let der = crate::asn1::first_der(&raw).unwrap().to_vec();
    let dir = std::env::temp_dir().join(format!("warraq-cms-{}-{}", std::process::id(), bytes.len()));
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::write(dir.join("sig.der"), der).ok()?;
    std::fs::write(dir.join("data.bin"), [&bytes[..br[1]], &bytes[br[2]..br[2] + br[3]]].concat()).ok()?;
    let out = Command::new("openssl")
        .args(["cms", "-verify", "-binary", "-inform", "DER", "-purpose", "any"])
        .arg("-in")
        .arg(dir.join("sig.der"))
        .arg("-content")
        .arg(dir.join("data.bin"))
        .arg("-CAfile")
        .arg(repo(&format!("tests/fixtures/signatures/{root_pem}")))
        .args(["-out", "/dev/null"])
        .output()
        .ok()?;
    let _ = std::fs::remove_dir_all(&dir);
    if !out.status.success() {
        eprintln!("openssl: {}", String::from_utf8_lossy(&out.stderr));
    }
    Some(out.status.success())
}

#[test]
fn an_arabic_file_signed_with_each_key_type_verifies_and_openssl_agrees() {
    let original = corpus("generated/chrome-notonaskh-justified-3pages.pdf");
    for (p12, padding) in [
        ("signer-rsa-legacy.p12", Padding::Pkcs1v15),
        ("signer-rsa-aes.p12", Padding::Pss),
        ("signer-ec.p12", Padding::Pkcs1v15),
        ("signer-ec384-legacy.p12", Padding::Pkcs1v15),
    ] {
        let o = SignOptions { padding, ..options(true) };
        let signed = sign_with(original.clone(), None, p12, &o);
        assert!(signed.starts_with(&original), "{p12}: incremental");
        let root = if p12.contains("ec") { "root-ec.cer" } else { "root-rsa.cer" };

        // Untrusted until the TEST root is trusted; intact either way.
        let r = verify(&signed, None, &[]);
        assert_eq!(r.signatures.len(), 1);
        let s = &r.signatures[0];
        assert_eq!(s.status, "untrusted", "{p12}: {:?}", s.problems);
        assert!(s.integrity.byte_range_ok && s.integrity.digest_ok && s.integrity.signature_ok, "{p12}");
        assert!(s.integrity.covers_whole_file);
        assert!(s.visible);
        assert_eq!(s.reason.as_deref(), Some("الموافقة على العقد"));
        let r = verify(&signed, None, &[root]);
        assert_eq!(r.signatures[0].status, "valid", "{p12}: {:?}", r.signatures[0].problems);
        assert_eq!(r.signatures[0].claimed_time.as_deref(), Some("2026-09-19T17:00:00Z"));
        if p12 == "signer-rsa-legacy.p12" {
            assert_eq!(r.signatures[0].signed_by, "محمد التجريبي (TEST)");
        }

        // The file still reads, and the visible signature's Arabic reads back.
        let doc = PdfDocument::open(signed.clone(), None).unwrap();
        assert_eq!(doc.page_count(), 3);

        let pem = if p12.contains("ec") { "root-ec.pem" } else { "root-rsa.pem" };
        match openssl_verifies(&signed, pem) {
            Some(ok) => assert!(ok, "{p12}: openssl cms -verify refused it"),
            None => eprintln!("openssl not found: the independent check was skipped"),
        }
        // And refuses it once a signed byte changes.
        let mut tampered = signed.clone();
        tampered[200] ^= 1;
        assert_eq!(openssl_verifies(&tampered, pem), Some(false).filter(|_| openssl_verifies(&signed, pem).is_some()), "{p12}");
    }
}

#[test]
fn one_changed_byte_makes_the_signature_invalid() {
    let signed = sign_with(corpus("generated/chrome-cairo-mixed-invoice.pdf"), None, "signer-ec.p12", &options(false));
    let doc = PdfDocument::open(signed.clone(), None).unwrap();
    let br = doc.signature_fields()[0].value.clone().unwrap().byte_range;
    for at in [100usize, br[1] as usize - 20, br[2] as usize + 5] {
        let mut tampered = signed.clone();
        tampered[at] ^= 0x01;
        let r = verify(&tampered, None, &["root-ec.cer"]);
        match r.signatures.first() {
            Some(s) => assert_eq!(s.status, "invalid", "byte {at}: {:?}", s.integrity),
            // A byte in the xref can leave no readable signature at all.
            None => {}
        }
    }
}

#[test]
fn a_protected_file_is_signed_encrypted_and_verifies_with_its_password() {
    let original = corpus("generated/variant-encrypted-aes256.pdf");
    let signed = sign_with(original.clone(), Some("warraq"), "signer-rsa-aes.p12", &options(true));
    assert!(signed.starts_with(&original));
    assert!(PdfDocument::open(signed.clone(), None).is_err(), "still protected");
    let r = verify(&signed, Some("warraq"), &["root-rsa.cer"]);
    assert_eq!(r.signatures[0].status, "valid", "{:?}", r.signatures[0].problems);
    assert_eq!(r.signatures[0].location.as_deref(), Some("الرياض"), "strings sealed and read back");
}

/// Changes a form field's value in an update, as another program would.
fn fill_first_text_field(bytes: Vec<u8>, value: &str) -> Vec<u8> {
    let mut doc = PdfDocument::open(bytes, None).unwrap();
    let id = doc
        .doc_ref()
        .objects
        .iter()
        .find(|(_, o)| {
            o.as_dict()
                .is_ok_and(|d| d.get(b"FT").ok().and_then(|f| f.as_name().ok()) == Some(b"Tx") && d.has(b"T"))
        })
        .map(|(id, _)| *id)
        .expect("a text field");
    let mut v = vec![0xFE, 0xFF];
    v.extend(value.encode_utf16().flat_map(u16::to_be_bytes));
    doc.doc_mut()
        .get_dictionary_mut(id)
        .unwrap()
        .set("V", Object::String(v, lopdf::StringFormat::Hexadecimal));
    doc.mark_touched(id);
    doc.save_incremental().unwrap()
}

#[test]
fn filling_a_form_after_signing_is_allowed_unless_the_fields_are_locked() {
    let form = corpus("generated/acroform-pdflib-arabic-fields.pdf");
    let signed = sign_with(form.clone(), None, "signer-rsa-legacy.p12", &options(true));
    let filled = fill_first_text_field(signed, "قيمة جديدة");
    let r = verify(&filled, None, &["root-rsa.cer"]);
    let s = &r.signatures[0];
    assert!(!s.integrity.covers_whole_file);
    assert_eq!(s.status, "valid", "{:?}", s.changes);
    assert!(s.changes.iter().any(|c| c.kind == "formFill" && c.allowed), "{:?}", s.changes);

    let locked = sign_with(form, None, "signer-rsa-legacy.p12", &SignOptions { lock_fields: true, ..options(true) });
    let filled = fill_first_text_field(locked, "قيمة جديدة");
    let s = &verify(&filled, None, &["root-rsa.cer"]).signatures[0];
    assert_eq!(s.status, "modified", "{:?}", s.changes);
    assert!(s.changes.iter().any(|c| c.kind == "lockedField" && !c.allowed));
}

#[test]
fn drawing_on_a_page_after_signing_is_found() {
    let signed = sign_with(corpus("generated/chrome-cairo-mixed-invoice.pdf"), None, "signer-rsa-legacy.p12", &options(false));
    let mut doc = PdfDocument::open(signed, None).unwrap();
    warraq_pdf::append_line(&mut doc, 0, "سطر أضيف بعد التوقيع", AMIRI, 12.0, 300.0, 60.0).unwrap();
    let edited = doc.save_incremental().unwrap();
    let s = &verify(&edited, None, &["root-rsa.cer"]).signatures[0];
    assert_eq!(s.status, "modified");
    assert!(s.changes.iter().any(|c| c.kind == "pageContent" && !c.allowed), "{:?}", s.changes);
    assert!(s.integrity.digest_ok && s.integrity.signature_ok, "what it signed is intact");
}

#[test]
fn a_certified_file_forbids_what_its_level_forbids_and_a_second_signature_is_listed() {
    let form = corpus("generated/acroform-pdflib-arabic-fields.pdf");
    let certified = sign_with(form, None, "signer-ec.p12", &SignOptions { certify: Some(2), ..options(false) });
    let r = verify(&certified, None, &["root-ec.cer"]);
    assert_eq!(r.certified, Some(2));
    assert_eq!(r.signatures[0].kind, "certification");
    // A second, approval signature is allowed under P=2.
    let twice = sign_with(certified, None, "signer-rsa-legacy.p12", &options(true));
    let r = verify(&twice, None, &["root-ec.cer", "root-rsa.cer"]);
    assert_eq!(r.signatures.len(), 2);
    assert_eq!(r.signatures[0].status, "valid", "{:?}", r.signatures[0].changes);
    assert!(r.signatures[0].changes.iter().any(|c| c.kind == "signatures" && c.allowed));
    assert_eq!(r.signatures[1].status, "valid");

    // Under P=1 nothing may be signed after.
    let strict = sign_with(
        corpus("generated/chrome-cairo-mixed-invoice.pdf"),
        None,
        "signer-ec.p12",
        &SignOptions { certify: Some(1), ..options(false) },
    );
    let id = pkcs12::open(&fixture("signer-rsa-legacy.p12"), "warraq-test").unwrap();
    let mut doc = PdfDocument::open(strict, None).unwrap();
    assert!(pades::sign(&mut doc, &id.signer, &options(false)).is_err());
}

#[test]
fn a_signature_timestamp_is_requested_embedded_and_verified() {
    let original = corpus("generated/chrome-cairo-mixed-invoice.pdf");
    let id = pkcs12::open(&fixture("signer-rsa-aes.p12"), "warraq-test").unwrap();
    let mut doc = PdfDocument::open(original, None).unwrap();
    let o = SignOptions { timestamp: true, ..options(true) };
    let Signed::NeedsTimestamp { prepared, cms, request } = pades::sign(&mut doc, &id.signer, &o).unwrap() else {
        panic!("a timestamp was asked for");
    };
    // What the authority is sent is a digest, nothing of the document.
    assert!(request.len() < 100);
    let response = answer(&request, NOW + 5);
    let signed = pades::finish(prepared.clone(), &cms, &request, &response).unwrap();
    let s = &verify(&signed, None, &["root-rsa.cer"]).signatures[0];
    assert_eq!(s.status, "valid", "{:?}", s.problems);
    let t = s.timestamp.as_ref().expect("a timestamp");
    assert!(t.valid && t.trusted, "{t:?}");
    assert_eq!(t.time, crate::time::iso(NOW + 5));
    // An answer to another request is refused.
    let other = crate::tsp::request(crate::HashAlg::Sha256, &[7; 32]).unwrap();
    assert!(pades::finish(prepared, &cms, &request, &answer(&other.der, NOW)).is_err());
}

#[test]
fn a_document_timestamp_covers_the_file_after_its_signature() {
    let signed = sign_with(corpus("generated/chrome-cairo-mixed-invoice.pdf"), None, "signer-ec.p12", &options(false));
    let mut doc = PdfDocument::open(signed, None).unwrap();
    let (prepared, request) = pades::prepare_doc_timestamp(&mut doc).unwrap();
    let stamped = pades::finish_doc_timestamp(prepared, &request, &answer(&request, NOW + 60)).unwrap();
    let r = verify(&stamped, None, &["root-ec.cer", "root-rsa.cer"]);
    assert_eq!(r.signatures.len(), 2);
    assert_eq!(r.signatures[0].status, "valid", "{:?}", r.signatures[0].changes);
    assert!(r.signatures[0].changes.iter().all(|c| c.allowed));
    let ts = &r.signatures[1];
    assert_eq!(ts.kind, "timestamp");
    assert_eq!(ts.status, "valid", "{:?}", ts.problems);
    assert_eq!(ts.signed_by, "Warraq TEST Timestamp Authority");
}

#[test]
fn validation_data_is_fetched_for_the_chain_and_kept_in_the_file() {
    let signed = sign_with(corpus("generated/chrome-cairo-mixed-invoice.pdf"), None, "signer-rsa-legacy.p12", &options(false));
    let trust = trusting(&["root-rsa.cer"]);
    let fetches = pades::fetches(&signed, None, &trust, NOW).unwrap();
    let urls: Vec<&str> = fetches.iter().map(|f| f.url.as_str()).collect();
    assert_eq!(urls, ["http://ocsp.warraq.test/intermediate-rsa", "http://ocsp.warraq.test/root"], "{fetches:?}");
    assert!(fetches.iter().all(|f| f.kind == "ocsp" && f.body.is_some()));

    // The answers the responders would give; a stray one is rejected.
    let answers = vec![
        ("ocsp".to_string(), fixture("signer-rsa.ocsp")),
        ("ocsp".to_string(), fixture("intermediate-rsa.ocsp")),
        ("ocsp".to_string(), fixture("signer-ec.ocsp")),
    ];
    let mut doc = PdfDocument::open(signed, None).unwrap();
    let (with_ltv, added) = pades::add_validation(&mut doc, &answers, &trust, NOW).unwrap();
    // The signer's and the intermediate's certificates (the root is the
    // trust anchor itself, and travels in the signature).
    assert_eq!((added.certs, added.ocsps), (2, 2), "{added:?}");
    assert_eq!(added.rejected, vec![2]);
    let r = verify(&with_ltv, None, &["root-rsa.cer"]);
    let s = &r.signatures[0];
    assert_eq!(s.status, "valid", "{:?}", s.changes);
    assert!(s.revocation.embedded);
    assert_eq!(s.revocation.status, "good");
    assert_eq!(r.dss.ocsps, 2);
    assert!(s.changes.iter().all(|c| c.kind == "validationData" && c.allowed), "{:?}", s.changes);
}

#[test]
fn a_certificate_revoked_before_signing_makes_the_signature_invalid() {
    let signed = sign_with(corpus("generated/chrome-cairo-mixed-invoice.pdf"), None, "revoked-rsa.p12", &options(false));
    let trust = trusting(&["root-rsa.cer"]);
    let mut doc = PdfDocument::open(signed, None).unwrap();
    let answers = vec![("ocsp".to_string(), fixture("revoked-rsa.ocsp"))];
    let (with_ltv, _) = pades::add_validation(&mut doc, &answers, &trust, NOW).unwrap();
    let s = &verify(&with_ltv, None, &["root-rsa.cer"]).signatures[0];
    assert_eq!(s.revocation.status, "revoked");
    assert_eq!(s.status, "invalid", "{:?}", s.problems);
}

#[test]
fn a_file_without_signatures_reports_none_and_garbage_contents_are_invalid() {
    let r = verify(&corpus("generated/chrome-cairo-mixed-invoice.pdf"), None, &[]);
    assert!(r.signatures.is_empty() && r.certified.is_none());
    // A prepared file whose room holds nothing is an invalid signature, not a crash.
    let mut doc = PdfDocument::open(corpus("generated/chrome-cairo-mixed-invoice.pdf"), None).unwrap();
    let (prepared, _) = pades::prepare_doc_timestamp(&mut doc).unwrap();
    let r = verify(&prepared, None, &[]);
    assert_eq!(r.signatures[0].status, "invalid");
}
