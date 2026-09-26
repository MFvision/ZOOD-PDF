# ADR 0014 — Edit tool: byte-faithful content rewriting, reflow with shaping, pictures, links, undo

* Status: accepted
* Date: 2026-09-26

## Context
SPEC §3 "Edit": text reflow + reshape with embedded font subsets (Amiri/Cairo/Inter), add text, pictures
(move/resize/crop/replace/rotate/delete) via a byte-faithful content lexer, links with confirm-before-open and
bidi-spoof rejection, undo/redo. Constraints: incremental saves (original bytes stay a prefix), hostile input,
Arabic that reads back in logical order (ActualText per word, never `/Direction /R2L`), artifacts (page marks)
excluded from editing, EmbedPDF owns the viewer.

## Decision

### Engine: new crate `warraq-edit`, `edit.*` in warraq-core
* **Content lexer (`content.rs`)** tokenises a content stream into operations whose byte spans, with the gaps
  between them (whitespace, comments), partition the input exactly. An edit is a list of splices over operation
  spans; every other byte (number formats, comments, junk) is left as is. Inline images are one operation
  (`BI … ID data EI`). Proven by a round-trip test on every corpus/fixture page, a stable smoke fuzz and the
  cargo-fuzz target `content_rewrite`.
* **Page write-back (`page.rs`)**: page `/Contents` streams are decoded and joined with `\n` (the bytes
  warraq-text reads). Only streams that contain a splice are replaced — by NEW stream objects, because content
  streams can be shared between pages. New drawing is appended as `[q] original… [Q new]`, so whatever graphics
  or text state the original leaves (CTM, clip, colour, Tc/Tw/Tz/Tr, which persist across `BT`) cannot leak in.
  Resources are copied to a direct dictionary on the page before adding fonts/XObjects (inherited or shared
  resource dictionaries are never modified).
