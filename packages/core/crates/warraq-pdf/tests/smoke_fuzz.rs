//! Cheap, deterministic, stable-toolchain "smoke fuzz": ~2000 mutated/truncated versions of
//! the fixtures go through open → flatten → metadata → save → rewrite → rebase. The test
//! passes if nothing panics and every case finishes within a time bound. Real coverage-guided
//! fuzzing lives in `packages/core/fuzz` (cargo-fuzz, nightly).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod common;
use common::*;
use std::time::{Duration, Instant};
use warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_pdf::{metadata, pages, rebase, revisions, Limits, Pdf, Protection};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
}

const TOKENS: &[&[u8]] = &[
    b"<<",
    b">>",
    b"[",
    b"]",
    b"(",
    b")",
    b"<",
    b">",
    b"/",
    b"999999999 0 R",
    b"1 0 R",
    b"/Length 99999999",
    b"/Length -5",
    b"stream\n",
    b"endstream",
    b"endobj",
    b"obj",
    b"/Type /ObjStm",
    b"/Type /Pages",
    b"/Kids [1 0 R]",
    b"/Count 9999999",
    b"xref\n0 999999\n",
    b"trailer",
    b"startxref\n0\n%%EOF\n",
    b"/Filter /FlateDecode",
    b"/Prev 0",
    b"/Encrypt",
    b"%%EOF",
    b"\\",
    b"#",
    b"-0.0e99999",
    b"/W [9 9 9]",
];

fn mutate(rng: &mut Rng, seed: &[u8]) -> Vec<u8> {
    let mut v = seed.to_vec();
    let rounds = 1 + rng.below(4);
    for _ in 0..rounds {
        let len = v.len().max(1);
        match rng.below(6) {
            0 => {
                for _ in 0..1 + rng.below(8) {
                    let i = rng.below(v.len());
                    if let Some(b) = v.get_mut(i) {
                        *b ^= 1 << rng.below(8);
                    }
                }
            }
            1 => v.truncate(rng.below(len)),
            2 => {
                let t = TOKENS[rng.below(TOKENS.len())];
                let i = rng.below(len).min(v.len());
                v.splice(i..i, t.iter().copied());
            }
            3 => {
                let a = rng.below(len).min(v.len());
                let b = (a + rng.below(64)).min(v.len());
                v.drain(a..b);
            }
            4 => {
                let a = rng.below(len).min(v.len());
                let b = (a + rng.below(256)).min(v.len());
                let chunk = v[a..b].to_vec();
                let i = rng.below(len).min(v.len());
                v.splice(i..i, chunk);
            }
            _ => {
                // Replace a number with a huge one.
                if let Some(i) = (0..v.len())
                    .map(|_| rng.below(v.len()))
                    .take(32)
                    .find(|&i| v[i].is_ascii_digit())
                {
                    v.splice(i..i + 1, b"4294967296".iter().copied());
                }
            }
        }
    }
    v
}

fn exercise(bytes: &[u8]) {
    let limits = Limits {
        max_decode_size: 8 << 20,
        decode_ratio_floor: 1 << 20,
        max_objects: 50_000,
        max_pages: 5_000,
        ..Limits::default()
    };
    let _ = revisions::revisions(bytes, &limits);
    for pw in [None, Some("user"), Some("owner")] {
        let Ok(mut pdf) = Pdf::open_with_limits(bytes.to_vec(), pw, limits) else {
            continue;
        };
        let _ = metadata::get_info(&pdf);
        let _ = metadata::get_xmp(&pdf);
        let n = pages::count(&pdf).unwrap_or(0);
        let _ = pdf.write_full(Protection::Keep);
        let _ = rebase::rebase_pdf(&pdf, bytes);
        if n > 0 {
            let _ = pages::rotate(&mut pdf, &[0], 90);
            if n > 1 {
                let _ = pages::reorder(&mut pdf, &(0..n).rev().collect::<Vec<_>>());
            }
            if let Ok(out) = pdf.save_incremental() {
                let _ = Pdf::open_with_limits(out, pw, limits);
            }
        }
    }
}

#[test]
fn mutated_fixtures_never_panic_and_finish_quickly() {
    let mut seeds = vec![
        sample_pdf(
            3,
            &SampleOptions {
                with_annotation: true,
                ..Default::default()
            },
        )
        .unwrap(),
        sample_pdf(
            2,
            &SampleOptions {
                xref_stream: true,
                compress: true,
                ..Default::default()
            },
        )
        .unwrap(),
    ];
    for f in [
        "plain_objstm.pdf",
        "qpdf_r4_aes_objstm.pdf",
        "qpdf_r6.pdf",
        "pypdf_rc4_40.pdf",
        "qpdf_r3_rc4_128.pdf",
    ] {
        seeds.push(fixture(f));
    }
    let cases: usize = std::env::var("WARRAQ_SMOKE_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2000);
    let mut rng = Rng(0x5eed_2026_0925);
    let start = Instant::now();
    let mut slowest = Duration::ZERO;
    for case in 0..cases {
        let seed = &seeds[case % seeds.len()];
        let m = mutate(&mut rng, seed);
        let t = Instant::now();
        exercise(&m);
        let el = t.elapsed();
        slowest = slowest.max(el);
        assert!(el < Duration::from_secs(10), "case {case} took {el:?}");
    }
    eprintln!(
        "{cases} cases in {:?}, slowest {:?}",
        start.elapsed(),
        slowest
    );
}
