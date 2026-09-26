//! Stable no-panic smoke fuzz: mutated and truncated fixtures (whole files and, for OOXML, the
//! XML parts inside the zip) through every reader, the layout engine and the writer. Must never
//! panic and must finish in bounded time. `WARRAQ_CREATE_SMOKE_CASES` changes the case count.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use std::time::{Duration, Instant};

use warraq_create::readers::zip::{build, Zip};
use warraq_create::{create, CreateOptions, FileSpec};

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../../../../tests/fixtures/create/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

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

fn mutate(rng: &mut Rng, data: &[u8]) -> Vec<u8> {
    let mut d = data.to_vec();
    match rng.below(5) {
        0 => d.truncate(rng.below(d.len() + 1)),
        1 => {
            for _ in 0..1 + rng.below(8) {
                let i = rng.below(d.len());
                if let Some(b) = d.get_mut(i) {
                    *b = rng.next() as u8;
                }
            }
        }
        2 => {
            // Duplicate a slice (deep nesting, repeated tags).
            let a = rng.below(d.len());
            let b = (a + rng.below(200)).min(d.len());
            let chunk = d[a..b].to_vec();
            for _ in 0..rng.below(50) {
                d.splice(a..a, chunk.iter().copied());
            }
        }
        3 => {
            // Replace digits with huge numbers (sizes, spans, counts).
            let s = String::from_utf8_lossy(&d).into_owned();
            let big = [
                "99999999999",
                "-5",
                "0",
                "65535",
                "4294967295",
                "1e308",
                "NaN",
            ][rng.below(7)];
            let mut out = String::new();
            let mut replaced = false;
            for (i, c) in s.chars().enumerate() {
                if c.is_ascii_digit() && !replaced && rng.below(40) == 0 && i > 0 {
                    out.push_str(big);
                    replaced = true;
                } else {
                    out.push(c);
                }
            }
            d = out.into_bytes();
        }
        _ => {
            let i = rng.below(d.len());
            d.insert(i, b'<');
        }
    }
    d
}

/// Mutate one XML part of an OOXML package and rebuild the zip.
fn mutate_part(rng: &mut Rng, pkg: &[u8]) -> Vec<u8> {
    let z = Zip::open(pkg).unwrap();
    let names: Vec<String> = z.names().to_vec();
    let target = rng.below(names.len());
    let parts: Vec<(String, Vec<u8>)> = names
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let data = z.read(n).unwrap();
            let data = if i == target {
                mutate(rng, &data)
            } else {
                data
            };
            (n.clone(), data)
        })
        .collect();
    let refs: Vec<(&str, &[u8])> = parts
        .iter()
        .map(|(n, d)| (n.as_str(), d.as_slice()))
        .collect();
    build(&refs, rng.below(2) == 0)
}

#[test]
fn mutated_inputs_never_panic() {
    let cases: usize = std::env::var("WARRAQ_CREATE_SMOKE_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60);
    let names = [
        "report.docx",
        "sales.xlsx",
        "deck.pptx",
        "guide.md",
        "page.html",
        "data.csv",
        "notes.txt",
        "photo.jpg",
        "logo.png",
        "scan.tif",
    ];
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let start = Instant::now();
    let mut ok = 0usize;
    let mut err = 0usize;
    for name in names {
        let data = fixture(name);
        let ooxml = name.ends_with("x");
        for k in 0..cases {
            let input = if ooxml && k % 2 == 0 {
                mutate_part(&mut rng, &data)
            } else {
                mutate(&mut rng, &data)
            };
            let t = Instant::now();
            let r = create(
                &[(
                    FileSpec {
                        name: name.into(),
                        kind: None,
                    },
                    input,
                )],
                &CreateOptions {
                    merge: true,
                    page_numbers: k % 3 == 0,
                    ..CreateOptions::default()
                },
            );
            assert!(
                t.elapsed() < Duration::from_secs(20),
                "{name} case {k} took {:?}",
                t.elapsed()
            );
            match r {
                Ok(v) => {
                    ok += 1;
                    assert!(v.iter().all(|d| d.bytes.starts_with(b"%PDF-")));
                }
                Err(_) => err += 1,
            }
        }
    }
    eprintln!("{ok} created, {err} refused in {:?}", start.elapsed());
    assert!(ok > 0 && err > 0);
}

#[test]
fn hostile_constructions_are_refused_or_bounded() {
    let opts = CreateOptions::default();
    let run = |name: &str, bytes: Vec<u8>| {
        create(
            &[(
                FileSpec {
                    name: name.into(),
                    kind: None,
                },
                bytes,
            )],
            &opts,
        )
    };
    // Billion laughs in document.xml: entities are never expanded.
    let lol = r#"<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>&c;&c;&c;</w:t></w:r></w:p></w:body></w:document>"#;
    let z = build(&[("word/document.xml", lol.as_bytes())], true);
    let out = run("lol.docx", z).unwrap();
    assert!(out[0].bytes.len() < 200_000);
    // Zip bomb part.
    let bomb = vec![b' '; 64 << 20];
    let z = build(&[("word/document.xml", &bomb)], true);
    assert_eq!(run("bomb.docx", z).unwrap_err().code(), "limit_exceeded");
    // Huge declared picture.
    let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    png.extend_from_slice(&60_000u32.to_be_bytes());
    png.extend_from_slice(&60_000u32.to_be_bytes());
    png.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
    assert!(run("huge.png", png).is_err());
    // Table with an absurd span and 10 000 columns.
    let wide = format!(
        "<table><tr>{}</tr><tr><td colspan=\"65535\" rowspan=\"65535\">x</td></tr></table>",
        "<td>c</td>".repeat(10_000)
    );
    assert!(run("wide.html", wide.into_bytes()).is_ok());
    // Deep lists in Markdown.
    let deep: String = (0..500)
        .map(|i| format!("{}- item\n", "  ".repeat(i)))
        .collect();
    assert!(run("deep.md", deep.into_bytes()).is_ok());
}
