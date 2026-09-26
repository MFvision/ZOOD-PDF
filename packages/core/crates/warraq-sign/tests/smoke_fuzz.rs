//! Stable-toolchain smoke fuzz: mutated signed PDFs, CMS blobs, timestamp and OCSP responses
//! and PKCS#12 files must never panic and must finish in bounded time. (The cargo-fuzz
//! targets `cms` and `sig_dict` in packages/core/fuzz cover the same code with coverage
//! guidance.) `WARRAQ_SMOKE_CASES` changes the number of cases per seed.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod common;
use common::*;
use warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_pdf::{Limits, Pdf};
use warraq_sign::sign::{sign, signature_slots, SignOptions};
use warraq_sign::verify::{list_fields, verify, VerifyOptions};
use warraq_sign::SoftwareSigner;

const NOW: i64 = 1_790_358_029;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

fn cases() -> usize {
    std::env::var("WARRAQ_SMOKE_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(150)
}

fn mutate(r: &mut Rng, seed: &[u8], hot: &[usize]) -> Vec<u8> {
    let mut m = seed.to_vec();
    match r.below(6) {
        0 => {
            let cut = r.below(m.len());
            m.truncate(cut);
        }
        1 => {
            // Digits near a hot spot (ByteRange values, lengths).
            if let Some(&h) = hot.get(r.below(hot.len())) {
                for _ in 0..1 + r.below(4) {
                    let p = (h + r.below(64)).min(m.len().saturating_sub(1));
                    m[p] = b"0123456789 []<>"[r.below(15)];
                }
            }
        }
        2 => {
            let p = r.below(m.len());
            let junk: Vec<u8> = (0..r.below(200)).map(|_| r.next() as u8).collect();
            m.splice(p..p, junk);
        }
        _ => {
            for _ in 0..1 + r.below(8) {
                let p = r.below(m.len());
                m[p] = r.next() as u8;
            }
        }
    }
    m
}

fn positions(hay: &[u8], needle: &[u8]) -> Vec<usize> {
    hay.windows(needle.len())
        .enumerate()
        .filter(|(_, w)| *w == needle)
        .map(|(i, _)| i)
        .collect()
}

#[test]
fn mutated_signed_documents_never_panic() {
    let s = SoftwareSigner::from_pkcs12(&read_pki("signer-p256-modern.p12"), PW).unwrap();
    let base = sample_pdf(1, &SampleOptions::default()).unwrap();
    let signed = sign(
        &Pdf::open(base.clone(), None).unwrap(),
        &s,
        &SignOptions {
            rect: Some([50.0, 50.0, 250.0, 110.0]),
            certify: Some(2),
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap()
    .bytes;
    let two = sign(
        &Pdf::open(signed.clone(), None).unwrap(),
        &s,
        &SignOptions {
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap()
    .bytes;
    let mut seeds = vec![signed, two];
    for f in [
        "shadow-replace.pdf",
        "shadow-hide-xref.pdf",
        "borrowed-signature.pdf",
        "wrapped-byterange.pdf",
    ] {
        seeds.push(std::fs::read(fixture("attacks").join(f)).unwrap());
    }
    let limits = Limits {
        max_objects: 50_000,
        max_decode_size: 16 << 20,
        ..Limits::default()
    };
    let opts = VerifyOptions {
        trusted_roots: vec![],
        now: NOW,
    };
    let mut r = Rng(0x9E37_79B9_7F4A_7C15);
    let t0 = std::time::Instant::now();
    let mut opened = 0;
    for seed in &seeds {
        let mut hot = positions(seed, b"/ByteRange");
        hot.extend(positions(seed, b"/Contents"));
        hot.extend(positions(seed, b"startxref"));
        for _ in 0..cases() {
            let m = mutate(&mut r, seed, &hot);
            if let Ok(pdf) = Pdf::open_with_limits(m, None, limits) {
                opened += 1;
                let _ = list_fields(&pdf);
                let _ = verify(&pdf, &opts);
                let _ = warraq_sign::sign::finish(&pdf, b"\x30\x03\x02\x01\x00");
            }
        }
    }
    assert!(opened > 0);
    eprintln!("{} documents in {:?}", opened, t0.elapsed());
}

#[test]
fn mutated_cms_and_responses_never_panic() {
    let s = SoftwareSigner::from_pkcs12(&read_pki("signer-rsa-modern.p12"), PW).unwrap();
    let signed = sign(
        &Pdf::open(sample_pdf(1, &SampleOptions::default()).unwrap(), None).unwrap(),
        &s,
        &SignOptions {
            time: NOW,
            ..Default::default()
        },
    )
    .unwrap()
    .bytes;
    let slot = signature_slots(&Pdf::open(signed, None).unwrap())
        .pop()
        .unwrap();
    let n = warraq_sign::tlv::element_len(&slot.contents).unwrap();
    let cms = slot.contents[..n].to_vec();
    let seeds = vec![
        cms,
        read_pki("int.crl"),
        read_pki("root.der"),
        read_pki("signer-rsa-legacy.p12"),
        read_pki("signer-p256-modern.p12"),
    ];
    let mut r = Rng(0xD1B5_4A32_D192_ED03);
    for seed in &seeds {
        for _ in 0..cases() * 2 {
            let m = mutate(&mut r, seed, &[0, 4, 8, 16, 32]);
            if let Ok(p) = warraq_sign::cms::ParsedCms::parse(&m) {
                let _ = warraq_sign::cms::verify_signer(&p, &|h| h.digest(b"x"));
            }
            let _ = warraq_sign::tsp::token_from_response(&m);
            let _ = warraq_sign::tsp::verify_token(&m, &|h| h.digest(b"x"), &[], &[]);
            let _ = warraq_sign::ocsp::parse_response(&m);
            let _ = warraq_sign::ocsp::parse_crl(&m);
            let _ = warraq_sign::x509::Cert::from_pem_or_der(&m);
            let _ = warraq_sign::tlv::ber_to_der(&m);
            let _ = warraq_sign::pkcs12::load(&m, PW);
        }
    }
}
