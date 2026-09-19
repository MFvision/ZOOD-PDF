//! Every PDF is hostile input (brief §5).
//!
//! This harness mutates the corpus deterministically and requires that opening,
//! rendering and extracting text either succeed or return an error — never panic,
//! never hang. It runs on stable Rust in CI; `packages/core/fuzz/` holds the
//! coverage-guided cargo-fuzz targets for the nightly job.
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// A small, reproducible PRNG so a failure can always be replayed from its seed.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
}

/// Mutations that mirror how real PDFs are broken: truncation, flipped bytes,
/// corrupted numbers (lengths, offsets) and damaged structural keywords.
fn mutate(seed: u64, input: &[u8]) -> Vec<u8> {
    let mut rng = Rng(seed | 1);
    let mut out = input.to_vec();
    match rng.below(5) {
        0 => out.truncate(rng.below(out.len().max(1))),
        1 => {
            for _ in 0..8 {
                let i = rng.below(out.len().max(1));
                if i < out.len() {
                    out[i] ^= 1 << rng.below(8);
                }
            }
        }
        2 => {
            // corrupt digits, which is how /Length and xref offsets go wrong
            for _ in 0..24 {
                let i = rng.below(out.len().max(1));
                if i < out.len() && out[i].is_ascii_digit() {
                    out[i] = b'0' + (rng.below(10) as u8);
                }
            }
        }
        3 => {
            for kw in [
                b"xref".as_ref(),
                b"trailer".as_ref(),
                b"endobj".as_ref(),
                b"stream".as_ref(),
            ] {
                if let Some(pos) = out.windows(kw.len()).position(|w| w == kw) {
                    out[pos] = b'X';
                }
            }
        }
        _ => {
            let i = rng.below(out.len().max(1));
            let j = (i + 1 + rng.below(64)).min(out.len());
            out.drain(i..j);
        }
    }
    out
}

fn corpus_files() -> Vec<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/corpus/arabic");
    let mut files = vec![];
    for sub in ["generated", "realworld"] {
        if let Ok(rd) = std::fs::read_dir(dir.join(sub)) {
            let mut v: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().map(|e| e == "pdf").unwrap_or(false))
                .collect();
            v.sort();
            files.extend(v);
        }
    }
    files
}

/// Open, render and extract, catching panics. Returns the time taken.
fn exercise(bytes: Vec<u8>) -> Duration {
    let t = Instant::now();
    let _ = catch_unwind(AssertUnwindSafe(move || {
        if let Ok(doc) = warraq_core::Document::open(bytes, Some("warraq")) {
            let pages = doc.page_count().min(2);
            for i in 0..pages {
                let _ = doc.page_size(i);
                let _ = doc.render_page(i, 0.3);
                let _ = doc.extract_text(i);
                let _ = doc.text_lines(i);
            }
            // search visits every page, so it is exercised on small documents only:
            // this harness is about structural robustness, not throughput
            if doc.page_count() <= 20 {
                let _ = doc.search("العربية");
            }
            let _ = doc.metadata();
            // Prepare form reads the page's lines and the form's scripts.
            let _ = doc.detect_fields(&[0]);
            let _ = doc.form();
        }
    }));
    t.elapsed()
}

#[test]
fn mutated_corpus_files_never_panic_or_hang() {
    let files = corpus_files();
    assert!(!files.is_empty(), "corpus not found");
    // one panic aborts the test with the seed needed to reproduce it
    let mut panics: Vec<String> = vec![];
    let mut slowest = Duration::ZERO;
    let mut slowest_case = String::new();
    // generous because the harness also runs in a debug build locally
    let budget = Duration::from_secs(30);
    for (fi, file) in files.iter().enumerate() {
        let input = std::fs::read(file).unwrap();
        // large scans and the many-page performance fixtures would dominate the
        // budget without testing anything structural
        if input.len() > 600_000
            || file
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("perf-")
        {
            continue;
        }
        for seed in 0..6u64 {
            let case = format!("{}#{seed}", file.file_name().unwrap().to_string_lossy());
            let bytes = mutate(seed * 7919 + fi as u64, &input);
            let taken = std::panic::catch_unwind(AssertUnwindSafe(|| exercise(bytes)));
            match taken {
                Err(_) => panics.push(case),
                Ok(d) => {
                    if d > slowest {
                        slowest = d;
                        slowest_case = case;
                    }
                }
            }
        }
    }
    assert!(panics.is_empty(), "panics on mutated input: {panics:?}");
    assert!(
        slowest < budget,
        "a mutated file took {slowest:?} ({slowest_case}); the parser must stay responsive"
    );
    eprintln!("robustness: slowest mutated case {slowest:?} ({slowest_case})");
}

