//! `sign.*` RPC methods end to end (PKCS#12 in, signed bytes out, verification JSON).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use warraq_core::warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_core::{CoreError, Document, Reply};

const NOW: i64 = 1_790_358_029;

fn pki(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../tests/fixtures/sign/pki")
        .join(name)
}

fn read(name: &str) -> Vec<u8> {
    std::fs::read(pki(name)).unwrap()
}

fn call(d: &mut Document, m: &str, p: Value, blobs: Vec<Vec<u8>>) -> Reply {
    d.call(m, &p, blobs).unwrap_or_else(|e| panic!("{m}: {e}"))
}

fn err(d: &mut Document, m: &str, p: Value, blobs: Vec<Vec<u8>>) -> CoreError {
    d.call(m, &p, blobs).unwrap_err()
}

fn doc() -> Document {
    Document::open(sample_pdf(2, &SampleOptions::default()).unwrap(), None).unwrap()
}

#[test]
fn prepare_b_b_list_and_verify() {
    let mut d = doc();
    let original = d.pdf().bytes().to_vec();
    let r = call(
        &mut d,
        "sign.prepare",
        json!({
            "password": "test123", "page": 0, "rect": [320, 60, 560, 140],
            "reason": "اعتماد", "location": "جدة", "time": NOW,
            "appearance": {"arabicLabels": true}
        }),
        vec![read("signer-p256-modern.p12")],
    );
    assert_eq!(r.json["next"], "done");
    assert_eq!(r.json["field"], "Signature1");
    assert_eq!(r.json["signer"], "أحمد بن سعيد");
    assert!(r.blobs[0].starts_with(&original));
    assert_eq!(d.pdf().bytes(), r.blobs[0].as_slice(), "document replaced");

    let l = call(&mut d, "sign.list", json!({}), vec![]);
    assert_eq!(l.json["fields"][0]["name"], "Signature1");
    assert_eq!(l.json["fields"][0]["signed"], true);
    assert_eq!(l.json["fields"][0]["page"], 0);
    assert_eq!(l.json["fields"][0]["visible"], true);

    let v = call(&mut d, "sign.verify", json!({"now": NOW}), vec![]);
    let s = &v.json["signatures"][0];
    assert_eq!(s["status"], "valid_identity_unknown", "{s}");
    assert_eq!(s["reason"], "اعتماد");
    assert_eq!(v.json["trustedRoots"], 0);
    let v = call(
        &mut d,
        "sign.verify",
        json!({"now": NOW}),
        vec![read("root.pem")],
    );
    assert_eq!(v.json["signatures"][0]["status"], "valid");
    assert_eq!(v.json["signatures"][0]["signer"]["name"], "أحمد بن سعيد");

    // doc.info now reports a signature.
    let i = call(&mut d, "doc.info", json!({}), vec![]);
    assert_eq!(i.json["hasSignatures"], true);
}

#[test]
fn prepare_errors() {
    let mut d = doc();
    let p12 = read("signer-rsa-legacy.p12");
    assert_eq!(
        err(
            &mut d,
            "sign.prepare",
            json!({"password": "nope"}),
            vec![p12.clone()]
        )
        .code,
        "wrong_certificate_password"
    );
    assert_eq!(
        err(
            &mut d,
            "sign.prepare",
            json!({"password": "test123"}),
            vec![]
        )
        .code,
        "invalid_params"
    );
    assert_eq!(
        err(
            &mut d,
            "sign.prepare",
            json!({"password": "test123", "level": "B-X"}),
            vec![p12.clone()]
        )
        .code,
        "invalid_argument"
    );
    assert_eq!(
        err(
            &mut d,
            "sign.prepare",
            json!({"password": "test123", "page": 9, "rect": [0, 0, 100, 50]}),
            vec![p12.clone()]
        )
        .code,
        "invalid_argument"
    );
    assert_eq!(
        err(
            &mut d,
            "sign.prepare",
            json!({"password": "test123", "time": NOW}),
            vec![read("signer-server.p12")]
        )
        .code,
        "signing_not_allowed"
    );
    assert_eq!(
        err(
            &mut d,
            "sign.prepare",
            json!({"password": "test123", "bogus": 1}),
            vec![p12.clone()]
        )
        .code,
        "invalid_params"
    );
    assert_eq!(
        err(&mut d, "sign.finish", json!({}), vec![b"x".to_vec()]).code,
        "invalid_argument"
    );
    // Nothing was written by the failures.
    assert_eq!(
        call(&mut d, "doc.info", json!({}), vec![]).json["revisions"],
        1
    );
    // Certification + field lock through the RPC.
    let r = call(
        &mut d,
        "sign.prepare",
        json!({"password": "test123", "certify": 2, "fieldLock": {"action": "All"}, "time": NOW}),
        vec![p12],
    );
    assert_eq!(r.json["next"], "done");
    let v = call(
        &mut d,
        "sign.verify",
        json!({"now": NOW}),
        vec![read("root.pem")],
    );
    assert_eq!(v.json["signatures"][0]["kind"], "certification");
    assert_eq!(v.json["signatures"][0]["certification"], 2);
    assert_eq!(v.json["signatures"][0]["locks"][0]["action"], "All");
}

