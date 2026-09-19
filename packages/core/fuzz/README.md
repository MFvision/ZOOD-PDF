# Fuzzing the parser

Seeds are the Arabic corpus (`tests/corpus/arabic/generated` and `realworld`).

```bash
cargo install cargo-fuzz
mkdir -p fuzz/corpus/open_document && cp ../../tests/corpus/arabic/*/*.pdf fuzz/corpus/open_document/
cargo +nightly fuzz run open_document -- -max_total_time=600
cargo +nightly fuzz run extract_text  -- -max_total_time=600
cargo +nightly fuzz run lex_content   -- -max_total_time=600
```

`lex_content` takes raw bytes as a page's content stream (and as a form that
draws itself): the content lexer must keep every range inside the stream and
in order, and listing, moving and deleting pictures must neither panic nor run
away. Seed it with a few real content streams, e.g. inflated from the corpus.

`cargo-fuzz` needs a nightly toolchain, so CI runs the stable harness
`warraq-core/tests/robustness.rs` on every pull request and the coverage-guided
targets in a scheduled nightly job.