#[test]
fn truncated_and_empty_input_is_rejected_cleanly() {
    for bytes in [
        vec![],
        b"%PDF-1.7".to_vec(),
        b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog".to_vec(),
        vec![0u8; 4096],
    ] {
        let r = catch_unwind(AssertUnwindSafe(|| {
            warraq_core::Document::open(bytes, None)
        }));
        assert!(r.is_ok(), "opening malformed input must not panic");
        assert!(
            r.unwrap().is_err(),
            "malformed input must be an error, not a document"
        );
    }
}

#[test]
fn searching_for_any_character_of_the_arabic_presentation_blocks_returns() {
    // A query is typed by a person, or pasted from a Quran text: the ornate
    // parentheses and U+FEFF once overflowed the stack, which aborts the
    // process rather than panicking.
    let bytes = std::fs::read(format!(
        "{}/../../../tests/corpus/arabic/generated/chrome-notonaskh-justified-3pages.pdf",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let doc = warraq_core::Document::open(bytes, None).unwrap();
    for c in ('\u{FB50}'..='\u{FDFF}').chain('\u{FE70}'..='\u{FEFF}') {
        let _ = doc.search(&c.to_string());
        let _ = doc.search(&format!("{c}الله{c}"));
    }
}

/// One A4 page drawing `content`, and a form `/Fm` that draws it again and
/// can draw itself — as `packages/core/fuzz/fuzz_targets/lex_content.rs`.
fn one_page(content: &[u8]) -> Vec<u8> {
    let stream = |dict: &str| {
        let mut s = format!("<< {dict} /Length {} >>\nstream\n", content.len()).into_bytes();
        s.extend_from_slice(content);
        s.extend_from_slice(b"\nendstream");
        s
    };
    let objects: Vec<Vec<u8>> = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /XObject << /Fm 5 0 R >> >> >>".to_vec(),
        stream(""),
        stream("/Type /XObject /Subtype /Form /BBox [0 0 595 842] /Resources << /XObject << /Fm 5 0 R >> >>"),
    ];
    let mut out = b"%PDF-1.7\n".to_vec();
    let mut offsets = vec![];
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    out.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
    );
    for offset in offsets {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    out
}

/// Content streams built from the pieces that have broken content lexers —
/// strings and escapes cut off at the end, inline images with impossible
/// sizes, forms that draw themselves — never panic and never hang: listed,
/// moved and deleted as Edit PDF's pictures are, and held to the lexer's
/// promises (every range inside the stream, in order).
#[test]
fn hostile_content_streams_never_panic_or_hang() {
    const PIECES: &[&[u8]] = &[
        b"q ",
        b"Q ",
        b"1 0 0 1 10 20 cm ",
        b"/Fm Do ",
        b"/Fm Do /Fm Do ",
        b"BI ",
        b"/W 16 ",
        b"/H 4095 ",
        b"/BPC 524416 ",
        b"/BPC 8 ",
        b"/CS /G ",
        b"ID ",
        b"\x80 ",
        b" EI ",
        b"( EI ) Tj ",
        b"(",
        b"\\",
        b")",
        b"[",
        b"]",
        b"<<",
        b">>",
        b"<ab",
        b"%comment\n",
        b"/WarraqImage BMC ",
        b"0 0 1 1 re W n ",
        b"EMC ",
        b"9999999999 ",
        b"-.5e3 ",
        b"/#zz ",
    ];
    let mut rng = Rng(0x5eed_1e57);
    let mut slowest = Duration::ZERO;
    for case in 0..600 {
        let mut content = Vec::new();
        for _ in 0..rng.below(40) {
            content.extend_from_slice(PIECES[rng.below(PIECES.len())]);
        }
        let shown = String::from_utf8_lossy(&content).into_owned();
        assert!(
            warraq_pdf::lex_ranges_hold(&content),
            "case {case}: {shown:?}"
        );
        let t = Instant::now();
        let ran = catch_unwind(AssertUnwindSafe(|| {
            if let Ok(mut doc) = warraq_pdf::PdfDocument::open(one_page(&content), None) {
                if let Ok(images) = doc.list_images(0) {
                    for image in images.iter().take(4) {
                        let crop = Some([0.1, 0.1, 0.9, 0.9]);
                        let _ = doc.transform_image(0, &image.id, image.matrix, crop);
                    }
                    if let Some(image) = images.last() {
                        let _ = doc.delete_image(0, &image.id);
                    }
                }
            }
        }));
        assert!(ran.is_ok(), "case {case} panicked: {shown:?}");
        slowest = slowest.max(t.elapsed());
    }
    assert!(
        slowest < Duration::from_secs(10),
        "a content stream took {slowest:?}"
    );
}
