//! Fuzz: the bounded zip reader (every entry) and the XML tree builder (no entity expansion).
#![no_main]

use libfuzzer_sys::fuzz_target;
use warraq_create::readers::{xml, zip::Zip};

fuzz_target!(|data: &[u8]| {
    if let Ok(z) = Zip::open(data) {
        for n in z.names().to_vec().iter().take(64) {
            if let Ok(b) = z.read(n) {
                let _ = xml::parse(&String::from_utf8_lossy(&b));
            }
        }
    }
    let _ = xml::parse(&String::from_utf8_lossy(data));
});
