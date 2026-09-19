//! The signatures tool through `call_static`, the way every host reaches
//! it: a certificate file described, a visible Arabic signature made and
//! read back, and the verifier's verdict before and after trusting the
//! TEST root.
use serde_json::{json, Value};
use warraq_core::{call_static, Document};

fn read(path: &str) -> Vec<u8> {
    std::fs::read(format!("{}/../../../{path}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn reply_json(reply: &warraq_core::Reply) -> Value {
    serde_json::from_str(&reply.json).unwrap()
}

const NOW: i64 = 1_789_837_200; // 2026-09-19 17:00 UTC

#[test]
fn a_certificate_file_is_described_and_a_wrong_password_named() {
    let p12 = read("tests/fixtures/signatures/signer-rsa-aes.p12");
    let r = call_static(
        "signatures.identity",
        &json!({ "p12Password": "warraq-test", "now": NOW }).to_string(),
        vec![p12.clone()],
    )
    .unwrap();
    let v = reply_json(&r);
    assert_eq!(v["name"], "محمد التجريبي (TEST)");
    assert_eq!(v["issuer"], "Warraq TEST Intermediate CA RSA");
    assert_eq!(v["key"], "RSA 2048");
    assert_eq!(v["validNow"], true);
    let wrong = call_static(
        "signatures.identity",
        r#"{"p12Password":"nope"}"#,
        vec![p12],
    )
    .unwrap_err();
    assert!(wrong.to_string().starts_with("E_P12_PASSWORD"), "{wrong}");
}

#[test]
fn a_visible_arabic_signature_is_made_read_back_and_verified() {
    let pdf = read("tests/corpus/arabic/generated/chrome-cairo-mixed-invoice.pdf");
    let args = json!({
        "p12Password": "warraq-test",
        "page": 0,
        "rect": [300.0, 640.0, 560.0, 740.0],
        "lines": ["وقّعه رقمياً: محمد التجريبي", "2026-09-19 20:00"],
        "image": { "width": 2, "height": 2 },
        "reason": "اعتماد الفاتورة",
        "time": NOW,
        "offsetMinutes": 180,
    });
    let signed = call_static(
        "signatures.sign",
        &args.to_string(),
        vec![
            pdf.clone(),
            read("tests/fixtures/signatures/signer-rsa-legacy.p12"),
            read("tests/fonts/Amiri-Regular.ttf"),
            vec![0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 255],
        ],
    )
    .unwrap();
    assert_eq!(reply_json(&signed)["done"], true);
    let bytes = signed.blobs[0].clone();
    assert!(bytes.starts_with(&pdf));

    // The signature's lines are in the page's text, as written.
    let doc = Document::open(bytes.clone(), None).unwrap();
    let text = doc.extract_text(0).unwrap();
    assert!(text.contains("محمد التجريبي"), "{text}");

    let verify = |trusted: Vec<Vec<u8>>| {
        let mut blobs = vec![bytes.clone()];
        blobs.extend(trusted);
        reply_json(
            &call_static(
                "signatures.verify",
                &json!({ "now": NOW + 60 }).to_string(),
                blobs,
            )
            .unwrap(),
        )
    };
    let v = verify(vec![]);
    let s = &v["signatures"][0];
    assert_eq!(s["status"], "untrusted");
    assert_eq!(s["signedBy"], "محمد التجريبي (TEST)");
    assert_eq!(s["reason"], "اعتماد الفاتورة");
    assert_eq!(s["visible"], true);
    assert_eq!(s["page"], 0);
    assert_eq!(s["integrity"]["digestOk"], true);
    assert_eq!(s["chain"]["trust"]["state"], "untrustedRoot");
    // The certificate offered to trust is the TEST root.
    let candidate = s["trustCandidate"].as_str().unwrap();
    let root = warraq_sign::unbase64(candidate).unwrap();
    assert_eq!(root, read("tests/fixtures/signatures/root-rsa.cer"));
    assert_eq!(verify(vec![root])["signatures"][0]["status"], "valid");
}

/// Signs `pdf` through the tool with the RSA TEST signer; `extra` adds to
/// or overrides the arguments.
fn sign(pdf: Vec<u8>, extra: Value) -> Vec<u8> {
    let mut args = json!({
        "p12Password": "warraq-test",
        "lines": ["وقّعه رقمياً: محمد التجريبي", "التاريخ: 2026-09-19 20:00"],
        "time": NOW,
        "offsetMinutes": 180,
    });
    for (k, v) in extra.as_object().unwrap() {
        args[k] = v.clone();
    }
    let signed = call_static(
        "signatures.sign",
        &args.to_string(),
        vec![
            pdf,
            read("tests/fixtures/signatures/signer-rsa-legacy.p12"),
            read("tests/fonts/Amiri-Regular.ttf"),
        ],
    )
    .unwrap();
    signed.blobs[0].clone()
}

/// The verdict on `bytes`, trusting the RSA TEST root.
fn verified(bytes: &[u8]) -> Value {
    reply_json(
        &call_static(
            "signatures.verify",
            &json!({ "now": NOW + 60 }).to_string(),
            vec![
                bytes.to_vec(),
                read("tests/fixtures/signatures/root-rsa.cer"),
            ],
        )
        .unwrap(),
    )
}

#[test]
fn saving_a_signed_arabic_form_leaves_its_appearances_as_the_signer_saw_them() {
    // A form whose Arabic values another program drew, certified with no
    // changes allowed — by someone else's software, as far as Warraq knows.
    let form = read("tests/corpus/arabic/generated/acroform-pdflib-arabic-fields.pdf");
    let certified = sign(form, json!({ "certify": 1 }));
    assert_eq!(verified(&certified)["signatures"][0]["status"], "valid");
    let amiri = read("tests/fonts/Amiri-Regular.ttf");
    // Every save hands the fixer the file as it was opened: nothing that is
    // as it was is redrawn, and the file stays exactly as signed.
    let fixed = call_static(
        "forms.fix_appearances",
        "{}",
        vec![certified.clone(), amiri.clone(), certified.clone()],
    )
    .unwrap();
    assert_eq!(reply_json(&fixed)["fields"], 0);
    assert_eq!(fixed.blobs[0], certified);
    // Told nothing of the file as it was opened, it would have redrawn the
    // form's Arabic after the certification, which then shows as broken.
    let blind = call_static(
        "forms.fix_appearances",
        "{}",
        vec![certified.clone(), amiri],
    )
    .unwrap();
    assert!(reply_json(&blind)["fields"].as_u64().unwrap() > 0);
    assert_eq!(
        verified(&blind.blobs[0])["signatures"][0]["status"],
        "modified"
    );
}

#[test]
fn a_field_filled_after_signing_is_still_drawn() {
    let form = read("tests/corpus/arabic/generated/acroform-pdflib-arabic-fields.pdf");
    let certified = sign(form, json!({ "certify": 2 }));
    // A text field given another Arabic value, as EmbedPDF writes it.
    let mut doc = warraq_pdf::PdfDocument::open(certified.clone(), None).unwrap();
    let id = doc
        .doc_ref()
        .objects
        .iter()
        .find(|(_, o)| {
            o.as_dict().is_ok_and(|d| {
                d.get(b"FT").ok().and_then(|f| f.as_name().ok()) == Some(b"Tx") && d.has(b"T")
            })
        })
        .map(|(id, _)| *id)
        .unwrap();
    let mut value = vec![0xFE, 0xFF];
    value.extend("قيمة جديدة".encode_utf16().flat_map(u16::to_be_bytes));
    doc.doc_mut().get_dictionary_mut(id).unwrap().set(
        "V",
        lopdf::Object::String(value, lopdf::StringFormat::Hexadecimal),
    );
    doc.mark_touched(id);
    let filled = doc.save_incremental().unwrap();
    let fixed = call_static(
        "forms.fix_appearances",
        "{}",
        vec![
            filled,
            read("tests/fonts/Amiri-Regular.ttf"),
            certified.clone(),
        ],
    )
    .unwrap();
    assert_eq!(reply_json(&fixed)["fields"], 1, "only the field filled");
    let s = &verified(&fixed.blobs[0])["signatures"][0];
    assert_eq!(s["status"], "valid", "{s}");
}

#[test]
fn signing_an_empty_signature_field_draws_the_signature_in_it() {
    // The empty signature field Prepare form makes.
    let pdf = read("tests/corpus/arabic/generated/chrome-cairo-mixed-invoice.pdf");
    let created = call_static(
        "forms.create",
        &json!({ "fields": [{
            "page": 0, "kind": "signature", "name": "التوقيع", "rect": [320.0, 660.0, 560.0, 730.0], "rtl": true,
        }] })
        .to_string(),
        vec![pdf],
    )
    .unwrap();
    let form = created.blobs[0].clone();
    let before = reply_json(
        &call_static(
            "signatures.verify",
            &json!({ "now": NOW }).to_string(),
            vec![form.clone()],
        )
        .unwrap(),
    );
    assert_eq!(before["emptyFields"], json!(["التوقيع"]));

    // Chosen by name, with no box drawn: the field's own box is used.
    let signed = sign(form, json!({ "field": "التوقيع", "rect": null }));
    let doc = warraq_pdf::PdfDocument::open(signed.clone(), None).unwrap();
    let field = doc
        .signature_fields()
        .into_iter()
        .find(|f| f.name == "التوقيع")
        .unwrap();
    let widget = doc.doc_ref().get_dictionary(field.widget.unwrap()).unwrap();
    assert!(
        widget
            .get(b"AP")
            .is_ok_and(|ap| ap.as_dict().is_ok_and(|d| d.has(b"N"))),
        "the field has the signature's appearance"
    );
    let text = Document::open(signed.clone(), None)
        .unwrap()
        .extract_text(0)
        .unwrap();
    assert!(text.contains("محمد التجريبي"), "{text}");
    let s = &verified(&signed)["signatures"][0];
    assert_eq!(s["field"], "التوقيع");
    assert_eq!(s["visible"], true);
    assert_eq!(s["status"], "valid", "{s}");
    assert_eq!(verified(&signed)["emptyFields"], json!([]));
}

#[test]
fn a_timestamp_request_comes_back_for_the_host_to_send() {
    let pdf = read("tests/corpus/arabic/generated/chrome-cairo-mixed-invoice.pdf");
    let r = call_static(
        "signatures.sign",
        &json!({ "p12Password": "warraq-test", "time": NOW, "timestamp": true }).to_string(),
        vec![pdf, read("tests/fixtures/signatures/signer-ec.p12")],
    )
    .unwrap();
    assert_eq!(reply_json(&r)["done"], false);
    assert_eq!(r.blobs.len(), 3, "prepared file, signature, request");
    // A request is a digest and a nonce: under a hundred bytes.
    assert!(r.blobs[2].len() < 100);
    let bad = call_static(
        "signatures.finish",
        "{}",
        vec![
            r.blobs[0].clone(),
            r.blobs[1].clone(),
            r.blobs[2].clone(),
            b"garbage".to_vec(),
        ],
    );
    assert!(bad.unwrap_err().to_string().starts_with("E_TSA"));
}
