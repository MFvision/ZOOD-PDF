//! Stable no-panic smoke test for the content rewriter, inline-image parser and patterns (the
//! cargo-fuzz target `redact_content` explores the same surface with coverage guidance).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod common;

use common::Builder;
use lopdf::{dictionary, Stream};
use warraq_pdf::Pdf;
use warraq_redact::apply::{apply_and_rewrite, ApplyOptions, Area};
use warraq_redact::content::{HiddenText, Rewriter};
use warraq_redact::find::{find, FindOptions};
use warraq_redact::patterns::Kind;
use warraq_redact::sanitize::{sanitize_and_rewrite, SanitizeOptions};
use warraq_text::geom::{Matrix, Rect};
use warraq_text::LopdfSource;

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

const SEEDS: &[&[u8]] = &[
    b"BT /F1 12 Tf 72 700 Td (Hello World) Tj [(A) -120 (B)] TJ 12 TL (x) ' 1 2 (y) \" ET",
    b"q 1 0 0 1 10 10 cm 0 0 100 100 re W n 0 0 50 50 re f Q 10 10 m 20 20 l 30 30 40 40 50 50 c S",
    b"q 40 0 0 40 300 300 cm BI /W 4 /H 4 /BPC 8 /CS /G ID \xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff EI Q",
    b"/OC /L1 BDC BT /F1 12 Tf (hidden) Tj ET EMC /Span <</ActualText (x)>> BDC BT /F1 9 Tf (z) Tj ET EMC /X Do sh",
    b"BI /W 2 /H 2 /BPC 1 /IM true /F /AHx ID 0000> EI BI /W 2 /H 2 /BPC 8 /CS /RGB /F [/Fl] ID xx EI",
];

#[test]
fn rewriter_survives_mutated_content() {
    let cases: usize = std::env::var("WARRAQ_SMOKE_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3000);
    let mut doc = lopdf::Document::with_version("1.7");
    let f1 = doc.add_object(
        dictionary! {"Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica"},
    );
    let form_id = doc.new_object_id();
    let img = doc.add_object(Stream::new(
        dictionary! {"Subtype" => "Image", "Width" => 2, "Height" => 2, "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8},
        vec![1, 2, 3, 4],
    ));
    let res = dictionary! {"Font" => dictionary! {"F1" => f1}, "XObject" => dictionary! {"X" => form_id, "I" => img}};
    doc.objects.insert(
        form_id,
        lopdf::Object::Stream(Stream::new(
            dictionary! {"Subtype" => "Form", "Resources" => res.clone()},
            SEEDS[0].to_vec(),
        )),
    );
    let src = LopdfSource::from_document(doc);
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut rw = Rewriter::new(&src, 1000);
    for i in 0..cases {
        let mut data = SEEDS[i % SEEDS.len()].to_vec();
        for _ in 0..1 + rng.below(8) {
            match rng.below(4) {
                0 if !data.is_empty() => {
                    let p = rng.below(data.len());
                    data[p] = rng.next() as u8;
                }
                1 => {
                    let p = rng.below(data.len() + 1);
                    data.insert(p, b"()<>[]/%{}\\ \n0123456789.-ETBIDQq"[rng.below(32)]);
                }
                2 if !data.is_empty() => {
                    let p = rng.below(data.len());
                    data.truncate(p);
                }
                _ => {
                    let other = SEEDS[rng.below(SEEDS.len())];
                    data.extend_from_slice(other);
                }
            }
        }
        rw.set_rects(&[Rect::new(
            0.0,
            0.0,
            rng.below(800) as f64,
            rng.below(800) as f64,
        )]);
        rw.set_hidden_text((i % 2 == 0).then_some(HiddenText {
            page_box: Rect::new(0.0, 0.0, 612.0, 792.0),
            min_size: 1.0,
        }));
        let _ = rw.rewrite(&data, &res, Matrix::IDENTITY);
    }
}

#[test]
fn whole_documents_with_hostile_bits() {
    let mut b = Builder::new();
    let bad_img = b.doc.add_object(Stream::new(
        dictionary! {"Subtype" => "Image", "Width" => 100000, "Height" => 100000, "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8},
        vec![0; 10],
    ));
    b.page(
        b"q 100 0 0 100 0 0 cm /B Do Q BT /F1 12 Tf 72 700 Td (Email a@b.co 0501234567) Tj ET",
        dictionary! {"XObject" => dictionary! {"B" => bad_img}},
        vec![],
    );
    let bytes = b.finish();
    let mut pdf = Pdf::open(bytes.clone(), None).unwrap();
    let r = find(
        &pdf,
        &FindOptions {
            patterns: vec![Kind::Email, Kind::Phone],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(r.hits.len(), 2);
    let areas = vec![Area {
        page: 0,
        rect: Rect::new(10.0, 10.0, 50.0, 50.0),
        fill: None,
        overlay: None,
    }];
    let (_, rep) = apply_and_rewrite(
        &mut pdf,
        &ApplyOptions {
            areas,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        rep.content.images_removed, 1,
        "oversized image removed, not decoded"
    );
    let mut pdf = Pdf::open(bytes, None).unwrap();
    sanitize_and_rewrite(&mut pdf, &SanitizeOptions::default()).unwrap();
}
