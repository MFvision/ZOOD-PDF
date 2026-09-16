# Architecture Decision Records

One file per decision, numbered, never edited after acceptance (superseding
decisions get a new number and link back). Template: context, options, choice,
consequences, license implications.

| # | Title | Status |
|---|---|---|
| [0001](ADR-0001-working-name-and-license.md) | Working name "Warraq", Apache-2.0, no GitHub push until org is named | accepted (placeholders flagged) |
| [0002](ADR-0002-arabic-corpus-and-red-test-policy.md) | Arabic corpus as the gate; red Arabic test blocks merge | accepted |
| [0003](ADR-0003-core-stack.md) | Core stack: PDFium for rendering/objects, own Rust text engine, one core native + WASM | accepted at GATE 0 |
| [0004](ADR-0004-shaping-and-fonts.md) | HarfRust + fontations + unicode-bidi + subsetter + pdf-writer; rustybuzz rejected (archived) | accepted at GATE 0 |
| [0005](ADR-0005-text-extraction-strategy.md) | Own logical-order text reconstruction; never trust engine text order | accepted at GATE 0 |
| [0006](ADR-0006-owner-answers-after-gate-0.md) | Browser builds pure Rust by default; Persian/Urdu first-class; name, license, PDFium confirmed | accepted |
