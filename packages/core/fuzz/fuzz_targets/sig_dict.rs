//! Fuzz signature-dictionary handling on whole documents: signature fields, /ByteRange and
//! /Contents parsing, verification (revision loading, CMS, modification diff, attack
//! checks), the field list, and finishing a pending timestamp with garbage.
#![no_main]

use libfuzzer_sys::fuzz_target;
use warraq_pdf::{Limits, Pdf};
use warraq_sign::verify::{list_fields, verify, VerifyOptions};

fuzz_target!(|data: &[u8]| {
    let limits = Limits {
        max_objects: 20_000,
        max_decode_size: 8 << 20,
        decode_ratio_floor: 1 << 20,
        max_pages: 500,
        ..Limits::default()
    };
    let Ok(pdf) = Pdf::open_with_limits(data.to_vec(), None, limits) else {
        return;
    };
    let _ = list_fields(&pdf);
    let _ = warraq_sign::sign::signature_slots(&pdf);
    let _ = verify(
        &pdf,
        &VerifyOptions {
            trusted_roots: Vec::new(),
            now: 1_790_358_029,
        },
    );
    let _ = warraq_sign::sign::finish(&pdf, data.get(..64).unwrap_or(data));
});
