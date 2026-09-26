//! Fuzz the Edit tool's byte-faithful content lexer: the operations and gaps must always partition
//! the input and re-emit it byte for byte; rewriting with a splice per operation must not panic.
#![no_main]

use libfuzzer_sys::fuzz_target;
use warraq_edit::content::{parse, partition_ok, reemit, rewrite, Splice};

fuzz_target!(|data: &[u8]| {
    let Ok(c) = parse(data) else { return };
    assert!(partition_ok(data, &c));
    assert_eq!(reemit(data, &c), data);
    let splices: Vec<Splice> = c
        .ops
        .iter()
        .step_by(2)
        .map(|o| Splice { range: o.span.clone(), with: b"n".to_vec() })
        .collect();
    let _ = rewrite(data, &splices);
});
