# ADR 0003 — Incremental saves and `rebase`

* Status: accepted
* Date: 2026-09-25

## Context
SPEC §1: "Always keep the original bytes untouched until the user saves; edits are incremental updates.
Redaction, password changes and files > 150 MB are the only whole rewrites." Signed documents must keep
their signed byte ranges intact. PDFium (inside EmbedPDF) saves by rewriting the whole file.

## Decision

### Writer (`warraq_pdf::Pdf`)
* Edits go through `Pdf::set / add / delete` and are tracked as dirty/deleted object ids.
* `Pdf::commit` appends one update: `original bytes ‖ changed objects ‖ xref ‖ trailer ‖ startxref ‖ %%EOF`.
  The original is an **exact byte prefix** (tested for every mutating operation and RPC method).
* The update uses the same xref form as the latest section: a classic table when the original used one,
  a compressed xref stream (`/W [1 n 2]`, `/Index`) when it used xref streams. Hybrid files get a table.
* Trailer: `/Size`, `/Root`, `/Info`, `/Prev` (offset of the previous xref), `/ID [first-kept, new]`,
  `/Encrypt` copied verbatim (same object reference). Encrypted files without `/ID` keep it absent (R2–R4
  keys are derived from ID[0]).
* Deleted objects become free entries with generation + 1.
* Broken files: lopdf reconstructs the xref by scanning `N G obj`; for truncated files without any trailer we
  add a synthetic trailer pointing at the last `/Catalog` object. When the xref was reconstructed, `/Prev`
  cannot be trusted, so the update re-writes **all** live objects with a complete xref and no `/Prev` —
  still appended, still byte-prefix preserving, and the resulting file is valid.
* lopdf ignores free xref entries (a freed object "comes back" from an older section). Our loader walks the
  xref chain itself (`xrefscan.rs`) and drops objects whose newest entry is free.
* Full rewrite (`Pdf::write_full`): garbage-collects objects unreachable from `/Root` and `/Info`, renumbers
  compactly, drops earlier revisions, writes `Protection::{Keep, Remove, New}`. Used by `protect.*`,
  `doc.saveFull`, `pages.extract`, `pdf.merge`, and automatically by `commit` for files > 150 MB.
* After every commit the document is reloaded from the new bytes, so in-memory state is exactly what a
  reader of the file sees.

### Rebase (`warraq_pdf::rebase`)
1. Load the original (with its password) and the PDFium output (same password, or unencrypted).
2. For every object number in the edited file (skipping object-stream and xref-stream containers),
   compare with the original object of the same number **semantically**: key order, literal vs hex strings,
   `1` vs `1.0`, and stream `/Length`/`/Filter`/`/DecodeParms` are ignored when the decoded stream contents are
   equal (PDFium recompresses streams).
3. Append only changed/new objects as one incremental update on the ORIGINAL bytes; `/Root`/`/Info` come from
   the edited trailer.
4. Objects missing from the edited file are freed only if the merged graph no longer references them.
   Object-stream containers are never freed (older xref sections locate compressed objects through them).

### PDFium renumbering pitfalls (assumptions)
* PDFium's non-incremental save keeps the object numbers it parsed and numbers new objects above the old
  maximum. We **verify** this per file: if the catalog number changed, or an edited page number belongs to a
  non-page object in the original, numbering is declared unstable and every object of the edited file is
  appended (still incremental over the original bytes; larger, but correct). Reported as `renumbered: true`.
* Generation numbers are taken from the edited file; a changed generation counts as a change.
* Encrypted originals: PDFium may save decrypted. Appended objects are re-encrypted with the original file
  key, and the trailer keeps the original `/Encrypt` reference. If the edited file is encrypted with a
  *different* key, the user changed the protection in the viewer: the edited bytes are returned as-is
  (`mode: protectionChanged`) — a password change is a whole rewrite by definition.

## Consequences
* Earlier revisions (and signatures over them) remain byte-identical; `doc.revisions` can extract each one.
* Many small operations create many revisions; `doc.saveFull` compacts on demand.
* Semantic comparison decodes streams (bounded by `limits::decode_cap`) — a stream that fails to decode is
  treated as changed (safe direction).
