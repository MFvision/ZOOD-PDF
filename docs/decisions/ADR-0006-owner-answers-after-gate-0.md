# ADR-0006 · Owner answers after GATE 0: browser builds stay pure Rust by default; Persian and Urdu are first-class; name, license and PDFium confirmed

**Status:** accepted · **Date:** 2026-09-16 · Source: owner reply "yes" to the end-of-session report (interpreted as approval of the recommendations and of both collected questions; anything mis-read can be reversed by a new ADR).

## Decisions
1. **Extension and web builds default to the pure-Rust rasterizer (hayro)** inside the single Warraq WASM module (1.96 MB gzipped). The PDFium WASM module (2.4 MB gzipped) becomes an optional, on-demand engine for the web app (encrypted files, forms fidelity) rather than a default download. Desktop and mobile use native PDFium. ADR-0003's "PDFium on every target" is narrowed accordingly; the `Renderer` trait makes this a build/runtime flag.
2. **Persian and Urdu are first-class targets for v1**: Eastern Arabic-Indic digits, پ چ ژ گ ک ی ٹ ڈ ڑ ں ے ھ, Nastaliq fonts in the fallback chain (Noto Nastaliq Urdu, OFL), and the yeh/kaf normalization stays line-scoped (Arabic code points only when a line has no Persian-specific letters). Corpus gets Persian and Urdu files with truth.
3. **Working name Warraq, Apache-2.0 and PDFium as the native rasterizer are confirmed.** GitHub organization and the permanent folder are still to be named; nothing is pushed.

## Consequences
* Web fidelity for encrypted files and form appearance streams depends on our own object layer (decryption in Phase 2) until the optional PDFium engine is wired.
* Corpus additions: Persian (Vazirmatn, OFL) and Urdu (Noto Nastaliq Urdu, OFL) generated files; search normalization tests for Persian digits.
