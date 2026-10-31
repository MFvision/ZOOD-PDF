# hayro-syntax 0.7.2, patched for ZOOD PDF

Upstream: https://github.com/LaurenzV/hayro (Apache-2.0 OR MIT, unchanged licence;
see LICENSE-APACHE and LICENSE-MIT). Used through `[patch.crates-io]` in
`packages/core/Cargo.toml`. Every PDF is hostile input, and two things in 0.7.2
let a small file end the engine (in WebAssembly a stack overflow or a failed
allocation is a trap, not an error):

1. **Nesting limit.** `Skippable::skip` recursed once per `[` or `<<`, so an
   object or a content stream nested 100 000 deep overflowed the stack. Backported
   from 0.8.0: `skip_with_depth` and `MAX_OBJECT_NESTING_DEPTH = 64`
   (`src/reader.rs`, `src/object/{mod,array,dict,ref}.rs`).
2. **Decoded size cap.** Flate, LZW and RunLength decoded without bound, so a
   1 MiB stream inflated to 1 GiB. Each now stops at `MAX_DECODED_LEN`
   (128 MiB, `src/filter/mod.rs`) and fails the stream instead
   (`src/filter/{lzw_flate,run_length}.rs`).
3. **Picture size cap.** hayro-interpret pads a short picture to the size its
   dictionary claims, so `/Width 4294967295` asked for 12 GB. `Stream::decoded_image`
   now refuses a picture past `MAX_IMAGE_PIXELS` (2^27, `src/object/stream.rs`).

Tests: `packages/core/warraq-core/tests/hostile.rs`.
