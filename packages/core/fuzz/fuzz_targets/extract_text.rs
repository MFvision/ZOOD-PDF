#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    if let Ok(doc) = warraq_core::Document::open(data.to_vec(), None) {
        let _ = doc.extract_text(0);
        let _ = doc.text_lines(0);
        let _ = doc.search("ا");
    }
});
