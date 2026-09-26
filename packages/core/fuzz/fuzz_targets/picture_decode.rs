//! Fuzz picture decoding for replace/add (JPEG marker walk, PNG via the png crate with limits).
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = warraq_edit::images::decode_picture(data);
    let _ = warraq_edit::images::jpeg_info(data);
});
