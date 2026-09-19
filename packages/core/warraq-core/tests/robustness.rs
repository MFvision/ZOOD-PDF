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

/// A one-page PDF whose page is `side` points square, with a correct xref.
fn page_of_side(side: u32) -> Vec<u8> {
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {side} {side}] >>"),
    ];
    let mut out = b"%PDF-1.7\n".to_vec();
    let mut offsets = vec![];
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", i + 1).as_bytes());
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

/// A page's size is read from the file. The home screen draws page 1 of every
/// file opened, so a `/MediaBox` of a million points asked for gigabytes the
/// moment the file opened: a trap that aborts the WebAssembly core. Past the
/// pixel budget a render is refused with an error before anything is allocated.
#[test]
fn a_page_too_large_to_draw_is_refused_not_allocated() {
    // 170 000 pt at the smallest scale is 8 500 × 8 500 pixels: past the budget.
    for side in [170_000, 1_400_000] {
        let doc = warraq_core::Document::open(page_of_side(side), None).expect("the file opens");
        let started = Instant::now();
        let drawn = catch_unwind(AssertUnwindSafe(|| doc.render_page(0, 0.05)))
            .unwrap_or_else(|_| panic!("a {side} pt page panicked"));
        let error = drawn.err().map(|e| e.to_string()).unwrap_or_default();
        assert!(
            error.starts_with("E_RENDER"),
            "a {side} pt page must be refused, got {error:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "refused at once, not after drawing"
        );
    }
    // A page of an ordinary size still draws, at the largest scale the app asks for.
    let doc = warraq_core::Document::open(page_of_side(842), None).unwrap();
    let page = doc
        .render_page(0, 8.0)
        .expect("an A4-sized page at 8× is within the budget");
    assert_eq!((page.width, page.height), (6736, 6736));
}
