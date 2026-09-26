//! Fuzz the Accessibility tool: structure-tree reader (cycles, depth, size bounds), the listing,
//! the checker and auto-tagging on arbitrary files, plus the marked-content analysis and the
//! placement of new sequences on arbitrary content streams. Nothing may panic; a truncated tree is
//! never written back.
#![no_main]

use libfuzzer_sys::fuzz_target;
use warraq_a11y::autotag::{autotag, Options};
use warraq_a11y::marked::{analyze, balance};
use warraq_a11y::tree::Tree;

fuzz_target!(|data: &[u8]| {
    // Content streams: marks and balanced ranges.
    if let Ok(c) = warraq_edit::content::parse(data) {
        let none = |_: &[u8]| None;
        let m = analyze(&c, &none);
        let n = c.ops.len();
        if n > 0 {
            for (s, e) in [(0, n - 1), (n / 3, n / 2), (n / 2, n / 2)] {
                if let Some((lo, hi)) = balance(&c, &m, s, e.max(s), None) {
                    assert!(lo <= s && hi >= e.max(s) && hi < n);
                }
            }
        }
    }
    // Whole files.
    let Ok(pdf) = warraq_pdf::Pdf::open(data.to_vec(), None) else { return };
    let t = Tree::read(&pdf);
    assert!(t.elems.len() <= warraq_a11y::tree::MAX_ELEMS);
    let _ = warraq_a11y::structure::list(&pdf);
    let _ = warraq_a11y::check::check(&pdf);
    let Ok(mut p) = warraq_pdf::Pdf::open(data.to_vec(), None) else { return };
    let r = autotag(&mut p, &Options::default());
    if t.truncated {
        assert!(r.is_err());
    }
});
