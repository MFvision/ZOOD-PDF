#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if let Ok(doc) = warraq_core::Document::open(data.to_vec(), None) {
        let _ = doc.page_count();
        let _ = doc.metadata();
        let _ = doc.page_size(0);
    }
});
