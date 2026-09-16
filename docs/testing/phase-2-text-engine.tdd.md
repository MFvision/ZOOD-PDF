# TDD evidence · Phase 2 text engine (first slice, 2026-09-16)

Source plan: brief §5 (global text engine) and ADR-0004/0005. Runner: `cargo test` in `packages/core`.

## User journeys
* As an Arabic reader, when I copy or search text in any PDF, I get logical-order Unicode regardless of how the producer stored glyphs.
* As an editor, when I add or replace Arabic text, the saved PDF renders shaped text and other viewers extract it correctly.

## Task reports (RED → GREEN)

| # | Behavior | Test | RED evidence (first run) | GREEN evidence |
|---|---|---|---|---|
| 1 | Bidi runs keep Latin+number runs together (W7) | `bidi::numbers_after_latin_belong_to_the_latin_run_w7` | passed on first run (library behaviour) | ok |
| 2 | `%` after a number stays with the number (W5) | `bidi::percent_after_a_number_stays_with_the_number_w5` | `left: "(%15) ةبيرض" right: "(15%) ةبيرض"` — unicode-bidi 0.3.18 resolves a trailing ET to the paragraph level | ok after `char_levels` W5 repair + own reordering |
| 3 | Base direction per UAX #9 P3 | `bidi::base_direction_detects_ltr_paragraph_with_arabic_words` | `left: Ltr right: Rtl` (test expected RTL for digits-only; spec says LTR) | ok after correcting the expectation |
| 4 | Presentation forms fold to letters, marks strip | `normalize::presentation_forms_fold_to_logical_letters`, `strip_marks_…` | passed first run | ok |
| 5 | Search normalization + byte map | `normalize::search_normalization_unifies_alef_taa_yaa_and_digits` | `left: [0,4,8,10] right: [0,4,8,12]` (wrong expected offsets) | ok |
| 6 | Search ignores tashkeel, unifies alef/taa marbuta, highlights whole word incl. trailing marks | `search::*` (2 tests) | `left: end 16 right: 18`; `left: "مرحبا" right: "مرحباً"` | ok after extending the range over trailing marks |
| 7 | HarfRust shaping equals HarfBuzz on Amiri (lam-alef, الله, بلا) | `shape::arabic_letters_get_contextual_forms_and_ligatures` | `left: 2 right: 1` (test assumed a single ligature glyph; HarfBuzz 12.1 via uharfbuzz also returns two glyphs: ids 2518, 2513) | ok with HarfBuzz reference glyph ids |
| 8 | Visual→logical round trip for 13 corpus sentences | `extract::visual_to_logical_round_trips_every_corpus_line` | four successive failures: `"1,200.00 | 1,200.00 | 1 | Pro Warraq"` (spaces broke Latin runs), `"(450.00 :(%15"` (W5), `"00.450"` (W4 separator), `"Thank you … شكرا"` (base direction) | ok after membership rules W4/W5/W7/N1 and rightmost-strong base rule |
| 9 | Marks stay on their base through reordering; ligature clusters not split | `extract::marks_are_attached_to_their_base_and_presentation_forms_folded` | `left: "\u{64e}كتب"`, then `left: "ال" right: "لا"` | ok after unit- and cluster-level reordering |
| 10 | Lines ordered top→bottom, content order irrelevant; gaps become spaces | `extract::reconstruct_lines_…`, `gaps_between_clusters_become_spaces` | passed first run | ok |
| 11 | PDF open/page size/metadata/500-page open < 1 s | `document::*` (3 tests) | passed first run | ok |
| 12 | AES-256 (R6) open with password | `document::encrypted_file_needs_the_password` | `left: 0 right: 3` — lopdf 0.45 loads 1 object and drops the rest | **ignored** with reason; Phase 2 implements the standard security handler |
| 13 | Replace a word with a new subset font + ToUnicode; error when absent | `ops::replace_word_embeds_a_new_subset_font_with_tounicode_and_reopens` | passed first run (ported from the Phase 0 prototype) | ok |
| 14 | Append a shaped Arabic line to a Chrome page | `ops::append_line_adds_shaped_text_to_a_chrome_page` | passed first run | ok |
| 15 | hayro backend renders and yields glyphs with advances and font size | `hayro_backend::renders_and_extracts_glyphs_with_advances` | compile errors (kurbo type paths, `BfString`, glyph API) then ok | ok |
| 16 | Core extracts logical text from the ideal file and searches with normalization | `core::extracts_logical_order_text_from_the_ideal_corpus_file` | passed first run | ok |
| 18 | Skeleton letters + recovered dot marks recompose (ٮ+dot below=ب, ٯ+two dots=ق, ه+two dots=ة) | `extract::skeleton_letters_with_combining_dots_recompose` | written after measuring Noto Naskh Arabic Type3 output; passed first run | ok |
| 17 | Core reads a Chrome/Skia file (presentation-form ToUnicode, visual glyph order) logically | `core::chrome_skia_file_with_presentation_form_tounicode_reads_logically` | `فاتورة ضريبية مب س طة` (advance mismatch with a variable font instance) | ok after the space-glyph-aware gap rule |

