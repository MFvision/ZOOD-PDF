# hayro-interpret 0.7.0, patched for ZOOD PDF

Upstream: https://github.com/LaurenzV/hayro (Apache-2.0 OR MIT, unchanged licence;
see LICENSE-APACHE and LICENSE-MIT; the Foxit fonts in `assets/` keep their own
licence, `assets/LICENSE_FOXIT`). Used through `[patch.crates-io]` in
`packages/core/Cargo.toml`. Neither problem is fixed upstream in 0.8.0.

1. **Work budget.** The nesting depth (50) alone does not bound the work: a form
   XObject that draws itself twice ran 2^50 times, so one page never finished.
   `interpret` now counts the content streams one top-level interpretation runs,
   nested ones included, and stops at `MAX_INTERPRETATIONS` (10 000,
   `src/interpret/mod.rs`). It also stops content streams nested more than
   `MAX_ACTIVE` (24) deep, whatever nests them: a Type3 glyph that shows text in
   its own font recursed past every check until the stack overflowed.
2. **Forms that draw themselves.** `draw_form_xobject` (`src/x_object.rs`)
   refuses a form XObject that is already being drawn on this thread: a loop
   of forms is never a picture, and was run until the limits above.
3. **CID width ranges.** `read_widths` and `read_widths2` (`src/font/cid.rs`)
   filled a map entry for every code of a `/W` range, so `0 4294967295 500`
   asked for gigabytes. A range now ends at CID 65 535, and one font's ranges
   fill 2^18 codes at most.

Tests: `packages/core/warraq-core/tests/hostile.rs`.
