//! Fuzz link-target checks (percent decoding, host split, Punycode decoder, script checks).
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let s = String::from_utf8_lossy(data);
    let c = warraq_edit::url::check(&s);
    assert!(matches!(c.verdict, "ok" | "warn" | "reject"));
    let _ = warraq_edit::url::punycode_decode(&s);
});
