//! Cross-check with an independent PDF signature validator: pyHanko (MIT, test-only).
//! Skipped when python3 cannot import pyhanko (set `WARRAQ_PYTHON` to a venv interpreter).
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
use warraq_sign::sign::{
    add_dss, finish, prepare_doc_timestamp, sign, DocTimestampOptions, DssMaterial, Level,
    SignOptions,
};
use warraq_sign::{Signer, SoftwareSigner};

const NOW: i64 = 1_790_358_029;

fn signer(n: &str) -> SoftwareSigner {
    SoftwareSigner::from_pkcs12(&read_pki(n), PW).unwrap()
}

#[test]
fn pyhanko_validates_our_signatures() {
    let Some(py) = pyhanko_python() else {
        eprintln!("pyhanko not importable: skipping (set WARRAQ_PYTHON)");
        return;
    };
    let dir = scratch("pyhanko");
    let doc = sample_pdf(2, &SampleOptions::default()).unwrap();
    let mut cases: Vec<(&str, Vec<u8>, Option<&str>)> = Vec::new();
    // RSA invisible, P-256 visible Arabic, P-384, certification P=2.
    let b = sign(
        &Pdf::open(doc.clone(), None).unwrap(),
        &signer("signer-rsa-legacy.p12"),
        &SignOptions {
            time: NOW,
            reason: Some("Approval".into()),
            ..Default::default()
        },
    )
    .unwrap()
    .bytes;
    cases.push(("rsa.pdf", b, None));
    let b = sign(
        &Pdf::open(doc.clone(), None).unwrap(),
        &signer("signer-p256-modern.p12"),
        &SignOptions {
            rect: Some([300.0, 80.0, 540.0, 160.0]),
            reason: Some("موافقة".into()),
            location: Some("الرياض".into()),
            appearance: Some(AppearanceSpec::default()),
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap()
    .bytes;
    cases.push(("p256-visible.pdf", b, None));
    let b = sign(
        &Pdf::open(doc.clone(), None).unwrap(),
        &signer("signer-p384-modern.p12"),
        &SignOptions {
            time: NOW,
            certify: Some(2),
            ..Default::default()
        },
    )
    .unwrap()
    .bytes;
    cases.push(("p384-certified.pdf", b.clone(), None));
    // Two signatures.
    let b2 = sign(
        &Pdf::open(b, None).unwrap(),
        &signer("signer-rsa-modern.p12"),
        &SignOptions {
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap()
    .bytes;
    cases.push(("two.pdf", b2, None));
    // Encrypted (AES-256).
    let h = SecurityHandler::new_aes256("pw", "owner", &PermissionFlags::all()).unwrap();
    let enc = sample_pdf(
        1,
        &SampleOptions {
            security: Some(h),
            ..Default::default()
        },
    )
    .unwrap();
    let b = sign(
        &Pdf::open(enc, Some("pw")).unwrap(),
        &signer("signer-rsa-modern.p12"),
        &SignOptions {
            time: NOW,
            reason: Some("encrypted".into()),
            ..Default::default()
        },
    )
    .unwrap()
    .bytes;
    cases.push(("encrypted.pdf", b, Some("pw")));
    for (name, bytes, pw) in &cases {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        let res = pyhanko_check(&py, &path, *pw);
        assert!(!res.is_empty(), "{name}: no signature found by pyHanko");
        for r in &res {
            assert!(r.get("error").is_none(), "{name}: {r}");
            assert_eq!(r["intact"], true, "{name}: {r}");
            assert_eq!(r["valid"], true, "{name}: {r}");
            assert_eq!(r["trusted"], true, "{name}: {r}");
        }
    }
    // The last of "two.pdf" covers the whole file; the first reports allowed changes only.
    let res = pyhanko_check(&py, &dir.join("two.pdf"), None);
    assert!(
        res[1]["coverage"].as_str().unwrap().contains("ENTIRE_FILE"),
        "{}",
        res[1]
    );
    assert_eq!(res[0]["docmdp_ok"], true, "{}", res[0]);

    // B-LTA, with openssl as TSA/OCSP.
    if has_openssl() {
        let s = signer("signer-p256-modern.p12");
        let out = sign(
            &Pdf::open(doc.clone(), None).unwrap(),
            &s,
            &SignOptions {
                level: Level::BLTA,
                time: NOW,
                ..Default::default()
            },
        )
        .unwrap();
        let resp = tsa_reply(&dir, &out.tsa_request.unwrap().der);
        let (bt, _, _) = finish(&Pdf::open(out.bytes, None).unwrap(), &resp).unwrap();
        let mut chain = vec![s.certificate().clone()];
        chain.extend(s.chain().iter().cloned());
        let reqs = warraq_sign::ocsp::requests_for_chain(&chain);
        let ocsp = ocsp_reply(&dir, reqs[0].ocsp_request.as_ref().unwrap());
        let lt = add_dss(
            &Pdf::open(bt, None).unwrap(),
            &DssMaterial {
                certs: chain.iter().map(|c| c.der.clone()).collect(),
                ocsps: vec![ocsp],
                crls: vec![read_pki("int.crl")],
            },
        )
        .unwrap();
        let prep = prepare_doc_timestamp(
            &Pdf::open(lt, None).unwrap(),
            &DocTimestampOptions::default(),
        )
        .unwrap();
        let resp = tsa_reply(&dir, &prep.tsa_request.unwrap().der);
        let (lta, _, _) = finish(&Pdf::open(prep.bytes, None).unwrap(), &resp).unwrap();
        let path = dir.join("lta.pdf");
        std::fs::write(&path, &lta).unwrap();
        let res = pyhanko_check(&py, &path, None);
        assert_eq!(res.len(), 2, "{res:?}");
        for r in &res {
            assert!(r.get("error").is_none(), "lta: {r}");
            assert_eq!(r["intact"], true, "lta: {r}");
            assert_eq!(r["valid"], true, "lta: {r}");
        }
        assert_eq!(
            res[0]["timestamp"], "True",
            "signature timestamp seen by pyHanko: {}",
            res[0]
        );
    }

    // pyHanko also flags our attack fixtures.
    for name in [
        "shadow-replace.pdf",
        "borrowed-signature.pdf",
        "wrapped-byterange.pdf",
    ] {
        let res = pyhanko_check(&py, &fixture("attacks").join(name), None);
        let bad = res.iter().any(|r| {
            r.get("error").is_some()
                || r["intact"] != true
                || r["valid"] != true
                || r["docmdp_ok"] == false
                || r["coverage"]
                    .as_str()
                    .is_some_and(|c| !c.contains("ENTIRE"))
                    && r["modification_level"]
                        .as_str()
                        .is_some_and(|m| !m.contains("NONE") && !m.contains("LTA_UPDATES"))
        });
        eprintln!("pyhanko on {name}: {res:?}");
        assert!(bad, "pyHanko accepted {name} without complaint: {res:?}");
    }
}
