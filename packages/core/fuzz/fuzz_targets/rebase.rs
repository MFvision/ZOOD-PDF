//! Rebase an arbitrary "edited" file onto a valid original, and a fuzzed original onto a
//! valid edit. The original bytes must stay a prefix whenever an update is produced.
#![no_main]

use libfuzzer_sys::fuzz_target;
use std::sync::OnceLock;
use warraq_pdf::builder::{sample_pdf, SampleOptions};
use warraq_pdf::rebase::{rebase_pdf, RebaseMode};
use warraq_pdf::Pdf;

fn original() -> &'static [u8] {
    static O: OnceLock<Vec<u8>> = OnceLock::new();
    O.get_or_init(|| {
        sample_pdf(2, &SampleOptions { with_annotation: true, ..Default::default() }).unwrap_or_default()
    })
}

fuzz_target!(|data: &[u8]| {
    let orig = original();
    if let Ok(o) = Pdf::open(orig.to_vec(), None) {
        if let Ok(rep) = rebase_pdf(&o, data) {
            if rep.mode == RebaseMode::Incremental {
                assert!(rep.bytes.starts_with(orig));
            }
        }
    }
    if let Ok(o) = Pdf::open(data.to_vec(), None) {
        let _ = rebase_pdf(&o, orig);
    }
});
