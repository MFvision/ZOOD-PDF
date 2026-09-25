//! B-T, B-LT and B-LTA with a local test TSA and OCSP responder driven through the OpenSSL
//! CLI (`openssl ts -reply`, `openssl ocsp -respout`). Skipped when openssl is absent.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod common;
use common::*;
use std::process::Command;
use warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_pdf::Pdf;
use warraq_sign::sign::{
    add_dss, finish, prepare_doc_timestamp, sign, DocTimestampOptions, DssMaterial, Finished,
    Level, SignOptions,
};
use warraq_sign::verify::{verify, VerifyOptions};
use warraq_sign::x509::Cert;
use warraq_sign::{Signer, SoftwareSigner};

const NOW: i64 = 1_790_358_029;

fn trusting() -> VerifyOptions {
    VerifyOptions {
        trusted_roots: Cert::from_pem_or_der(&read_pki("root.pem")).unwrap(),
        now: NOW,
    }
}

#[test]
fn b_t_then_b_lt_then_b_lta() {
    if !has_openssl() {
        eprintln!("openssl not found: skipping");
        return;
    }
    let dir = scratch("b_lta");
    let s = SoftwareSigner::from_pkcs12(&read_pki("signer-p256-modern.p12"), PW).unwrap();
    let original = sample_pdf(1, &SampleOptions::default()).unwrap();
    let pdf = Pdf::open(original.clone(), None).unwrap();
    let out = sign(
        &pdf,
        &s,
        &SignOptions {
            level: Level::BLTA,
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap();
    let req = out.tsa_request.clone().unwrap();

    // A response for other data is rejected.
    let other = warraq_sign::tsp::build_request(warraq_sign::HashAlg::Sha256, &[7u8; 32]).unwrap();
    let wrong = tsa_reply(&dir, &other.der);
    let pdf = Pdf::open(out.bytes.clone(), None).unwrap();
    assert_eq!(
        finish(&pdf, &wrong).unwrap_err().code(),
        "timestamp_rejected"
    );
    assert!(finish(&pdf, b"garbage").is_err());

    // B-T.
    let resp = tsa_reply(&dir, &req.der);
    let (bt, what, check) = finish(&pdf, &resp).unwrap();
    assert!(matches!(what, Finished::SignatureTimestamp { .. }));
    assert!(check.valid);
    assert_eq!(bt.len(), out.bytes.len(), "timestamp is written in place");
    assert!(bt.starts_with(&original));
    let r = &verify(&Pdf::open(bt.clone(), None).unwrap(), &trusting()).unwrap()[0];
    assert_eq!(r.status, "valid", "{r:#?}");
    assert_eq!(r.level, "B-T");
    let ts = r.timestamp.as_ref().unwrap();
    assert!(ts.valid && ts.trusted, "{ts:?}");
    assert_eq!(ts.authority.as_deref(), Some("ZOOD Test TSA"));
    // Untrusted user roots: the TSA is not a web-PKI root either.
    let r = &verify(
        &Pdf::open(bt.clone(), None).unwrap(),
        &VerifyOptions {
            trusted_roots: vec![],
            now: NOW,
        },
    )
    .unwrap()[0];
    assert!(r.timestamp.as_ref().unwrap().valid);
    assert!(!r.timestamp.as_ref().unwrap().trusted);

    // B-LT: OCSP for the signer (from the chain in the CMS), CRL, certificates.
    let mut chain = vec![s.certificate().clone()];
    chain.extend(s.chain().iter().cloned());
    let reqs = warraq_sign::ocsp::requests_for_chain(&chain);
    assert_eq!(reqs.len(), 2, "signer + intermediate (root is self-signed)");
    assert_eq!(
        reqs[0].ocsp_urls,
        vec!["http://ocsp.test.invalid/".to_string()]
    );
    assert_eq!(
        reqs[0].crl_urls,
        vec!["http://crl.test.invalid/int.crl".to_string()]
    );
    let ocsp = ocsp_reply(&dir, reqs[0].ocsp_request.as_ref().unwrap());
    let m = DssMaterial {
        certs: chain
            .iter()
            .map(|c| c.der.clone())
            .chain(
                [read_pki("ocsp.pem")]
                    .into_iter()
                    .filter_map(|p| Cert::from_pem_or_der(&p).ok())
                    .flatten()
                    .map(|c| c.der),
            )
            .collect(),
        ocsps: vec![ocsp],
        crls: vec![read_pki("int.crl")],
    };
    let lt = add_dss(&Pdf::open(bt.clone(), None).unwrap(), &m).unwrap();
    assert!(lt.starts_with(&bt));
    let text = String::from_utf8_lossy(&lt[bt.len()..]).to_string();
    assert!(text.contains("/DSS") && text.contains("/VRI") && text.contains("/OCSPs"));
    let r = &verify(&Pdf::open(lt.clone(), None).unwrap(), &trusting()).unwrap()[0];
    assert_eq!(r.status, "valid", "{r:#?}");
    assert_eq!(r.revocation, "good (OCSP)");
    assert_eq!(r.level, "B-LT");
    assert!(
        r.modifications.iter().all(|m| m.allowed),
        "{:?}",
        r.modifications
    );

    // B-LTA: document timestamp over everything.
    let prep = prepare_doc_timestamp(
        &Pdf::open(lt.clone(), None).unwrap(),
        &DocTimestampOptions::default(),
    )
    .unwrap();
    assert!(prep.bytes.starts_with(&lt));
    let resp = tsa_reply(&dir, &prep.tsa_request.as_ref().unwrap().der);
    let (lta, what, _) = finish(&Pdf::open(prep.bytes.clone(), None).unwrap(), &resp).unwrap();
    assert!(matches!(what, Finished::DocumentTimestamp { .. }));
    let rs = verify(&Pdf::open(lta.clone(), None).unwrap(), &trusting()).unwrap();
    assert_eq!(rs.len(), 2);
    assert_eq!(rs[0].level, "B-LTA", "{:#?}", rs[0]);
    assert_eq!(rs[0].status, "valid");
    assert_eq!(rs[1].kind, "documentTimestamp");
    assert_eq!(rs[1].status, "valid", "{:#?}", rs[1]);
    assert!(rs[0]
        .modifications
        .iter()
        .any(|m| m.kind == "document_timestamp_added" && m.allowed));
    std::fs::write(dir.join("lta.pdf"), &lta).unwrap();
    // Independent check of the document timestamp token with openssl ts -verify.
    let slot = warraq_sign::sign::signature_slots(&Pdf::open(lta.clone(), None).unwrap())
        .pop()
        .unwrap();
    let r = slot.range;
    let mut data = lta[..r[1]].to_vec();
    data.extend_from_slice(&lta[r[2]..r[2] + r[3]]);
    let n = warraq_sign::tlv::element_len(&slot.contents).unwrap();
    std::fs::write(dir.join("token.der"), &slot.contents[..n]).unwrap();
    std::fs::write(dir.join("data.bin"), &data).unwrap();
    let ok = Command::new("openssl")
        .args(["ts", "-verify", "-token_in"])
        .arg("-in")
        .arg(dir.join("token.der"))
        .arg("-data")
        .arg(dir.join("data.bin"))
        .arg("-CAfile")
        .arg(pki("root.pem"))
        .output()
        .unwrap();
    assert!(
        ok.status.success(),
        "openssl ts -verify: {}",
        String::from_utf8_lossy(&ok.stderr)
    );
}

struct OpensslTsa(std::path::PathBuf);
impl warraq_sign::tsp::TsaClient for OpensslTsa {
    fn timestamp(&self, req: &[u8]) -> warraq_sign::Result<Vec<u8>> {
        Ok(tsa_reply(&self.0, req))
    }
}

#[test]
fn tsa_client_trait_signs_b_t_in_one_call() {
    if !has_openssl() {
        return;
    }
    let dir = scratch("tsa_client");
    let s = SoftwareSigner::from_pkcs12(&read_pki("signer-p384-modern.p12"), PW).unwrap();
    let pdf = Pdf::open(sample_pdf(1, &SampleOptions::default()).unwrap(), None).unwrap();
    let b = warraq_sign::sign::sign_with_timestamp(
        &pdf,
        &s,
        &SignOptions {
            time: NOW,
            ..Default::default()
        },
        &OpensslTsa(dir),
    )
    .unwrap();
    let r = &verify(&Pdf::open(b, None).unwrap(), &trusting()).unwrap()[0];
    assert_eq!(r.level, "B-T");
    assert_eq!(r.status, "valid", "{r:#?}");
}
