# ADR 0007 — Core edits on bytes, byte-version undo, Compress as a new file

* Status: accepted
* Date: 2026-09-25

## Context
Organize (rotate, reorder, delete, insert, replace, crop, trim), Combine and Compress are engine tools: PDFium
(EmbedPDF) cannot do them incrementally. The UI keeps documents as bytes (ADR 0006) and must keep the original
bytes as a prefix of every save (ADR 0003). Organize needs undo/redo; Compress is by nature a whole rewrite.

## Decision

**Engine calls on bytes.** `services/coreOps.ts#runOnBytes` opens a private engine document on the current bytes,
applies one or more calls in order (each commits one incremental update) and closes it. `AppContext`:
* `currentBytes(doc)`: the document's bytes; unsaved PDFium edits are first folded in with `doc.rebase` on the
  current bytes (after an applied redaction PDFium's whole rewrite is used instead, so no old content survives).
* `coreEdit(doc, calls, label)`: runs mutating calls and dispatches `CORE_REPLACED_BYTES` (the reducer flips
  `switching`, the viewer remounts on the new revision). The document's bytes always extend the original.
* `runOnDocument(doc, calls)`: read-only calls whose output is a new file (extract, split, compress).

**Undo = previous byte version.** Every core edit is an incremental update, so each version is a byte prefix of
the next and "undo" is showing the previous version again (`services/history.ts`, per document, bounded to 40 steps
and 400 MB). Redo is the same in the other direction; a new edit clears redo; a save clears the history (the
saved file is the new baseline). Unsaved viewer edits are recorded as their own step before undoing, so undo
never silently drops an annotation. Inverse operations were rejected: they would append more updates (the file
grows with every undo) and some operations (delete, replace, crop over an existing CropBox) have no cheap exact
inverse.

**Compress is a new file.** `doc.compress` never changes the open document: it returns a whole rewrite (object
streams + xref stream, pictures re-encoded, identical objects shared, unused objects dropped) that the user saves
as a copy or opens as a new, unsaved document. The sheet shows before/after sizes. The original's protection is
kept (`Protection::Keep`).

**Trim margins without a rasteriser.** hayro is not in the default wasm (several MB), so the content box is
computed from content streams: text boxes from warraq-text's interpreter (real font metrics), paths (ignoring
white fills), images and forms with the CTM (`warraq-core/src/ops/geometry.rs`). The same walker measures image
placements for Compress.

**Split delivers one ZIP.** Several files from one action are packed in a store-only ZIP written in TypeScript
(`services/zip.ts`, no dependency); the host saves it like any file (`mimeType: application/zip`).

## Consequences
* Every Organize step adds one revision (visible in `doc.revisions`); Compress writes a compact copy.
* Undo memory is bounded; very large documents keep fewer undo steps.
* Content-box trimming ignores clipping paths and shadings (it may keep a little more than the visible content).
