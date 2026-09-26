//! Stable smoke fuzz: mutated page content (pagination artifacts, Acrobat forms, our own mark
//! streams), mutated whole marked files and random mark specs through list/add/update/remove
//! must return values or errors, never panic, in bounded time.
#![allow(clippy::unwrap_used, clippy::indexing_slicing)]

use std::time::{Duration, Instant};

use lopdf::{dictionary, Document, Object, Stream};
use serde_json::{json, Value};
use warraq_marks::api;
use warraq_pdf::Pdf;

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

const SEED: &[u8] = b"BT /F1 12 Tf 72 720 Td (Body) Tj ET\nq /Artifact <</Subtype /Watermark /Type /Pagination >>BDC 0.7 0.7 -0.7 0.7 200 300 cm /Fm0 Do EMC Q\n/Artifact <</Type /Pagination /Subtype /Footer>> BDC q BT /F1 9 Tf 72 30 Td (F) Tj ET Q EMC\n/Artifact /P1 BDC /Fm0 Do EMC q /Fm0 Do Q /Artifact BMC (x) Tj EMC EMC EMC BDC";

fn doc(content: &[u8], rotate: i64) -> Vec<u8> {
    let mut d = Document::with_version("1.7");
    let pages_id = d.new_object_id();
    let font = d.add_object(
        dictionary! {"Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica"},
    );
    let fm = d.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "PieceInfo" => dictionary! { "ADBE_CompoundType" => dictionary! { "Private" => "Header" } },
        },
        b"BT /F1 9 Tf (H) Tj ET".to_vec(),
    ));
    let c = d.add_object(Stream::new(dictionary! {}, content.to_vec()));
    let c2 = d.add_object(Stream::new(dictionary! {}, b"BT (second) Tj ET".to_vec()));
    let pg = d.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Contents" => vec![c.into(), c2.into()], "Rotate" => rotate,
        "Resources" => dictionary! {
            "XObject" => dictionary! {"Fm0" => fm},
            "Font" => dictionary! {"F1" => font},
            "Properties" => dictionary! {"P1" => dictionary! {"Type" => "Pagination", "Subtype" => "Header"}},
        },
    });
    d.objects.insert(
        pages_id,
        Object::Dictionary(
            dictionary! {"Type" => "Pages", "Kids" => vec![pg.into()], "Count" => 1},
        ),
    );
    let cat = d.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    d.trailer.set("Root", cat);
    let mut out = Vec::new();
    d.save_to(&mut out).unwrap();
    out
}

fn mutate(r: &mut Rng, base: &[u8]) -> Vec<u8> {
    let mut v = base.to_vec();
    let tokens: &[&[u8]] = &[
        b" q ",
        b" Q ",
        b" BDC ",
        b" EMC ",
        b" /Artifact ",
        b" << ",
        b" >> ",
        b" Do ",
        b" cm ",
        b" BT ",
        b" ET ",
        b"/Subtype /Header",
        b"(",
        b")",
        b"[",
        b"]",
        b"%",
    ];
    for _ in 0..(1 + r.below(8)) {
        let pos = r.below(v.len() + 1);
        match r.below(4) {
            0 if !v.is_empty() => {
                let p = pos.min(v.len() - 1);
                v[p] = (r.next() & 0xff) as u8;
            }
            1 => {
                let t = tokens[r.below(tokens.len())];
                v.splice(pos..pos, t.iter().copied());
            }
            2 if !v.is_empty() => {
                let end = (pos + r.below(16)).min(v.len());
                v.drain(pos.min(end)..end);
            }
            _ => v.truncate(pos),
        }
    }
    v
}

