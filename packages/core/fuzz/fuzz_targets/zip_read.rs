//! Fuzz the bounded ZIP reader (warraq-office).
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = warraq_office::zip::read(data, 16 << 20);
});