Final run: `warraq-text` 17 passed; `warraq-pdf` 5 passed, 1 ignored; `warraq-render` 1 passed; `warraq-core` 2 passed. `cargo clippy --all-targets -- -D warnings` clean.

## Coverage and gaps
* Not yet covered: no-ToUnicode fallbacks (glyph names, cmap, OCR), Type3 fonts, vertical text, paragraph/reflow, incremental save, encryption, the ambiguity "items 3" vs "3 items" (needs content-order tie-break).
* The corpus-wide extraction gate (all 24 truth files scored in CI) is the next test to add.

## Second slice (2026-09-16, later the same day): paragraphs, reflow and editing

| # | Behavior | Test | RED evidence | GREEN evidence |
|---|---|---|---|---|
| 19 | Lines group into paragraphs; justification is decided on the body lines, other alignments on all lines | `paragraph::justified_rtl_block_…`, `a_far_away_line_and_a_direction_change…`, `right_aligned_rtl_paragraph…` | `left: Justify right: Start` — a two-line paragraph has a one-line body, so both edges trivially "aligned" | ok after requiring ≥ 3 lines for justification |
| 20 | Greedy line breaking keeps every line inside the box and pins RTL lines to the right edge | `paragraph::layout_breaks_at_spaces_and_right_aligns_rtl_lines` | passed first run | ok |
| 21 | Justification stretches spaces on every line but the last | `paragraph::justification_stretches_spaces_on_every_line_but_the_last` | passed first run | ok |
| 22 | Text-showing operators are located in page space through Tm/Td/TD/T*/'/" and the CTM | `text_walk::*` (3 tests) | passed first run | ok |
| 23 | A page's leftover transform is reported and invertible | `text_walk::final_ctm_reports_an_unbalanced_page_transform_and_inverts_it` | written after the reflow demo drew text at 0.75× scale in the wrong place: Skia opens pages with `q 0.75 0 0 -0.75 0 842 cm` and never closes it | ok; both append paths now emit the inverse CTM first |
| 24 | Erasing a box blanks only the runs inside it and leaves the operators in place | `ops::erase_area_blanks_only_the_runs_inside_the_box` | passed first run | ok |
| 25 | A paragraph can be replaced and reflowed into its own box | `ops::replace_paragraph_reflows_arabic_into_the_box` | passed first run | ok |
| 26 | The core detects paragraphs, reflows one, saves, and the saved file reads back in logical order | `core::paragraphs_are_detected_and_one_can_be_reflowed_and_saved` | passed first run | ok |

Visual proof: `tests/acid/write-tests/reflow-compare.png` (before/after of a justified Arabic page; the replacement keeps shaping, right-to-left flow, Arabic-Indic digits and an embedded Latin run). Regenerate with `cargo run --release -p warraq-core --example reflow_demo -- . <stem> <para-index> "<text>"`.

Totals after this slice: 37 unit tests green (`warraq-text` 22, `warraq-pdf` 11 + 1 ignored, `warraq-render` 1, `warraq-core` 3), clippy clean, `wasm32-unknown-unknown` still compiles.

## Third slice: incremental save

| # | Behavior | Test | RED evidence | GREEN evidence |
|---|---|---|---|---|
| 27 | The previous revision's cross-reference style is detected (table vs stream) | `incremental::detects_the_previous_xref_style_of_both_corpus_layouts` | passed first run | ok |
| 28 | Reals are written as plain decimals and objects serialize exactly | `incremental::reals_are_written_as_plain_decimals`, `objects_round_trip_through_our_serializer` | written because `lopdf`'s writer is private, so we serialize ourselves | ok |
| 29 | An incremental save keeps the original bytes as a literal prefix and the edit survives reopening, for both xref styles | `incremental::an_incremental_save_keeps_the_original_bytes_as_a_prefix_and_reopens` | `the appended line must be in the reopened revision` — `cargo fmt` had reflowed the call sites so the dirty-object marking was never inserted; only the new font objects were being written | ok after marking the page, its content stream, resources and font dictionary |
| 30 | Saving with no edits returns the original unchanged | `incremental::saving_without_edits_returns_the_original_unchanged` | passed first run | ok |

Independent verification of an incrementally saved file (`tests/acid/write-tests/reflow-after.pdf`,
136,539 original bytes + 17,198 appended, 2 revisions):

| Reader | Result |
|---|---|
| PDFium 155 (pypdfium2) | 3 pages, page 1 text returned |
| qpdf 12 (pikepdf) | 3 pages, both revisions intact |
| PDF.js 6.3 | 3 pages, 1,168 text items |

Totals after this slice: 42 unit tests green (`warraq-text` 22, `warraq-pdf` 16 + 1 ignored, `warraq-render` 1, `warraq-core` 3), clippy clean, wasm32 compiles.
