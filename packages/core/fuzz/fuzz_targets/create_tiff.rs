//! Fuzz: own TIFF reader (IFD chain, LZW/Deflate/PackBits, CCITT pass-through).
//! Seeds: `tests/fixtures/create/scan.tif` (and the other fixtures).
#![no_main]

use libfuzzer_sys::fuzz_target;
use warraq_create::{create, CreateOptions, FileSpec};

fuzz_target!(|data: &[u8]| {
    let _ = create(
        &[(
            FileSpec {
                name: "scan.tif".into(),
                kind: Some("tif".into()),
            },
            data.to_vec(),
        )],
        &CreateOptions {
            merge: true,
            page_numbers: data.first().is_some_and(|b| b & 1 == 1),
            ..CreateOptions::default()
        },
    );
});
