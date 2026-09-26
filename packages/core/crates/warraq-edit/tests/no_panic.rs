//! Stable smoke fuzz: mutated content streams, URLs and pictures through every Edit entry point
//! must return values or errors, never panic, and the lexer partition must always hold.
#![allow(clippy::unwrap_used, clippy::indexing_slicing)]

use lopdf::{dictionary, Document, Object, Stream};
use warraq_edit::content::{parse, partition_ok, reemit};
use warraq_edit::geom::Rect;
use warraq_edit::{images, links, text, url};
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

const SEED: &[u8] = b"q 1 0 0 1 0 0 cm BT /F1 12 Tf 72 720 Td (Hello) Tj [(W) -120 (orld)] TJ T* (x) ' 1 2 (y) \" ET Q\nq 100 0 0 50 72 600 cm /Im1 Do Q q 20 0 0 20 300 300 cm BI /W 1 /H 1 /BPC 8 /CS /G ID \x80 EI Q /Span <</ActualText <FEFF0644>>> BDC BT /F1 9 Tf (a) Tj ET EMC q 0 0 1 1 re W n /Im1 Do Q";

fn doc(content: &[u8]) -> Vec<u8> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let img = doc.add_object(Stream::new(
        dictionary! {"Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1, "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8},
        vec![0],
    ));
    let font = doc.add_object(
        dictionary! {"Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica"},
    );
    let c = doc.add_object(Stream::new(dictionary! {}, content.to_vec()));
    let pg = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Contents" => c,
        "Resources" => dictionary! {"XObject" => dictionary! {"Im1" => img}, "Font" => dictionary! {"F1" => font}},
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(
            dictionary! {"Type" => "Pages", "Kids" => vec![pg.into()], "Count" => 1},
        ),
    );
    let cat = doc.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    doc.trailer.set("Root", cat);
    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

fn mutate(r: &mut Rng, base: &[u8]) -> Vec<u8> {
    let mut v = base.to_vec();
    for _ in 0..(1 + r.below(8)) {
        let pos = r.below(v.len() + 1);
        match r.below(4) {
            0 if !v.is_empty() => {
                let p = pos.min(v.len() - 1);
                v[p] = (r.next() & 0xff) as u8;
            }
            1 => {
                let tok: &[u8] = [
                    &b"["[..],
                    b"]",
                    b"<<",
                    b">>",
                    b"(",
                    b")",
                    b"BT",
                    b"ET",
                    b"q",
                    b"Q",
                    b"cm",
                    b"Do",
                    b"BI",
                    b"ID",
                    b"EI",
                    b"%",
                    b"-1e308",
                    b"/",
                    b"<",
                    b"re W n",
                ][r.below(20)];
                v.splice(pos..pos, tok.iter().copied());
            }
            2 if pos < v.len() => {
                let end = (pos + r.below(16)).min(v.len());
                v.drain(pos..end);
            }
            _ => v.truncate(pos),
        }
    }
    v
}

#[test]
fn mutated_pages_never_panic() {
    let cases: usize = std::env::var("WARRAQ_SMOKE_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(400);
    let mut r = Rng(0x2545_f491_4f6c_dd1d);
    for _ in 0..cases {
        let content = mutate(&mut r, SEED);
        let c = parse(&content).unwrap();
        assert!(partition_ok(&content, &c));
        assert_eq!(reemit(&content, &c), content);
        let Ok(mut pdf) = Pdf::open(doc(&content), None) else {
            continue;
        };
        let blocks = text::blocks(&pdf, 0).unwrap_or_default();
        if let Some(b) = blocks.iter().find(|b| b.editable) {
            let _ = text::replace(&mut pdf, 0, b.id, "نص جديد new", None, None);
        }
        if let Ok(list) = images::list(&pdf, 0) {
            if !list.is_empty() {
                let _ = images::transform(
                    &mut pdf,
                    0,
                    0,
                    &images::Transform {
                        dx: 3.0,
                        rotate: 45.0,
                        ..Default::default()
                    },
                );
                let _ = images::crop(&mut pdf, 0, 0, Rect::new(0.0, 0.0, 400.0, 400.0));
                let _ = images::delete(&mut pdf, 0, list.len() - 1);
            }
        }
        let _ = links::list(&pdf, 0);
        let _ = pdf.commit();
    }
}

#[test]
fn random_urls_and_pictures_never_panic() {
    let mut r = Rng(0x9e37_79b9_7f4a_7c15);
    let alphabet: Vec<char> = "ab.-:/@%xn--EF80AE\u{202E}\u{2066}\u{0430}\u{0628}١ 0?#[]"
        .chars()
        .collect();
    for _ in 0..3000 {
        let n = r.below(40);
        let s: String = std::iter::once("https://")
            .map(String::from)
            .chain((0..n).map(|_| alphabet[r.below(alphabet.len())].to_string()))
            .collect();
        let c = url::check(&s);
        assert!(matches!(c.verdict, "ok" | "warn" | "reject"));
        let bytes: Vec<u8> = (0..r.below(64)).map(|_| (r.next() & 0xff) as u8).collect();
        let _ = url::punycode_decode(&String::from_utf8_lossy(&bytes));
        let mut j = vec![0xFF, 0xD8];
        j.extend_from_slice(&bytes);
        let _ = images::decode_picture(&j);
        let mut p = b"\x89PNG\r\n\x1a\n".to_vec();
        p.extend_from_slice(&bytes);
        let _ = images::decode_picture(&p);
    }
}
