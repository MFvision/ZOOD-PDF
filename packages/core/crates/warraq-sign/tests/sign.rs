#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod common;
use common::*;
use warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_pdf::{Pdf, PermissionFlags, SecurityHandler};
use warraq_sign::appearance::AppearanceSpec;
use warraq_sign::sign::{sign, signature_slots, FieldLock, Level, LockAction, SignOptions};
use warraq_sign::SoftwareSigner;

const NOW: i64 = 1_790_358_029; // 2026-09-25T17:40:29Z

fn signer(name: &str) -> SoftwareSigner {
    SoftwareSigner::from_pkcs12(&read_pki(name), PW).unwrap()
}

fn plain(pages: usize) -> Vec<u8> {
    sample_pdf(pages, &SampleOptions::default()).unwrap()
}

/// Extract `(cms, signed data)` for the last signature.
fn extract(bytes: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let pdf = Pdf::open(bytes.to_vec(), None).unwrap();
    let slot = signature_slots(&pdf).pop().unwrap();
    let r = slot.range;
    let mut data = bytes[r[0]..r[0] + r[1]].to_vec();
    data.extend_from_slice(&bytes[r[2]..r[2] + r[3]]);
    (slot.contents, data)
}

/// `openssl cms -verify` over the extracted CMS and byte-range data (skipped without openssl).
fn openssl_verify(test: &str, bytes: &[u8]) {
    if !has_openssl() {
        eprintln!("openssl not found: skipping independent CMS check");
        return;
    }
    let dir = scratch(test);
    let (cms, data) = extract(bytes);
    let n = warraq_sign::tlv::element_len(&cms).unwrap();
    std::fs::write(dir.join("sig.der"), &cms[..n]).unwrap();
    std::fs::write(dir.join("data.bin"), &data).unwrap();
    let out = std::process::Command::new("openssl")
        .args([
            "cms", "-verify", "-binary", "-inform", "DER", "-purpose", "any",
        ])
        .arg("-in")
        .arg(dir.join("sig.der"))
        .arg("-content")
        .arg(dir.join("data.bin"))
        .arg("-CAfile")
        .arg(pki("root.pem"))
        .args(["-out", "/dev/null"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "openssl cms -verify failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn assert_range_covers_all_but_contents(bytes: &[u8]) {
    let pdf = Pdf::open(bytes.to_vec(), None).unwrap();
    let slot = signature_slots(&pdf).pop().unwrap();
    let r = slot.range;
    assert_eq!(r[0], 0);
    assert_eq!(r[2] + r[3], bytes.len());
    assert_eq!(bytes[r[1]], b'<');
    assert_eq!(bytes[r[2] - 1], b'>');
}

#[test]
fn rsa_invisible_bb_is_incremental_and_openssl_verifies() {
    let original = plain(1);
    let pdf = Pdf::open(original.clone(), None).unwrap();
    let out = sign(
        &pdf,
        &signer("signer-rsa-modern.p12"),
        &SignOptions {
            reason: Some("Approval".into()),
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        out.bytes.starts_with(&original),
        "original bytes must be a prefix"
    );
    assert_eq!(out.field, "Signature1");
    assert!(out.tsa_request.is_none());
    assert_range_covers_all_but_contents(&out.bytes);
    let text = String::from_utf8_lossy(&out.bytes[original.len()..]).to_string();
    assert!(text.contains("/SubFilter /ETSI.CAdES.detached"));
    assert!(text.contains("/Filter /Adobe.PPKLite"));
    assert!(text.contains("/SigFlags 3"));
    openssl_verify("rsa_bb", &out.bytes);
    // Reopens, and a second signature appends another revision.
    let pdf2 = Pdf::open(out.bytes.clone(), None).unwrap();
    let out2 = sign(
        &pdf2,
        &signer("signer-p384-modern.p12"),
        &SignOptions {
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out2.bytes.starts_with(&out.bytes));
    assert_eq!(out2.field, "Signature2");
    openssl_verify("p384_second", &out2.bytes);
    assert_eq!(
        signature_slots(&Pdf::open(out2.bytes, None).unwrap()).len(),
        2
    );
}

#[test]
fn ecdsa_visible_arabic_appearance_has_actual_text() {
    let original = plain(2);
    let pdf = Pdf::open(original.clone(), None).unwrap();
    let out = sign(
        &pdf,
        &signer("signer-p256-modern.p12"),
        &SignOptions {
            page: 1,
            rect: Some([300.0, 80.0, 540.0, 160.0]),
            reason: Some("موافقة على العقد".into()),
            location: Some("الرياض".into()),
            time: NOW,
            appearance: Some(AppearanceSpec::default()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.bytes.starts_with(&original));
    openssl_verify("p256_visible", &out.bytes);
    let pdf = Pdf::open(out.bytes.clone(), None).unwrap();
    // Find the appearance stream and check it draws glyphs with ActualText per word.
    let mut found = false;
    for obj in pdf.objects().values() {
        if let lopdf::Object::Stream(s) = obj {
            if s.dict.get(b"Subtype").and_then(|o| o.as_name()).ok() == Some(b"Form") {
                let data = warraq_pdf::limits::decode_stream(s, pdf.limits()).unwrap();
                let t = String::from_utf8_lossy(&data).to_string();
                if t.contains("ActualText") {
                    found = true;
                    // "أحمد" as UTF-16BE inside the ActualText of the first word.
                    let ahmad: String = "أحمد".encode_utf16().map(|u| format!("{u:04X}")).collect();
                    assert!(t.contains(&ahmad), "ActualText for أحمد missing:\n{t}");
                    let riyadh: String = "الرياض"
                        .encode_utf16()
                        .map(|u| format!("{u:04X}"))
                        .collect();
                    assert!(t.contains(&riyadh));
                    assert!(t.contains(" TJ"), "glyphs drawn");
                    assert!(t.matches("BDC").count() == t.matches("EMC").count());
                }
            }
        }
    }
    assert!(found, "no appearance stream with ActualText");
    let tail = String::from_utf8_lossy(&out.bytes[original.len()..]).to_string();
    assert!(tail.contains("/Subtype /Type0"));
    assert!(tail.contains("/Encoding /Identity-H"));
    assert!(tail.contains("/FontFile2"));
    assert!(tail.contains("/ToUnicode"));
}

#[test]
fn arabic_is_shaped_not_nominal() {
    // Initial/medial/final forms and the lam-alef ligature must differ from the nominal
    // (isolated) glyphs: proof that shaping happened.
    let (gids, width) = warraq_sign::appearance::shape_for_test("سلام").unwrap();
    assert!(width > 0.0);
    let nominal: Vec<u16> = "سلام"
        .chars()
        .map(|c| warraq_sign::appearance::nominal_glyph_for_test(c).unwrap())
        .collect();
    assert_ne!(gids.iter().rev().copied().collect::<Vec<_>>(), nominal);
    // lam + alef: Amiri draws the lam-alef ligature as two contextual glyphs (the known
    // "kerned lam-alef" trap); neither may be the nominal lam or alef.
    let (lam_alef, _) = warraq_sign::appearance::shape_for_test("لا").unwrap();
    let lam = warraq_sign::appearance::nominal_glyph_for_test('ل').unwrap();
    let alef = warraq_sign::appearance::nominal_glyph_for_test('ا').unwrap();
    assert!(!lam_alef.is_empty());
    assert!(
        lam_alef.iter().all(|g| *g != lam && *g != alef),
        "{lam_alef:?}"
    );
}

#[test]
fn encrypted_document_signs_with_encrypted_strings_and_plain_contents() {
    let h = SecurityHandler::new_aes256("user", "owner", &PermissionFlags::all()).unwrap();
    let original = sample_pdf(
        1,
        &SampleOptions {
            security: Some(h),
            ..Default::default()
        },
    )
    .unwrap();
    let pdf = Pdf::open(original.clone(), Some("user")).unwrap();
    let out = sign(
        &pdf,
        &signer("signer-rsa-legacy.p12"),
        &SignOptions {
            reason: Some("SECRET-REASON-TEXT".into()),
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.bytes.starts_with(&original));
    let tail = String::from_utf8_lossy(&out.bytes[original.len()..]).to_string();
    assert!(
        !tail.contains("SECRET-REASON-TEXT"),
        "reason must be encrypted"
    );
    assert!(tail.contains("/Encrypt"));
    // Reopen with the password: the reason decrypts, /Contents is the raw CMS.
    let pdf = Pdf::open(out.bytes.clone(), Some("user")).unwrap();
    let slot = signature_slots(&pdf).pop().unwrap();
    assert_eq!(
        slot.contents[0], 0x30,
        "CMS starts with SEQUENCE: not encrypted"
    );
    let sd = pdf.get_dict(slot.sig_id).unwrap();
    assert_eq!(
        sd.get(b"Reason").unwrap().as_str().unwrap(),
        b"SECRET-REASON-TEXT"
    );
    let r = slot.range;
    let mut data = out.bytes[..r[1]].to_vec();
    data.extend_from_slice(&out.bytes[r[2]..r[2] + r[3]]);
    if has_openssl() {
        let dir = scratch("encrypted");
        let n = warraq_sign::tlv::element_len(&slot.contents).unwrap();
        std::fs::write(dir.join("sig.der"), &slot.contents[..n]).unwrap();
        std::fs::write(dir.join("data.bin"), &data).unwrap();
        let ok = std::process::Command::new("openssl")
            .args([
                "cms", "-verify", "-binary", "-inform", "DER", "-purpose", "any",
            ])
            .arg("-in")
            .arg(dir.join("sig.der"))
            .arg("-content")
            .arg(dir.join("data.bin"))
            .arg("-CAfile")
            .arg(pki("root.pem"))
            .args(["-out", "/dev/null"])
            .status()
            .unwrap();
        assert!(ok.success());
    }
}

#[test]
fn xref_stream_documents_sign_incrementally() {
    let original = sample_pdf(
        1,
        &SampleOptions {
            xref_stream: true,
            compress: true,
            ..Default::default()
        },
    )
    .unwrap();
    let pdf = Pdf::open(original.clone(), None).unwrap();
    let out = sign(
        &pdf,
        &signer("signer-p256-legacy.p12"),
        &SignOptions {
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.bytes.starts_with(&original));
    assert_range_covers_all_but_contents(&out.bytes);
    openssl_verify("xref_stream", &out.bytes);
}

#[test]
fn certification_and_field_locks_are_written() {
    let pdf = Pdf::open(plain(1), None).unwrap();
    let out = sign(
        &pdf,
        &signer("signer-rsa-modern.p12"),
        &SignOptions {
            certify: Some(2),
            lock: Some(FieldLock {
                action: LockAction::Include,
                fields: vec!["Name".into()],
            }),
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap();
    let pdf = Pdf::open(out.bytes.clone(), None).unwrap();
    assert_eq!(warraq_sign::sign::docmdp_permission(&pdf), Some(2));
    let text = String::from_utf8_lossy(&out.bytes).to_string();
    assert!(text.contains("/TransformMethod /DocMDP"));
    assert!(text.contains("/TransformMethod /FieldMDP"));
    assert!(text.contains("/Action /Include"));
    assert!(text.contains("/Type /SigFieldLock"));
    // A second certification is refused; P=1 forbids any further signature.
    let e = sign(
        &pdf,
        &signer("signer-rsa-modern.p12"),
        &SignOptions {
            certify: Some(1),
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(e.code(), "signing_not_allowed");
    let p1 = sign(
        &Pdf::open(plain(1), None).unwrap(),
        &signer("signer-rsa-modern.p12"),
        &SignOptions {
            certify: Some(1),
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap();
    let e = sign(
        &Pdf::open(p1.bytes, None).unwrap(),
        &signer("signer-p256-modern.p12"),
        &SignOptions {
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(e.code(), "signing_not_allowed");
}

#[test]
fn server_auth_certificates_cannot_sign() {
    let pdf = Pdf::open(plain(1), None).unwrap();
    let e = sign(
        &pdf,
        &signer("signer-server.p12"),
        &SignOptions {
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(e.code(), "signing_not_allowed");
}

#[test]
fn level_bt_returns_a_timestamp_request_and_room_for_the_token() {
    let pdf = Pdf::open(plain(1), None).unwrap();
    let out = sign(
        &pdf,
        &signer("signer-rsa-modern.p12"),
        &SignOptions {
            level: Level::BT,
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap();
    let req = out.tsa_request.unwrap();
    assert_eq!(req.imprint.len(), 32);
    assert!(out.placeholder >= out.cms_len + 8 * 1024);
}

#[test]
fn existing_empty_field_is_filled_with_its_rect_and_lock() {
    use lopdf::{dictionary, Object};
    let mut pdf = Pdf::open(plain(1), None).unwrap();
    let page = warraq_pdf::pages::flatten(&pdf).unwrap()[0].id;
    let w = pdf.add(Object::Dictionary(dictionary! {
        "FT" => "Sig", "T" => Object::string_literal("Approver"),
        "Type" => "Annot", "Subtype" => "Widget", "F" => 4,
        "Rect" => vec![100.into(), 100.into(), 300.into(), 160.into()],
        "P" => Object::Reference(page),
        "Lock" => dictionary! {"Type" => "SigFieldLock", "Action" => "All"},
    }));
    let mut pd = pdf.get_dict(page).unwrap().clone();
    pd.set("Annots", vec![Object::Reference(w)]);
    pdf.set(page, Object::Dictionary(pd));
    let root = pdf.root_id().unwrap();
    let mut cat = pdf.get_dict(root).unwrap().clone();
    cat.set(
        "AcroForm",
        dictionary! {"Fields" => vec![Object::Reference(w)]},
    );
    pdf.set(root, Object::Dictionary(cat));
    let doc = pdf.commit().unwrap();
    let out = sign(
        &Pdf::open(doc.clone(), None).unwrap(),
        &signer("signer-p256-modern.p12"),
        &SignOptions {
            field: Some("Approver".into()),
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(out.field, "Approver");
    let pdf = Pdf::open(out.bytes.clone(), None).unwrap();
    let fields = warraq_sign::pdfobj::fields(&pdf);
    assert_eq!(fields.len(), 1, "no new field");
    let wd = pdf.get_dict(fields[0].widgets[0]).unwrap();
    assert!(
        wd.has(b"AP"),
        "visible appearance from the widget's own rectangle"
    );
    let text = String::from_utf8_lossy(&out.bytes[doc.len()..]).to_string();
    assert!(
        text.contains("/TransformMethod /FieldMDP"),
        "field /Lock becomes FieldMDP"
    );
    openssl_verify("existing_field", &out.bytes);
    // Signing it again is refused.
    let e = sign(
        &pdf,
        &signer("signer-p256-modern.p12"),
        &SignOptions {
            field: Some("Approver".into()),
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(e.code(), "signing_not_allowed");
}

#[test]
fn appearance_text_reads_back_in_logical_order() {
    use lopdf::{dictionary, Object, Stream};
    let pdf = Pdf::open(plain(1), None).unwrap();
    let out = sign(
        &pdf,
        &signer("signer-p256-modern.p12"),
        &SignOptions {
            rect: Some([300.0, 80.0, 540.0, 160.0]),
            appearance: Some(AppearanceSpec {
                lines: Some(vec!["أحمد بن سعيد".into(), "الرياض 2026".into()]),
                arabic_labels: None,
                image: None,
            }),
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap();
    // Draw the widget appearance into the page content so the page text extractor sees it
    // (extractors read annotation appearances the same way).
    let mut p = Pdf::open(out.bytes, None).unwrap();
    let w = warraq_sign::pdfobj::fields(&p)[0].widgets[0];
    let ap = p
        .get_dict(w)
        .unwrap()
        .get(b"AP")
        .unwrap()
        .as_dict()
        .unwrap()
        .get(b"N")
        .unwrap()
        .as_reference()
        .unwrap();
    let page = warraq_pdf::pages::flatten(&p).unwrap()[0].id;
    let draw = p.add(Object::Stream(Stream::new(
        dictionary! {},
        b"q 1 0 0 1 300 80 cm /SigAP Do Q".to_vec(),
    )));
    let mut pd = p.get_dict(page).unwrap().clone();
    let old = pd.get(b"Contents").unwrap().clone();
    pd.set("Contents", vec![old, Object::Reference(draw)]);
    let mut res = pd.get(b"Resources").unwrap().as_dict().unwrap().clone();
    res.set("XObject", dictionary! {"SigAP" => Object::Reference(ap)});
    pd.set("Resources", res);
    p.set(page, Object::Dictionary(pd));
    let bytes = p.commit().unwrap();
    let src = warraq_text::LopdfSource::open(&bytes, None).unwrap();
    let text =
        warraq_text::plain_text(&warraq_text::extract_all(&src, &Default::default()).unwrap());
    assert!(text.contains("أحمد بن سعيد"), "extracted: {text:?}");
    assert!(text.contains("الرياض"), "extracted: {text:?}");
}

#[test]
fn rotated_page_appearance_is_counter_rotated() {
    let mut pdf = Pdf::open(plain(1), None).unwrap();
    warraq_pdf::pages::rotate(&mut pdf, &[0], 90).unwrap();
    let doc = pdf.commit().unwrap();
    let out = sign(
        &Pdf::open(doc, None).unwrap(),
        &signer("signer-rsa-modern.p12"),
        &SignOptions {
            rect: Some([50.0, 50.0, 110.0, 250.0]),
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap();
    let pdf = Pdf::open(out.bytes.clone(), None).unwrap();
    let w = warraq_sign::pdfobj::fields(&pdf)[0].widgets[0];
    let wd = pdf.get_dict(w).unwrap();
    assert_eq!(
        wd.get(b"MK")
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"R")
            .unwrap()
            .as_i64()
            .unwrap(),
        90
    );
    let ap = wd
        .get(b"AP")
        .unwrap()
        .as_dict()
        .unwrap()
        .get(b"N")
        .unwrap()
        .as_reference()
        .unwrap();
    let apd = pdf.get_dict(ap).unwrap();
    let m: Vec<i64> = apd
        .get(b"Matrix")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o.as_i64().unwrap())
        .collect();
    assert_eq!(m, vec![0, 1, -1, 0, 0, 0]);
    // The box is laid out in the rotated (visual) frame: 200 wide, 60 high.
    let bbox: Vec<f32> = apd
        .get(b"BBox")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o.as_float().unwrap())
        .collect();
    assert_eq!(bbox, vec![0.0, 0.0, 200.0, 60.0]);
    openssl_verify("rotated", &out.bytes);
}

#[test]
fn font_has_arabic_indic_digits_for_localised_dates() {
    for c in "٠١٢٣٤٥٦٧٨٩/:".chars() {
        assert!(
            warraq_sign::appearance::nominal_glyph_for_test(c).is_some_and(|g| g != 0),
            "{c} missing from the signature font"
        );
    }
}
