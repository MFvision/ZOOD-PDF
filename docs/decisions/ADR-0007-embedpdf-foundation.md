# ADR-0007 — Rebuild the interface on EmbedPDF; Warraq's core keeps Arabic

*Status: accepted by the owner on 2026-09-18. Supersedes the "every tool from
scratch" path implied by ADR-0003 for everything except Arabic text.*

## Context

After three days, one of thirteen tools worked. The rest carried a "Later"
badge, which the owner rightly judged to be no product at all. He asked for a
solution from GitHub rather than more hand-built engines.

The survey (docs/research/03-embedpdf-spike.md, licence files read live):

* **Stirling-PDF** (92k stars) is the most complete open-source PDF toolkit, but
  its engine, proprietary features and desktop app are under the Stirling PDF
  User License, which requires a paid subscription for production use. Warraq
  cannot ship it.
* **BentoPDF** (15.6k stars) runs every tool in the browser with no account, but
  it is AGPL-3.0, which would make Warraq AGPL, and its added-text path does not
  shape Arabic.
* **EmbedPDF** (4.5k stars) is PDFium compiled to WASM with an SDK and plugins —
  annotation, form, signature, redaction, stamp, page editing — under Apache-2.0
  (the npm packages declare MIT; only its CloudPDF server is source-available).
  It is the same engine the desktop app already bundles.

The spike ran EmbedPDF's engine on the Arabic corpus. Redaction removes content
for real, encryption is AES-256, merging works, and existing Arabic renders
well. New Arabic text — a filled form field, a FreeText comment — is stored
correctly but drawn with a standard font that has no Arabic glyphs, so it is
invisible.

## Decision

1. **EmbedPDF is the foundation** for rendering and for the tools its engine
   provides: Organize and Combine (page operations, merge), Comment
   (annotations), Fill & Sign (forms, signatures, stamps), Protect (AES-256),
   Redact, image insertion, metadata. One engine everywhere: PDFium as WASM in
   browsers, the same PDFium natively on desktop.
2. **Warraq's Rust core keeps what nobody else does well:** reading Arabic in
   logical order, editing Arabic paragraphs with reflow, and — new — generating
   **appearance streams for new Arabic text** (form values, FreeText comments,
   typed signatures, stamps): HarfRust-shaped, with a subset of a bundled face
   embedded and a correct ToUnicode. It runs after EmbedPDF sets the value and
   before the bytes are saved.
3. **The tools EmbedPDF lacks come from licence-clean components:** OCR from
   Tesseract (Apache-2.0; tesseract.js in browsers, native on desktop, OCRmyPDF
   under MPL-2.0 as a separate process if needed), compression and structural
   repair from qpdf (Apache-2.0), export to text and images from the engines we
   have, AI bring-your-own-key. Export to Word keeps its honest limit: layout
   fidelity for Arabic is not achievable, so it produces flowing RTL paragraphs.
4. **A tool is done when its end-to-end spec passes** in `apps/web/e2e` through
   the real interface, including Arabic cases and a save-and-reopen. No tool is
   shown as working before that, and the "Later" badge disappears tool by tool
   as each one passes.

## Consequences

* Most of the custom viewer in `packages/ui/src/viewer` is replaced by
  EmbedPDF's viewer and plugins; the RTL-first shell, i18n, Arabic editing and
  the file handling fixed on 2026-09-17 stay.
* Warraq gains its first appearance-stream generator in `warraq-pdf` — the
  single component standing between EmbedPDF and correct Arabic forms and
  comments. It needs the same verification as text editing: shaping, tashkeel,
  mixed-direction digits, and extraction of what it writes.
* The WASM payload grows by about 2 MB gzipped, to about 4.6 MB — within N8.
* Licence register gains EmbedPDF (Apache-2.0/MIT), Noto Naskh Arabic (OFL,
  optional fallback) and, when added, Tesseract and qpdf. No copyleft enters.
* EmbedPDF is younger and smaller than pdf.js. Its page-edit plugin is only in a
  3.0 pre-release; pin versions, and keep Warraq's own lopdf page operations as
  the fallback for anything its engine does wrong on Arabic files.
