//! No-panic smoke test: random and mutated content streams, CMaps and glyph soups go through
//! the lexer, CMap parser, interpreter and layout without panicking (the cargo-fuzz targets in
//! `packages/core/fuzz` explore the same entry points without a time limit).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use warraq_text::cmap::CMap;
use warraq_text::interp::Interpreter;
use warraq_text::layout::{layout_page, LayoutOptions};
use warraq_text::lexer::ContentParser;
use warraq_text::{normalize_for_search, search, LopdfSource};

/// xorshift64* — deterministic, dependency-free.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

const SEEDS: &[&str] = &[
    "BT /F1 12 Tf 1 0 0 1 72 700 Tm (Hello) Tj [(A) -120 (B)] TJ 14 TL T* (x) ' 1 2 (y) \" ET",
    "q 2 0 0 2 0 0 cm BT /F2 20 Tf 0 0 Td /Span <</ActualText <FEFF0633064406270645>>> BDC <0004000100020003> Tj EMC ET Q",
    "/Artifact BMC BT /F1 10 Tf 3 Tr (hidden) Tj 0 Tr 90 Tz 1 Tc 2 Tw 3 Ts (v) Tj ET EMC /X1 Do",
    "BT /F2 8 Tf /ReversedChars BMC <00050001> Tj EMC ET BI /W 1 /H 1 ID \x00 EI",
];

const CMAP_SEED: &str = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar <0001> <0627> <0100> <06440627> endbfchar
2 beginbfrange <0010> <0012> <0661> <0020> <0022> [<0041> <D83DDE00> <00660066>] endbfrange
1 begincidrange <0000> <FFFF> 0 endcidrange
/Identity-H usecmap /WMode 1 def endcmap";

const TOKENS: &[&str] = &[
    "BT",
    "ET",
    "Tj",
    "TJ",
    "Td",
    "TD",
    "Tm",
    "T*",
    "'",
    "\"",
    "Tf",
    "Tc",
    "Tw",
    "Tz",
    "TL",
    "Ts",
    "Tr",
    "q",
    "Q",
    "cm",
    "Do",
    "BDC",
    "BMC",
    "EMC",
    "BI",
    "ID",
    "EI",
    "[",
    "]",
    "<<",
    ">>",
    "(",
    ")",
    "<",
    ">",
    "/F1",
    "/F2",
    "/X1",
    "-1e308",
    "1e308",
    "0",
    "-0",
    "NaN",
    "999999999999",
    ".5",
    "--3",
    "<FEFF",
    "\\",
    "%",
    "\n",
    "beginbfrange",
    "endbfrange",
    "beginbfchar",
    "begincodespacerange",
    "<00>",
    "<FFFFFFFFFF>",
    "[<0041>",
];

fn mutate(rng: &mut Rng, seed: &[u8]) -> Vec<u8> {
    let mut v = seed.to_vec();
    for _ in 0..(1 + rng.below(12)) {
        match rng.below(5) {
            0 if !v.is_empty() => {
                let i = rng.below(v.len());
                v[i] = rng.next() as u8;
            }
            1 if !v.is_empty() => {
                let i = rng.below(v.len());
                let n = rng.below(16).min(v.len() - i);
                v.drain(i..i + n);
            }
            2 => {
                let i = rng.below(v.len() + 1);
                let t = TOKENS[rng.below(TOKENS.len())];
                let ins = format!(" {t} ");
                v.splice(i..i, ins.bytes());
            }
            3 if !v.is_empty() => {
                let i = rng.below(v.len());
                let n = rng.below(64).min(v.len() - i);
                let chunk: Vec<u8> = v[i..i + n].to_vec();
                let j = rng.below(v.len() + 1);
                v.splice(j..j, chunk);
            }
            _ => {
                let n = rng.below(32);
                for _ in 0..n {
                    v.push(rng.next() as u8);
                }
            }
        }
    }
    v
}

fn fixture() -> (LopdfSource, Dictionary) {
    let mut doc = Document::with_version("1.7");
    let f1 = doc.add_object(
        dictionary! {"Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica"},
    );
    let tu = doc.add_object(Stream::new(dictionary! {}, CMAP_SEED.as_bytes().to_vec()));
    let desc = doc.add_object(dictionary! {"Subtype" => "CIDFontType2", "W" => vec![Object::Integer(1), Object::Array(vec![Object::Real(500.0)])]});
    let f2 = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type0", "Encoding" => "Identity-V",
        "DescendantFonts" => vec![Object::Reference(desc)], "ToUnicode" => tu,
    });
    let form_id = doc.new_object_id();
    let res = dictionary! {"Font" => dictionary! {"F1" => f1, "F2" => f2}, "XObject" => dictionary! {"X1" => form_id}};
    let form = Stream::new(
        dictionary! {"Subtype" => "Form", "Resources" => res.clone()},
        SEEDS[0].as_bytes().to_vec(),
    );
    doc.objects.insert(form_id, Object::Stream(form));
    (LopdfSource::from_document(doc), res)
}

#[test]
fn content_streams_never_panic() {
    let (src, res) = fixture();
    let mut rng = Rng(0x0005_eed0_fa11);
    let mut it = Interpreter::new(&src);
    for round in 0..3000 {
        let seed = SEEDS[round % SEEDS.len()].as_bytes();
        let data = if round % 7 == 0 {
            (0..rng.below(512)).map(|_| rng.next() as u8).collect()
        } else {
            mutate(&mut rng, seed)
        };
        let _ = ContentParser::new(&data).count();
        let glyphs = it.run_content(&data, &res);
        let page = layout_page(
            0,
            glyphs,
            [0.0, 0.0, 612.0, 792.0],
            &LayoutOptions {
                glyphs: true,
                ..Default::default()
            },
        );
        let _ = search(std::slice::from_ref(&page), "a");
    }
}

#[test]
fn cmaps_never_panic() {
    let mut rng = Rng(0xc0ffee);
    for round in 0..3000 {
        let data = if round % 5 == 0 {
            (0..rng.below(256)).map(|_| rng.next() as u8).collect()
        } else {
            mutate(&mut rng, CMAP_SEED.as_bytes())
        };
        let m = CMap::parse(&data);
        let probe: Vec<u8> = (0..rng.below(9)).map(|_| rng.next() as u8).collect();
        let (code, len) = m.next_code(&probe);
        let _ = m.lookup_unicode(code, len);
        let _ = m.lookup_cid(code, len);
        let _ = m.lookup_unicode(rng.next() as u32, rng.below(6));
    }
}

#[test]
fn normalisation_never_panics() {
    let mut rng = Rng(42);
    for _ in 0..2000 {
        let s: String = (0..rng.below(40))
            .filter_map(|_| {
                char::from_u32(match rng.below(3) {
                    0 => 0x0600 + rng.below(0x100) as u32,
                    1 => 0xFB50 + rng.below(0x4B0) as u32,
                    _ => rng.below(0x11_0000) as u32,
                })
            })
            .collect();
        let (n, map) = normalize_for_search(&s);
        assert_eq!(map.len(), n.chars().count() + 1);
        assert!(map.iter().all(|&o| s.is_char_boundary(o)));
    }
}
