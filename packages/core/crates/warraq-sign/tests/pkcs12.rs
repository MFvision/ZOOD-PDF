#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod common;
use common::*;
use warraq_sign::keys::KeyAlgorithm;
use warraq_sign::{HashAlg, Signer, SoftwareSigner};

fn load(name: &str, pw: &str) -> warraq_sign::Result<SoftwareSigner> {
    SoftwareSigner::from_pkcs12(&read_pki(name), pw)
}

#[test]
fn modern_pbes2_aes_files_load() {
    let s = load("signer-rsa-modern.p12", PW).unwrap();
    assert_eq!(s.key_algorithm(), KeyAlgorithm::Rsa(2048));
    assert_eq!(s.certificate().display_name(), "Test Signer RSA");
    assert_eq!(s.chain().len(), 2, "intermediate + root");
    let s = load("signer-p256-modern.p12", PW).unwrap();
    assert_eq!(s.key_algorithm(), KeyAlgorithm::EcP256);
    assert_eq!(s.certificate().display_name(), "أحمد بن سعيد");
    let s = load("signer-p384-modern.p12", PW).unwrap();
    assert_eq!(s.key_algorithm(), KeyAlgorithm::EcP384);
    assert_eq!(s.digest_algorithm(), HashAlg::Sha384);
}

#[test]
fn legacy_3des_and_rc2_files_load() {
    for f in [
        "signer-rsa-legacy.p12",
        "signer-rsa-3des.p12",
        "signer-rsa-rc2.p12",
        "signer-p256-legacy.p12",
    ] {
        let s = load(f, PW).unwrap_or_else(|e| panic!("{f}: {e}"));
        assert!(!s.chain().is_empty(), "{f}");
    }
}

#[test]
fn arabic_password_and_wrong_passwords() {
    load("signer-p256-arabic-pw.p12", "كلمة سر").unwrap();
    for f in [
        "signer-rsa-modern.p12",
        "signer-rsa-legacy.p12",
        "signer-p256-arabic-pw.p12",
    ] {
        let e = load(f, "wrong").unwrap_err();
        assert_eq!(e.code(), "wrong_certificate_password", "{f}");
    }
}

#[test]
fn signatures_verify_with_the_certificate_key() {
    for f in [
        "signer-rsa-modern.p12",
        "signer-p256-legacy.p12",
        "signer-p384-modern.p12",
    ] {
        let s = load(f, PW).unwrap();
        let h = s.digest_algorithm();
        let d = h.digest(b"hello");
        let sig = s.sign_digest(h, &d).unwrap();
        let alg = s.key_algorithm().signature_algorithm(h).unwrap();
        warraq_sign::keys::verify_prehash(s.certificate().spki(), &alg, h, &d, &sig).unwrap();
        let mut bad = d.clone();
        bad[0] ^= 1;
        assert!(
            warraq_sign::keys::verify_prehash(s.certificate().spki(), &alg, h, &bad, &sig).is_err()
        );
    }
}

#[test]
fn hostile_pkcs12_inputs_error_without_panic() {
    let good = read_pki("signer-rsa-legacy.p12");
    for cut in [0, 1, 10, 100, good.len() / 2, good.len() - 1] {
        assert!(SoftwareSigner::from_pkcs12(&good[..cut], PW).is_err());
    }
    let mut seed = 0x1234_5678u32;
    for i in 0..300 {
        let mut m = good.clone();
        for _ in 0..(1 + i % 4) {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
            let pos = (seed as usize) % m.len();
            m[pos] = (seed >> 16) as u8;
        }
        let _ = SoftwareSigner::from_pkcs12(&m, PW);
    }
    assert!(SoftwareSigner::from_pkcs12(b"not a p12", PW).is_err());
}