fn has_openssl() -> bool {
    Command::new("openssl")
        .arg("version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn tsa(dir: &Path, req: &[u8]) -> Vec<u8> {
    std::fs::write(dir.join("req.tsq"), req).unwrap();
    std::fs::copy(pki("tsa.cnf"), dir.join("tsa.cnf")).unwrap();
    if !dir.join("tsaserial").exists() {
        std::fs::write(dir.join("tsaserial"), "01\n").unwrap();
    }
    let o = Command::new("openssl")
        .current_dir(dir)
        .args([
            "ts",
            "-reply",
            "-config",
            "tsa.cnf",
            "-queryfile",
            "req.tsq",
            "-out",
            "resp.tsr",
        ])
        .arg("-inkey")
        .arg(pki("tsa.key"))
        .arg("-signer")
        .arg(pki("tsa.pem"))
        .arg("-chain")
        .arg(pki("root.pem"))
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    std::fs::read(dir.join("resp.tsr")).unwrap()
}

fn ocsp(dir: &Path, req: &[u8]) -> Vec<u8> {
    std::fs::write(dir.join("o.req"), req).unwrap();
    let o = Command::new("openssl")
        .args(["ocsp", "-ndays", "3650"])
        .arg("-index")
        .arg(pki("int/index.txt"))
        .arg("-CA")
        .arg(pki("int.pem"))
        .arg("-rsigner")
        .arg(pki("ocsp.pem"))
        .arg("-rkey")
        .arg(pki("ocsp.key"))
        .arg("-reqin")
        .arg(dir.join("o.req"))
        .arg("-respout")
        .arg(dir.join("o.resp"))
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    std::fs::read(dir.join("o.resp")).unwrap()
}

#[test]
fn b_lta_flow_through_the_rpc() {
    if !has_openssl() {
        eprintln!("openssl not found: skipping");
        return;
    }
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("sign_rpc_lta");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut d = doc();
    let r = call(
        &mut d,
        "sign.prepare",
        json!({"password": "test123", "level": "B-LTA", "time": NOW}),
        vec![read("signer-rsa-modern.p12")],
    );
    assert_eq!(r.json["next"], "timestamp");
    let req = r.blobs[r.json["tsaRequestBlob"].as_u64().unwrap() as usize].clone();
    let f = call(&mut d, "sign.finish", json!({}), vec![tsa(&dir, &req)]);
    assert_eq!(f.json["completed"], "signatureTimestamp");
    assert_eq!(f.json["authority"], "ZOOD Test TSA");

    let rr = call(&mut d, "sign.revocationRequests", json!({}), vec![]);
    let reqs = rr.json["requests"].as_array().unwrap();
    assert!(reqs.len() >= 2, "{}", rr.json);
    let mut blobs = Vec::new();
    let mut kinds = Vec::new();
    // OCSP for the signer only (the test responder serves the intermediate's children).
    let first = &reqs[0];
    assert_eq!(first["ocspUrls"][0], "http://ocsp.test.invalid/");
    let oreq = &rr.blobs[first["ocspRequestBlob"].as_u64().unwrap() as usize];
    blobs.push(ocsp(&dir, oreq));
    kinds.push("ocsp");
    for i in rr.json["certificateBlobs"].as_array().unwrap() {
        blobs.push(rr.blobs[i.as_u64().unwrap() as usize].clone());
        kinds.push("cert");
    }
    blobs.push(read("int.crl"));
    kinds.push("crl");
    let a = call(
        &mut d,
        "sign.addDss",
        json!({"kinds": kinds, "docTimestamp": true}),
        blobs,
    );
    assert_eq!(a.json["next"], "timestamp");
    let f = call(
        &mut d,
        "sign.finish",
        json!({}),
        vec![tsa(&dir, &a.blobs[1])],
    );
    assert_eq!(f.json["completed"], "documentTimestamp");
    let v = call(
        &mut d,
        "sign.verify",
        json!({"now": NOW}),
        vec![read("root.pem")],
    );
    let sigs = v.json["signatures"].as_array().unwrap();
    assert_eq!(sigs.len(), 2);
    assert_eq!(sigs[0]["level"], "B-LTA", "{}", sigs[0]);
    assert_eq!(sigs[0]["status"], "valid");
    assert_eq!(sigs[0]["revocation"], "good (OCSP)");
    assert_eq!(sigs[1]["kind"], "documentTimestamp");
    assert_eq!(sigs[1]["status"], "valid");
    assert_eq!(
        call(&mut d, "doc.info", json!({}), vec![]).json["revisions"],
        4
    );
}

#[test]
fn visible_signature_with_ui_lines_and_a_hand_drawn_image() {
    let mut d = doc();
    // 4×2 RGBA "ink": opaque dark pixels on transparent.
    let mut rgba = Vec::new();
    for i in 0..8 {
        rgba.extend_from_slice(if i % 2 == 0 {
            &[10, 20, 60, 255]
        } else {
            &[0, 0, 0, 0]
        });
    }
    let r = call(
        &mut d,
        "sign.prepare",
        json!({
            "password": "test123", "page": 0, "rect": [300, 60, 560, 150], "time": NOW,
            "appearance": {"lines": ["أحمد بن سعيد", "التاريخ: ٢٦/٠٩/٢٠٢٦"], "image": {"width": 4, "height": 2}}
        }),
        vec![read("signer-p256-modern.p12"), rgba.clone()],
    );
    let bytes = &r.blobs[0];
    let text = String::from_utf8_lossy(bytes);
    assert!(text.contains("/Subtype /Image"), "image XObject written");
    assert!(text.contains("/SMask"), "alpha kept as a soft mask");
    let v = call(&mut d, "sign.verify", json!({"now": NOW}), vec![]);
    assert_eq!(v.json["signatures"][0]["status"], "valid_identity_unknown");
    // Wrong image size.
    let mut d = doc();
    let e = err(
        &mut d,
        "sign.prepare",
        json!({"password": "test123", "page": 0, "rect": [300, 60, 560, 150],
               "appearance": {"image": {"width": 5, "height": 2}}}),
        vec![read("signer-p256-modern.p12"), rgba],
    );
    assert_eq!(e.code, "invalid_argument");
}

#[test]
fn inspect_summarises_a_pkcs12_without_signing() {
    let inspect = |pw: &str, file: &str| {
        warraq_core::call_static(
            "sign.inspect",
            &json!({"password": pw, "now": NOW}),
            vec![read(file)],
        )
    };
    let r = inspect("test123", "signer-p256-modern.p12").unwrap();
    let s = &r.json["signer"];
    assert_eq!(s["name"], "أحمد بن سعيد");
    assert!(s["subject"].as_str().unwrap().contains("أحمد بن سعيد"));
    assert!(s["issuer"]
        .as_str()
        .unwrap()
        .contains("ZOOD Test Document CA"));
    assert_eq!(s["keyAlgorithm"], "ECDSA P-256");
    assert_eq!(s["notBefore"], "2025-01-01T00:00:00Z");
    assert_eq!(r.json["eku"]["accepted"], true);
    assert_eq!(r.json["validNow"], true);
    assert_eq!(r.json["canSign"], true);
    assert_eq!(r.json["chain"][0], "ZOOD Test Document CA");
    assert!(r.blobs.is_empty(), "no key material leaves the engine");

    // serverAuth-only: summarised, but flagged.
    let r = inspect("test123", "signer-server.p12").unwrap();
    assert_eq!(r.json["eku"]["accepted"], false);
    assert!(r.json["eku"]["detail"]
        .as_str()
        .unwrap()
        .contains("serverAuth"));
    assert_eq!(r.json["canSign"], false);
    // Expired.
    let r = inspect("test123", "signer-expired.p12").unwrap();
    assert_eq!(r.json["validNow"], false);
    assert_eq!(r.json["canSign"], false);
    // Arabic password.
    let r = inspect("كلمة سر", "signer-p256-arabic-pw.p12").unwrap();
    assert_eq!(r.json["signer"]["name"], "أحمد بن سعيد");
    // Wrong password, missing blob.
    let e = inspect("nope", "signer-rsa-modern.p12").unwrap_err();
    assert_eq!(e.code, "wrong_certificate_password");
    let e = warraq_core::call_static("sign.inspect", &json!({}), vec![]).unwrap_err();
    assert_eq!(e.code, "invalid_params");
}

#[test]
fn cert_info_reads_pem_and_der_for_the_trust_list() {
    let r = warraq_core::call_static("sign.certInfo", &json!({}), vec![read("chain.pem")]).unwrap();
    let certs = r.json["certificates"].as_array().unwrap();
    assert_eq!(certs.len(), 2);
    assert_eq!(certs[0]["name"], "ZOOD Test Document CA");
    assert_eq!(certs[0]["isCa"], true);
    assert_eq!(certs[1]["selfIssued"], true);
    assert_eq!(certs[1]["sha256"].as_str().unwrap().len(), 64);
    assert_eq!(r.blobs.len(), 2, "one DER blob per certificate");
    assert_eq!(r.blobs[1], read("root.der"));
    let r = warraq_core::call_static("sign.certInfo", &json!({}), vec![read("root.der")]).unwrap();
    assert_eq!(r.json["certificates"][0]["name"], "ZOOD Test Root CA");
    let e = warraq_core::call_static("sign.certInfo", &json!({}), vec![b"garbage".to_vec()])
        .unwrap_err();
    assert_ne!(e.code, "");
}