* **Text blocks (`text.rs`)**: warraq-text's logical-order paragraphs with artifacts excluded
  (`include_artifacts: false`) are the blocks. Our own interpreter (`scan.rs`) records every text-showing
  operator with glyph boxes (warraq-text's font decoding) and assigns it to the paragraph containing its glyph
  centres. A block is editable when it owns ≥ 1 operator, none of its operators also draws another paragraph
  (`shared_operators`), it is not invisible text (`hidden`, e.g. OCR layers) and not vertical. Operators inside
  form XObjects are never touched (page marks and stamps live there).
* **Removing text** without moving anything else: when every show operator of a `BT…ET` goes, the `BT`, `ET`,
  positioning and show operators of that group are removed but state operators (`Tf`, `Tc`, colours, marked
  content) stay, because text state persists after `ET`. Otherwise each removed show becomes a number-only
  `[n] TJ` with exactly its advance when a kept show follows in the same line (`'`/`"` keep their `T*` and
  `Tw`/`Tc`).
* **Writing text (`layout.rs`, `fonts.rs`)**: paragraphs split on `\n`, UAX #14 break opportunities
  (`unicode-linebreak`), greedy fill of the box width, per-line bidi visual runs (`unicode-bidi`, paragraph
  direction from the text, else the block), per-character font choice with fallback, harfrust shaping, alignment
  (start = right for RTL). Each glyph is placed with its own `Tm` (exact shaping positions, independent of `/W`).
  One `/Span <</ActualText …>> BDC … EMC` per logical word (and per space); glyphs that hang outside their word's
  advance (e.g. a tanween over the following space) are drawn in an empty-ActualText span so extractors never
  merge the word with its neighbour. Fill only (`0 Tr`), no `/Direction`.
  **Fonts**: the block's own font is reused when it is Type0/Identity-H with an embedded TrueType program and an
  identity CID map, maps every new character through its cmap, keeps GSUB when the text needs Arabic joining and
  shapes without `.notdef` (Chrome's Latin subsets often qualify; Arabic subsets never do because they lack the
  new glyphs and layout tables — "adding glyphs to an existing subset" is not attempted). Otherwise a bundled
  face matching the style: Amiri (serif, also Latin), Cairo (Arabic sans) and Inter (Latin sans), bold instances
  via `subsetter`'s variable-font instancing, embedded as a new Type0/CIDFontType2 subset with `/W` from the
  subset's `hmtx` and a ToUnicode fallback. The font programs are warraq-create's
  (`packages/core/assets/fonts/`, `warraq_create::fonts::FontId::data`), so they are compiled in once.
* **Pictures (`images.rs`)**: listed from `Do` of image XObjects and inline images at page level with the CTM
  (unit square → page). Move/resize/rotate compute the new placement `N` and rewrite the `cm` right before the
  picture when it is the canonical `q … cm <picture> Q` (new `cm` = `N × C⁻¹ × cm`); otherwise the picture is
  wrapped in `q X cm … Q`. Crop is a clip rectangle in the picture's own unit square
  (`q x y w h re W n <picture> Q`), so it follows later moves. Replace embeds a new JPEG (DCTDecode, bounded
  marker walk) or PNG (png crate with limits, alpha → SMask) XObject fitted into the visible box; delete removes
  the operators; add appends `q N cm /ZImN Do Q`.
* **Links (`links.rs`, `url.rs`)**: list/add/update/delete `/Link` annotations (URI and GoTo; named destinations
  resolved through `/Dests` and the `/Names` tree, bounded). Every URI goes through `url::check`: bidi controls
  (U+202A–202E, U+2066–2069, U+200E/200F, U+061C, raw or percent-encoded), control characters and schemes other
  than http/https/mailto are **rejected**; mixed-script labels (UTS #39-style, CJK combinations allowed),
  whole-script look-alikes (all-Cyrillic/Greek letters that look Latin), bad Punycode and `user@host`
  credentials give **warn**: the engine refuses to write them unless `confirmHost` equals the decoded host, which
  the UI asks the person to type. The Punycode decoder is our own (RFC 3492, bounded) with a fuzz target.
* Mutating `edit.*` calls need the modify permission, commit one incremental update (encrypted files stay
  encrypted with the same key) and, when they fail, reload the last committed bytes so half-made objects never
  reach a later save.

### Interface
* **Edit surface** (`app/EditPanel.tsx`) covers the viewer while the tool is active: the current page rendered by
  PDFium plus overlays from the engine (text blocks, pictures, links) in page coordinates (rotation handled in
  `services/editor.ts`). Text is edited in a `<textarea dir="auto">` placed over its block with the block's size
  and line height; new text boxes get size/colour/font/alignment/bold. Pictures have corner handles, dragging,
  arrow-key nudging (1 pt, Shift = 10 pt, committed after a short pause), rotate ±90°, crop, replace, delete.
  Links are drawn by dragging and edited in a sheet. After each edit the app dispatches `CORE_REPLACED_BYTES`
  (synchronous `switching`), the viewer remounts on the new bytes and goes back to the page it showed.
* **Links in the viewer**: EmbedPDF's `autoOpenLinks` is off; its `onNavigate` event opens our confirm sheet
  (real host big and isolated, full address, problems; `warn` needs the host typed; `reject` cannot be opened).
  Opening uses `window.open(url, '_blank', 'noopener,noreferrer')`.
* **Unsaved viewer edits** (PDFium annotations) are folded into the bytes with `doc.rebase` before an engine edit,
  so nothing is lost and the result is still an incremental update.

### Undo/redo
* The Edit tool uses the app's **shared core-edit history** (ADR 0007, `services/history.ts`, `AppContext`
  `coreEdit` / `undoCore` / `redoCore`): a per-document stack of byte versions (before/after of each step),
  bounded to 40 steps and 400 MB, cleared on save, dropped after whole rewrites (redaction, protection). Edit and
  Organize steps therefore undo in one sequence. Because every engine edit is an incremental update, each
  version is a byte prefix of the next and "undo" is showing the previous version again. (While built alone, this
  tool first had its own stack whose versions shared one buffer as `subarray` prefixes — one copy of the newest
  file for the whole chain; merging onto the shared history was preferred over two competing undo stacks. That
  buffer-sharing remains a possible memory optimisation for `services/history.ts`.) Inverse operations were
  rejected: they would need an inverse for every edit kind and could not undo PDFium's changes.
* ⌘Z / ⇧⌘Z (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) and toolbar buttons act on this stack **while the Edit tool is
  open** (not while typing in a text field, where the browser's own text undo applies). Outside the Edit tool,
  EmbedPDF's own history (`history:undo`/`history:redo`, its Ctrl/⌘+Z shortcut) handles annotation edits in the
  viewer. The two do not merge: an engine edit remounts the viewer, which starts with an empty PDFium history;
  unsaved PDFium edits are first folded into their own history step (`doc.rebase`, "viewer"), so undoing the
  engine edit returns to the state that includes them.

## Consequences
* Untouched content bytes are provably unchanged (test compares operator bytes before/after).
* Replaced text is untagged content in tagged PDFs (the old MCIDs lose their content); re-tagging belongs to the
  Accessibility tool.
* Paragraph detection decides what a "block" is; justified text is re-set ragged (start-aligned); overflowing
  text grows the box downwards instead of shrinking the font.
* The bundled font programs are compiled in once: `fonts.rs` takes them from `warraq_create::fonts`.
