//! Stable no-panic smoke test (the cargo-fuzz targets need nightly): mutated content streams go
//! through ruling-line reading, table detection and every writer; mutated archives through the
//! ZIP reader; random rasters through the visual diff.
#![allow(clippy::unwrap_used, clippy::indexing_slicing)]

use lopdf::{dictionary, Document, Object, Stream};
use warraq_office::{export, Format};
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

const SEED: &[u8] = b"q 1 0 0 1 0 0 cm 0.5 w 50 700 m 300 700 l S 50 680 m 300 680 l S 50 660 m 300 660 l S \
50 660 m 50 700 l S 175 660 m 175 700 l S 300 660 m 300 700 l S 60 60 1 200 re f 60 60 200 1 re f Q \
BT /F1 12 Tf 60 685 Td (Name) Tj 130 0 Td (Qty) Tj ET BT /F1 12 Tf 60 665 Td (Pen) Tj 130 0 Td (12) Tj ET \
BT /F1 24 Tf 60 740 Td (Title) Tj ET /X1 Do";

fn mutate(rng: &mut Rng, seed: &[u8]) -> Vec<u8> {
    let mut v = seed.to_vec();
    for _ in 0..1 + rng.below(8) {
        match rng.below(5) {
            0 if !v.is_empty() => {
                let i = rng.below(v.len());
                v[i] = rng.next() as u8;
            }
            1 if !v.is_empty() => {
                let i = rng.below(v.len());
                let n = rng.below(20).min(v.len() - i);
                v.drain(i..i + n);
            }
            2 => {
                let i = rng.below(v.len() + 1);
                let tok: &[&[u8]] = &[
                    b" re ", b" m ", b" l ", b" S ", b" f ", b" q ", b" Q ", b" cm ", b" 1e30 ",
                    b" -0 ", b" Do ", b" BT ", b" ET ",
                ];
                v.splice(i..i, tok[rng.below(tok.len())].iter().copied());
            }
            3 => {
                let i = rng.below(v.len() + 1);
                let j = rng.below(v.len() + 1);
                let (a, b) = (i.min(j), i.max(j));
                let chunk: Vec<u8> = v[a..b].to_vec();
                v.extend(chunk);
            }
            _ => v.truncate(rng.below(v.len() + 1)),
        }
    }
    v
}

fn doc_with(content: Vec<u8>) -> LopdfSource {
    let mut doc = Document::with_version("1.7");
    let f1 = doc.add_object(
        dictionary! {"Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica"},
    );
    let form_id = doc.new_object_id();
    let res = dictionary! {"Font" => dictionary! {"F1" => f1}, "XObject" => dictionary! {"X1" => form_id}};
    // A self-referencing form: cycles must terminate.
    let form = Stream::new(
        dictionary! {"Subtype" => "Form", "Resources" => res.clone()},
        content.clone(),
    );
    doc.objects.insert(form_id, Object::Stream(form));
    let contents = doc.add_object(Stream::new(dictionary! {}, content));
    let pages_id = doc.new_object_id();
    let page = doc.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Resources" => res, "Contents" => contents,
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(
            dictionary! {"Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1},
        ),
    );
    let catalog = doc.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    doc.trailer.set("Root", catalog);
    LopdfSource::from_document(doc)
}

#[test]
fn exports_never_panic_on_mutated_content() {
    let cases: usize = std::env::var("WARRAQ_SMOKE_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(600);
    let mut rng = Rng(0x5eed_0ff1_ce00_0001);
    // The seed itself: a ruled 2×2 table.
    let src = doc_with(SEED.to_vec());
    let (meta, _) = export(&src, Format::Xlsx, &serde_json::Value::Null, &[]).unwrap();
    assert_eq!(meta["tables"], 1, "{meta}");
    for _ in 0..cases {
        let src = doc_with(mutate(&mut rng, SEED));
        let f = [
            Format::Docx,
            Format::Xlsx,
            Format::Pptx,
            Format::Html,
            Format::Markdown,
            Format::Text,
        ][rng.below(6)];
        let _ = export(&src, f, &serde_json::Value::Null, &[]);
    }
}

#[test]
fn zip_reader_never_panics() {
    let mut z = warraq_office::zip::ZipWriter::new();
    z.add("a.xml", b"<a>hello hello hello</a>", true).unwrap();
    z.add("b.png", b"\x89PNG", false).unwrap();
    let good = z.finish().unwrap();
    let mut rng = Rng(42);
    for _ in 0..3000 {
        let bad = mutate(&mut rng, &good);
        let _ = warraq_office::zip::read(&bad, 1 << 20);
    }
}

#[test]
fn visual_diff_never_panics_on_odd_sizes() {
    use warraq_office::compare::{compare_visual, Raster};
    let mut rng = Rng(7);
    for _ in 0..200 {
        let (w1, h1, w2, h2) = (
            rng.below(40) as u32,
            rng.below(40) as u32,
            rng.below(40) as u32,
            rng.below(40) as u32,
        );
        let a: Vec<u8> = (0..w1 * h1 * 4).map(|_| rng.next() as u8).collect();
        let b: Vec<u8> = (0..w2 * h2 * 4).map(|_| rng.next() as u8).collect();
        let _ = compare_visual(
            &Raster {
                width: w1,
                height: h1,
                rgba: &a,
            },
            &Raster {
                width: w2,
                height: h2,
                rgba: &b,
            },
            rng.next() as u8,
        );
        // lying about the size
        let _ = compare_visual(
            &Raster {
                width: w1 + 1,
                height: h1,
                rgba: &a,
            },
            &Raster {
                width: w2,
                height: h2,
                rgba: &b,
            },
            10,
        );
    }
}
