//! Smoke fuzz for the Organize / Combine / Compress methods: mutated and truncated documents
//! (with bookmarks, pictures, labels) go through boxes, trim, split, combine, merge and
//! compress. Passes when nothing panics and every case finishes in bounded time.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use serde_json::json;
use std::time::{Duration, Instant};
use warraq_core::ops::image::{jpeg_encode, Raster};
use warraq_core::warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_core::warraq_pdf::outline::{self, text_string, Dest, NewItem};
use warraq_core::warraq_pdf::{pages, Pdf};
use warraq_core::{call_static, Document};

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
    b"/",
    b"999999 0 R",
    b"1 0 R",
    b"/Length 99999999",
    b"/Width 65535",
    b"/Height 0",
    b"/Filter /DCTDecode",
    b"/SMask 1 0 R",
    b"/First 1 0 R",
    b"/Next 1 0 R",
    b"/Dest [1 0 R /XYZ]",
    b"/Nums [0 1 0 R]",
    b"cm",
    b"Do",
    b"q",
    b"Q",
    b"re f",
    b"1e308",
    b"-1e308",
    b"/Kids [1 0 R]",
    b"endstream",
    b"endobj",
];

fn seed() -> Vec<u8> {
    let mut d = Document::open(
        sample_pdf(
            3,
            &SampleOptions {
                compress: false,
                ..Default::default()
            },
        )
        .unwrap(),
        None,
    )
    .unwrap();
    let mut px = Vec::new();
    for i in 0..(64 * 48) {
        px.extend_from_slice(&[(i % 251) as u8, (i % 199) as u8, 30]);
    }
    let jpeg = jpeg_encode(
        &Raster {
            width: 64,
            height: 48,
            channels: 3,
            pixels: px,
        },
        80,
    )
    .unwrap();
    let r = d
        .call("pages.insertImage", &json!({"at": 1}), vec![jpeg])
        .unwrap();
    let mut pdf = Pdf::open(r.blobs[0].clone(), None).unwrap();
    let list = pages::flatten(&pdf).unwrap();
    let items: Vec<NewItem> = list
        .iter()
        .map(|p| NewItem {
            title: text_string("b"),
            dest: Some(Dest {
                page: p.id,
                view: vec![],
            }),
            children: vec![],
        })
        .collect();
    outline::append_outline(&mut pdf, &items).unwrap();
    pdf.commit().unwrap()
}

fn mutate(rng: &mut Rng, base: &[u8]) -> Vec<u8> {
    let mut b = base.to_vec();
    match rng.below(4) {
        0 => b.truncate(rng.below(b.len())),
        1 => {
            for _ in 0..1 + rng.below(8) {
                let i = rng.below(b.len());
                b[i] = rng.next() as u8;
            }
        }
        _ => {
            for _ in 0..1 + rng.below(4) {
                let i = rng.below(b.len());
                let t = TOKENS[rng.below(TOKENS.len())];
                let end = (i + t.len()).min(b.len());
                b.splice(i..end, t.iter().copied());
            }
        }
    }
    b
}

#[test]
fn organize_methods_survive_hostile_documents() {
    let base = seed();
    let cases: usize = std::env::var("WARRAQ_SMOKE_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(600);
    let mut rng = Rng(0x5eed_0123_4567_89ab);
    let mut opened = 0;
    for _ in 0..cases {
        let bytes = mutate(&mut rng, &base);
        let t0 = Instant::now();
        if let Ok(mut d) = Document::open(bytes.clone(), None) {
            opened += 1;
            let _ = d.call("pages.boxes", &json!({}), vec![]);
            let _ = d.call(
                "pages.trimMargins",
                &json!({"pages": [0, 1, 2, 3], "dryRun": true}),
                vec![],
            );
            let _ = d.call("pages.split", &json!({"bookmarks": true}), vec![]);
            let _ = d.call("pages.split", &json!({"every": 1}), vec![]);
            let _ = d.call("doc.compress", &json!({"preset": "smallest"}), vec![]);
            let _ = d.call("pages.combine", &json!({"at": 1}), vec![bytes.clone()]);
            let _ = d.call("pages.replace", &json!({"page": 0}), vec![bytes.clone()]);
        }
        let _ = call_static(
            "pdf.merge",
            &json!({"titles": ["a", "b"]}),
            vec![bytes.clone(), base.clone()],
        );
        assert!(
            t0.elapsed() < Duration::from_secs(20),
            "case took {:?}",
            t0.elapsed()
        );
    }
    assert!(
        opened > cases / 4,
        "only {opened} of {cases} mutated files opened"
    );
}
