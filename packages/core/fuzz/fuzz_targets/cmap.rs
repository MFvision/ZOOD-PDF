//! Fuzz the CMap parser (ToUnicode and encoding CMaps) and code lookup.
#![no_main]

use libfuzzer_sys::fuzz_target;
use warraq_text::cmap::CMap;

fuzz_target!(|data: &[u8]| {
    let m = CMap::parse(data);
    let mut rest = data.get(..64).unwrap_or(data);
    let mut steps = 0;
    while !rest.is_empty() && steps < 64 {
        let (code, len) = m.next_code(rest);
        let _ = m.lookup_unicode(code, len);
        let _ = m.lookup_cid(code, len);
        rest = rest.get(len.max(1)..).unwrap_or(&[]);
        steps += 1;
    }
});
