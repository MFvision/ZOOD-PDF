# ADR 0018 — Accessibility tool: auto-tagging without moving pixels, reading order, alt text, PDF/UA-style checker

* Status: accepted
* Date: 2026-09-26

## Context
SPEC §3 "Accessibility": auto-tag with MCIDs without moving pixels, `/Lang` per span, a reading-order panel,
alt text, a PDF/UA-style checker with fixes. Constraints: incremental saves (original bytes stay a prefix),
hostile input (structure trees can be cyclic, deep, huge), Arabic first (Chromium draws right-to-left runs in
*visual* order inside `/ReversedChars`, so content order is not reading order), no GPL validators (no veraPDF).

## Decision

### Engine: new crate `warraq-a11y`, `a11y.*` in warraq-core
* **Structure model (`tree.rs`).** An existing `/StructTreeRoot` is read into an editable model: elements with
  their original dictionaries (unmanaged keys are written back unchanged), kids as element / MCR (with `Pg`,
  `Stm`) / OBJR / opaque. The walk is iterative with a visited set (cycles and shared elements become opaque kids,
  walked once), bounded in depth (128), elements (200 000) and kids per element (100 000); `RoleMap` resolution
  is bounded (16 hops). A tree that hits a bound is `truncated` and every write is refused (writing would drop
  what was not read). Writing rewrites only changed elements, the root and a **rebuilt `/ParentTree`** (flat
  `Nums`, one array per page/form stream from the elements' MCRs, OBJR entries), assigning `/StructParents` and
  `/StructParent` keys where needed.
* **Marked content per operation (`marked.rs`).** Over warraq-edit's byte-faithful operations: the MCID and
  artifact state each operation is drawn in, and the matching `BMC/BDC…EMC`, `BT…ET`, `q…Q` pairs. New
  sequences are only placed on ranges that nest (`balance`: the smallest range containing every partner, each
  operation scanned once); unmatched operators make a range unusable.
* **Linking operations to reading order (`pagemap.rs`).** warraq-text's logical-order words (with glyph boxes)
  are indexed in a grid; every text operator is linked to the words its glyphs fall in. A word's index is its
  logical rank, so the structure can follow reading order even though Chromium's right-to-left content is
  visual.
* **Auto-tagging (`autotag.rs`).** Per page: warraq-text paragraphs become H1–H6 (relative font size, document
  body size = character-weighted mode, heading sizes ranked), list items (labels: bullets incl. Arabic ones,
  Latin / Arabic-Indic / Persian digits with `.` `)` `-` `(n)`, Arabic abjad letters, roman numerals; the
  label word becomes `Lbl`, the rest `LBody`; consecutive items share one `L`) or P; warraq-office's ruled and
  aligned grids become Table/TR/TH/TD (first row TH with `/Scope /Column`, Row/ColSpan; cells in logical order,
  right-to-left tables reversed); image XObjects and inline images become Figure with a `/BBox`; Link
  annotations become Link elements holding the words they cover plus an OBJR; widgets Form, other annotations
  Annot. Running headers/footers (repeated within the outer 15 % across pages, digits ignored) and page numbers
  (`صفحة ١ من ٩`, `Page 3 of 9`, `- 3 -`) become `/Artifact <</Type /Pagination /Subtype /Header|Footer>>`;
  painted paths, shadings and graphic-only forms `/Artifact`; blank glyphs join their neighbours or become
  artifacts. Language: an element's `/Lang` is its words' dominant script language when it differs from the
  document's (Arabic → `ar`, `fa`/`ur` from their distinctive letters, Latin → `en`); runs of other-language
  words become a `Span` with its own `/Lang`. Operators of one owner that follow each other in content order and
  whose logical ranks are contiguous are wrapped in ONE `/Tag <</MCID n>> BDC … EMC` sequence at nesting-safe
  boundaries; a structure element's kids are sorted by logical rank. **Only insertions** are made (`Insert`,
  closers before openers at one position), and only streams with insertions are replaced (warraq-edit's page
  write-back), so every other content byte is identical and nothing moves. `/MarkInfo /Marked true`, page
  `/Tabs /S`, catalog `/Lang` (detected when missing), `/ViewerPreferences /DisplayDocTitle`, and Info `/Title` +
  XMP `dc:title` when the UI gives a title.
* **Partially tagged documents.** Existing tags are kept; content already inside an MCID or artifact is never
  re-wrapped (MCIDs never nest), new MCIDs start above the page's highest one, and new elements go into the
  existing `Document` element. **Retag all** first removes the MCIDs from the content (a `BDC` with other
  properties such as `/ActualText` becomes a `/Span`) and builds a new tree.
* **Edits (`edit.rs`).** Move among siblings, set type (H1–H6, P, L/LI/Lbl/LBody, Table/TR/TH/TD, Figure, …,
  `Artifact` = decorative), alt text (with `/Lang`), `/Lang` per element, decorative (its MCID sequences become
  `/Artifact BMC` in the content and the element leaves the tree; refused when it holds annotations), merge with
  the next sibling, split at a content boundary, document title and language.
* **Checker (`check.rs`).** A Matterhorn-inspired subset of ISO 14289-1 that a machine can decide — 22 rules:
  structure tree, `/Marked`, `/Suspects`, content tagged or artifact, MCIDs without an element, parent-tree
  consistency, standard types via RoleMap, title, DisplayDocTitle, document `/Lang`, per-passage language
  mismatches (script vs language in effect), Arabic presentation-form glyphs without `/ActualText`, figure alt
  text, heading levels not skipped, tables with TH, list structure, annotations tagged, `/Tabs /S`, form field
  `/TU`, fonts embedded, ToUnicode, and the `/Direction /R2L` trap. Each finding carries rule id, ISO clause,
  Matterhorn checkpoint where one clearly corresponds, object/page/element, an i18n key with params, severity
  and whether it is fixable (`auto`, `needsTitle`, `retag`, `manual`). `a11y.fix` repairs the selected rules in
  one incremental update (auto-tag untagged content/annotations, relevel headings, first row → TH, wrap lists,
  set `/Lang` or Spans, TU from the field's label on the same line, remove `/Direction`, …). **It is not a
  certified PDF/UA validator**; the UI and STATUS say so.

### Interface
* `app/AccessibilityPanel.tsx` in the shared side slot (`tools/panels.ts`). Untagged documents show the auto-tag
  form (title asked, language detected or chosen). Tagged documents: *Reading order* (elements in tree order with
  type badges and text in logical order; select, drag and drop among siblings, Alt+↑/↓, move buttons, type,
  language, merge, split, decorative), *Alt text* (every figure: text + language, save, decorative), *Check*
  (findings grouped by rule with ISO clause and Matterhorn id, fix one rule or all; asks for the title when the
  title rule needs it). The reading order is drawn over the current page (numbered boxes, clickable) by a portal
  into the viewer area, like the Edit surface.
* Reads run on a private engine copy of the document; every change goes through `coreEdit` (one incremental
  update, shared undo history, synchronous `switching`, the viewer reloads).

## Consequences
* Content that cannot be wrapped safely (unbalanced marked content, text inside other text's wrappers) stays
  untagged and the checker reports it; the auto-tagger never rewrites operators to make it fit.
* Heading and list detection are heuristics on layout; the panel exists to correct them.
* Form XObjects are tagged as a whole (Figure when they show text, artifact otherwise); MCIDs inside forms are
  read but not created.
* `hayro` is not in the default wasm, so the pixel-identity proof runs in Rust tests (`warraq-a11y/tests`), not
  in the browser.
