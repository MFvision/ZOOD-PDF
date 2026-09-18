# ADR-0008 — Page structure stays in Warraq's core; one entry point for tool operations

*Status: accepted on 2026-09-18 under ADR-0007's fallback clause. Narrows
ADR-0007 decision 1, which listed Organize and Combine under EmbedPDF.*

## Context

ADR-0007 put page operations under EmbedPDF and kept Warraq's own page code
"as the fallback for anything its engine does wrong". Building Organize showed
the fallback is the only route, for three measured reasons (the research
workflow's spikes against EmbedPDF 2.15.1's own WASM and the bundled PDFium):

* **EmbedPDF 2.15 cannot move or rotate pages.** Its page-edit plugin exists
  only in the 3.0 pre-release (`3.0.0-next.13`).
* **PDFium's importer breaks documents it merges.** It leaves a widget's
  `/Parent` pointing at the source file's object number, removes a link's or
  annotation's reference to a page not yet copied, and handles neither
  `/AcroForm /Fields`, bookmarks nor named destinations
  (`cpdf_pageorganizer.cpp`, chromium/8057).
* **EmbedPDF saves by rewriting the whole file**, so every change would drop
  the opened bytes as the prefix of the saved file, which Warraq keeps as a
  rule.

Separately, every new core operation cost edits to seven shared files — the
core façade, the WASM bindings, the desktop bridge and its handler list, and
the UI's protocol, worker and desktop routing — which makes each new tool slow
to add and two tools impossible to build side by side.

## Decision

1. **Organize and Combine are Warraq's core** (`warraq-pdf/src/pages.rs`):
   rotate, reorder, delete and insert a blank page as incremental updates of
   the open file (the page tree is flattened once, with the attributes pages
   inherited written onto each page); extract pages and combine files as new
   files written from scratch, in which every reference to a page left behind —
   a bookmark, link, form field, the structure tree — is cut before unreachable
   objects are dropped, so nothing of those pages travels with the new file.
   Combined files keep every form field, renamed where two share a name.
2. **One entry point for tool operations.** `Document::call(op, args, blobs)`
   and `call_static` for work without an open document: `op` is
   `"<tool>.<operation>"`, `args` JSON, `blobs` bytes both ways. The WASM
   bindings, the desktop host's `core_call` command (one raw frame: JSON length,
   JSON, blob count, length-prefixed blobs), the web worker and the UI's
   `RemoteDocument.call` / `CoreClient.callStatic` carry any operation without
   knowing it. A new tool adds `warraq-core/src/tools/<tool>.rs` and one line in
   `tools/mod.rs`.
3. **Organize runs with Warraq's engine holding the file**, like Edit text:
   EmbedPDF hands its current bytes over when the tool opens and reopens
   Warraq's when it closes (`warraqOwnsDocument`). While the file is on its way,
   the screen says so and nothing can be edited (`AppState.switching`).

## Consequences

* Page changes are byte-exact to undo (the file as it was is kept) and keep the
  opened bytes as the prefix of the saved file — except for an encrypted file,
  which Warraq's writer still saves as plaintext (STATUS, Next 1).
* Deleted pages stay recoverable from the file's earlier revision, like every
  incremental change; extracting writes a clean file without them.
* Combine keeps the first file's bookmarks and names only, and drops page
  labels, which would number the appended pages wrongly.
* The seven-file tax is paid once. OCR, Export, Compress and Compare add
  modules behind `call`.
