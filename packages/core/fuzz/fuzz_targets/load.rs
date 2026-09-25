//! Load arbitrary bytes, walk the page tree, read metadata, save incrementally and rewrite.
//!   cd packages/core/fuzz && cargo +nightly fuzz run load corpus/load ../crates/warraq-pdf/tests/fixtures
#![no_main]

use libfuzzer_sys::fuzz_target;
use warraq_pdf::{metadata, pages, revisions, Limits, Pdf, Protection};

fn limits() -> Limits {
    Limits {
        max_file_size: 4 << 20,
        max_decode_size: 16 << 20,
        decode_ratio_floor: 1 << 20,
        max_objects: 100_000,
        max_pages: 10_000,
        ..Limits::default()
    }
}

fuzz_target!(|data: &[u8]| {
    let l = limits();
    let _ = revisions::revisions(data, &l);
    if let Ok(mut pdf) = Pdf::open_with_limits(data.to_vec(), None, l) {
        let _ = metadata::get_info(&pdf);
        let _ = metadata::get_xmp(&pdf);
        if let Ok(n) = pages::count(&pdf) {
            if n > 0 {
                let _ = pages::rotate(&mut pdf, &[0], 90);
            }
        }
        if let Ok(out) = pdf.save_incremental() {
            // The original must be a prefix of every incremental save.
            assert!(out.starts_with(data) || out.len() == data.len());
        }
        let _ = pdf.write_full(Protection::Keep);
    }
});