fn random_spec(r: &mut Rng) -> Value {
    let kinds = ["watermark", "header", "footer", "pageNumber", "bates"];
    let texts = [
        "صفحة {page} من {pages}",
        "{bates}",
        "{",
        "}{",
        "{hijri} {date} {time} {file}",
        "",
        "   ",
        "مرحبا\nسطر ثانٍ",
        "\u{202E}abc",
        "ﷺ ﻻ ٪",
    ];
    let nums: [f64; 8] = [0.0, 1.0, -1.0, 45.0, 1e9, 0.5, 400.0, -3600.0];
    json!({
        "kind": kinds[r.below(kinds.len())],
        "text": texts[r.below(texts.len())],
        "slots": { "start": texts[r.below(texts.len())], "end": texts[r.below(texts.len())] },
        "rotation": nums[r.below(nums.len())],
        "diagonal": r.below(2) == 0,
        "size": nums[r.below(nums.len())].abs().max(1.0),
        "opacity": nums[r.below(nums.len())] / 2.0,
        "offsetX": nums[r.below(nums.len())],
        "margin": nums[r.below(nums.len())].abs(),
        "layer": if r.below(2) == 0 { "behind" } else { "front" },
        "digits": if r.below(2) == 0 { "arabic" } else { "latin" },
        "bates": { "prefix": "P", "start": r.next() % 10_000_000_000u64, "digits": r.below(40) },
        "now": { "year": 1900 + r.below(250), "month": r.below(14), "day": r.below(33) },
    })
}

#[test]
fn hostile_pages_and_specs_never_panic() {
    let mut r = Rng(0x005e_ed0f_3a7c);
    let n = cases();
    let start = Instant::now();
    let mut added = 0usize;
    for i in 0..n {
        let content = mutate(&mut r, SEED);
        let bytes = doc(&content, [0, 90, 180, 270, 45][r.below(5)]);
        let Ok(mut pdf) = Pdf::open(bytes, None) else {
            continue;
        };
        let t = Instant::now();
        let _ = api::call(&mut pdf, "marks.list", &Value::Null, &[]);
        for k in ["watermark", "header", "footer", "pagination"] {
            let _ = api::call(
                &mut pdf,
                "marks.remove",
                &json!({ "id": format!("foreign:{k}") }),
                &[],
            );
        }
        let spec = random_spec(&mut r);
        if let Some(Ok(v)) = api::call(&mut pdf, "marks.add", &json!({ "mark": spec }), &[]) {
            added += 1;
            let id = v["id"].as_str().unwrap_or("").to_string();
            let _ = api::call(
                &mut pdf,
                "marks.update",
                &json!({ "id": id, "mark": random_spec(&mut r) }),
                &[],
            );
            let _ = api::call(&mut pdf, "marks.remove", &json!({ "id": id }), &[]);
        }
        if let Ok(saved) = pdf.commit() {
            // Whole-file mutation of a marked file.
            let m = mutate(&mut r, &saved);
            if let Ok(mut again) = Pdf::open(m, None) {
                let _ = api::call(&mut again, "marks.list", &Value::Null, &[]);
                let _ = api::call(&mut again, "marks.remove", &json!({ "id": "zm0" }), &[]);
            }
        }
        assert!(
            t.elapsed() < Duration::from_secs(10),
            "case {i} took {:?}",
            t.elapsed()
        );
    }
    assert!(start.elapsed() < Duration::from_secs(600));
    eprintln!("{added} of {n} random marks were drawn");
    assert!(
        added * 20 >= n,
        "the smoke test must draw marks, not only reject them ({added})"
    );
}

#[test]
fn hostile_pictures_are_errors() {
    let mut pdf = Pdf::open(doc(b"BT (x) Tj ET", 0), None).unwrap();
    let mut r = Rng(99);
    let png = std::fs::read(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../tests/fixtures/logo.png"),
    )
    .unwrap();
    for _ in 0..60 {
        let m = mutate(&mut r, &png);
        let _ = api::call(
            &mut pdf,
            "marks.add",
            &json!({ "mark": { "kind": "watermark", "picture": true } }),
            &[m],
        );
    }
}
