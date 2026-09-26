//! Fuzz: Markdown reader → layout → PDF.
//! Seeds: `tests/fixtures/create/guide.md` (and the other fixtures).
#![no_main]

use libfuzzer_sys::fuzz_target;
use warraq_create::{create, CreateOptions, FileSpec};

fuzz_target!(|data: &[u8]| {
    let _ = create(
        &[(
            FileSpec {
                name: "guide.md".into(),
                kind: Some("md".into()),
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
