# `@warraq/core` — JS/WASM interface contract (Phase 1)

Produced by `pnpm build:core` (wasm-pack, target `web`) into
`packages/ui/src/core-wasm/` as `warraq_core.js` + `warraq_core_bg.wasm` + types.
The same Rust API is exposed natively to Tauri commands.

```ts
export default function init(input?: InitInput): Promise<InitOutput>; // must be awaited once
export function version(): string;                                       // e.g. "0.1.0"

export class RenderedPage { readonly width: number; readonly height: number; readonly rgba: Uint8Array; free(): void; }
export class TextLine   { readonly text: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly direction: "rtl" | "ltr"; free(): void; }

export class ParagraphInfo {
  readonly index: number; readonly text: string;
  readonly x: number; readonly y: number; readonly width: number; readonly height: number;
  readonly direction: "rtl" | "ltr";
  readonly alignment: "start" | "end" | "center" | "justify";
  readonly fontSize: number; readonly lineCount: number;
  free(): void;
}

export class Document {
  static open(bytes: Uint8Array, password?: string): Document; // throws Error(message) on failure
  page_count(): number;
  page_size(index: number): Float32Array;                       // [width_pt, height_pt] after /Rotate
  render_page(index: number, scale: number): RenderedPage;     // RGBA8, premultiplied alpha over white
  extract_text(index: number): string;                          // logical-order text, lines joined by "\n"
  text_lines(index: number): TextLine[];                         // for selection/highlight overlays
  search(query: string): Uint32Array;                            // page indices with Arabic-aware normalization
  metadata(): string;                                            // JSON: {title, author, producer, creator, pages, encrypted}

  // editing (Phase 2)
  paragraphs(index: number): ParagraphInfo[];                    // device space, same coordinates as text_lines
  replace_paragraph(index: number, para: number, text: string, font: Uint8Array): string; // JSON {lines_drawn, font_substituted}
  save(): Uint8Array;                                            // incremental update over the original bytes

  // tool operations (ADR-0008): one entry point for every tool's work
  call(op: string, args: string, blobs: Uint8Array[]): CallReply; // op "<tool>.<operation>", args JSON
  free(): void;
}

export interface CallReply { readonly json: string; readonly blobs: Uint8Array[]; free(): void }
export function call_static(op: string, args: string, blobs: Uint8Array[]): CallReply; // no open document
```

Tool operations (`warraq-core/src/tools`), all answering JSON plus bytes:

| op | args | answer |
|---|---|---|
| `pages.rotate` | `{pages: number[], quarterTurns: number}` (1 = 90° clockwise) | `{pageCount, pageSizes}` |
| `pages.reorder` | `{order: number[]}` (`order[k]` = current index of the page that becomes page k) | `{pageCount, pageSizes}` |
| `pages.delete` | `{pages: number[]}` (never every page) | `{pageCount, pageSizes}` |
| `pages.insert_blank` | `{at: number, like: number}` (size and rotation of page `like`) | `{pageCount, pageSizes}` |
| `pages.crop` | `{pages: number[], margins: {top, right, bottom, left}}` (points, as each page is shown) | `{pageCount, pageSizes}` |
| `pages.trim_margins` | `{pages: number[], padding?: number}` (points of white kept around what is printed; default 6; blank pages are left alone) | `{pageCount, pageSizes}` |
| `file.rebase` (static) | `{password?: string}` + the file as opened + the same file written whole by another engine (PDFium, through EmbedPDF) | `{rebased: bool}` + the file's own bytes with the changes appended, when `rebased` (not when the protection differs) |
| `pages.insert_file` | `{at: number, password?: string}` + the other file (its pages go in at `at`, with their form fields) | `{pageCount, pageSizes}` |
| `pages.extract` | `{pages: number[]}` (in that order) | `{pageCount}` + the new file |
| `pages.combine` (static) | `{passwords?: (string\|null)[]}` + one blob per file | `{pageCount}` + the new file |
| `marks.add` (static) | `{password?, mark, pages?: number[], replace?: bool (default true), replaceIds?: number[], fontBlob?, imageBlob?}` + the PDF, then the font and/or the PNG/JPEG at those blob indices. `mark`: `{kind: "watermark"\|"header"\|"footer"\|"pageNumber"\|"bates", text?, imageWidth?, position?: "topLeft"…"bottomRight"\|"center"\|"tiled", slots?: [start, centre, end], direction?: "auto"\|"rtl"\|"ltr", format?: "plain"\|"ofTotal"\|"pageOfEnglish"\|"pageOfArabic"\|"roman", start?, skipFirst?, prefix?, suffix?, width?, size?, color?: "#rrggbb", opacity?, rotation?, marginX?, marginY?, front?, numerals?: "western"\|"arabic", date?, fileName?, modified?}`; tokens `{page}` `{pages}` `{date}` `{file}` | `{id}` + the file with the mark, as an incremental update |
| `marks.preview` (static) | as `marks.add`, plus `{page, scale}` | `{width, height}` + RGBA of that page with the mark |
| `marks.list` (static) | `{password?}` + the PDF | `{marks: [{id, kind, front, spec, pages}]}` (`spec` is the `mark` it was made with) |
| `marks.remove` (static) | `{password?, ids?: number[], pages?: number[]}` (empty: all) + the PDF | `{removed}` + the file |
| `marks.text` (static) | `{password?, page}` + the PDF | `{marks, page}`: what Warraq's page marks on the page say, and what the page says without them (other programs' artifacts are part of the page) |
| `images.list` | `{page}` (also static, with `password?` + the PDF) | `{images: [{id, matrix, clip, pixels, inline, inForm, shared}]}`; `matrix` takes the unit square onto the page as shown (points, y down); `shared`: the bytes that draw it draw it elsewhere too (a form used twice or on another page, a content stream two pages list), so it is not edited. `E_EDIT` for a page past the walk's bounds |
| `images.add` | `{page, matrix}` + the PNG/JPEG | `{id}` |
| `images.transform` | `{page, id, matrix, clip?: [u0, v0, u1, v1]}` | `{images}`; a picture in a form may not leave the form's `/BBox` (`E_EDIT`) |
| `images.replace` | `{page, id}` + the PNG/JPEG (fitted inside what showed) | `{images}` |
| `images.delete` | `{page, id}` | `{images}`; the picture leaves the page's (or form's) resources too when nothing else there draws it — `images.replace` likewise for the old one |
| `links.list` | `{page}` (also static) | `{links: [{id, rect: [x, y, w, h], to: {uri} \| {page} \| {}}]}`; `id` is `"n.g"`, or `"#k"` for a link written straight into `/Annots` at place `k` (changed and removed in place) |
| `links.add` | `{page, rect, to: {uri} \| {page}}` (only `http`, `https`, `mailto`, at most 4096 bytes, nothing that hides itself — controls, bidi and other invisible format characters; see `allowed_uri`) | `{links, id}` |
| `links.update` | `{page, id, rect?, to?}` | `{links}` |
| `links.remove` | `{page, id}` | `{links}` |
| `redact.find` | `{query?: string, patterns?: ("email"\|"phone"\|"nationalId"\|"iban"\|"card"\|"date")[], custom?: string, pages?: number[]}` — words Arabic-aware as `search`, over all the page's text (running heads, footers and page marks included); `custom` is a Rust `regex` (≤ 1000 chars, compiled within size limits) | `{matches: [{page, text, before, after, kind, pageMark, rects: [{x, y, width, height}]}], total}` — `pageMark` for a match in a page mark محرر PDF drew; overlapping hits merged; rects are the glyph boxes in points from the top-left of the page as stored (before `/Rotate`), turned lines' included; empty when the reader cannot place the glyphs (never guessed); at most 5000 listed |
| `view.search` | `{query: string, matchCase?: bool, wholeWord?: bool}` — Arabic-aware as `search`: diacritics ignored, alef, taa marbuta, yaa and digit forms unified; case ignored unless `matchCase` | `{matches: [{page, text, before, after, truncatedLeft, truncatedRight, rects: [{x, y, width, height}]}], total}` — the search in EmbedPDF's view; `before`/`after` are whole words of the hit's line; rects as `redact.find`'s; at most 5000 listed |
| `view.text` | `{page, boxes: [{x, y, width, height}]}` — boxes in points from the top-left of the page as stored, as EmbedPDF measures glyphs (at most 100 000) | `{text, lines}` — the chars whose centre is in a box, in logical order, one line of the page per line: what Copy puts on the clipboard in EmbedPDF's view |
| `redact.inspect` (static) | `{password?}` + the file | `{findings: [{kind, count, details}], revisions, unreachable, signed, protected}`; kinds: metadata, scripts, attachments, comments, forms, hiddenLayers, bookmarks, thumbnails, privateData, links, hiddenText; each detail one of `{word, count}` (the core's own term: invisible, white, offPage, JavaScript, OpenAction, AA, Actions, Fields, XFA, XMP), `{subtype, count}` (an annotation kind), `{property, value, date}` (an Info entry; `date` ISO 8601 for CreationDate/ModDate) or `{name}` (from the file) |
| `redact.scrub` (static) | `{password?, remove: kind[]}` + the file | `{size}` + the file written whole without them, with no earlier revision and nothing unreferenced; `{refused: "protected"}` for a protected file |
| `outline.list` (static) | `{password?}` + the file | `{bookmarks: [{title, depth, page \| null, outside, open, children}]}` — `outside` for an entry that leaves the file (a web address, another file, a program); one with no page that is not is a heading |
| `attachments.list` / `.get` (static) | `{password?, key?}` + the file | `{attachments: [{key, name, description, size, mime, page \| null}]}` / `{name, size}` + the attachment's bytes (never opened) |
| `attachments.add` / `.remove` (static) | `{password?, name, description?}` + the file + the new file / `{password?, key}` + the file | the file with it, or without it, as an update |
| `layers.list` (static) | `{password?}` + the file | `{layers: [{id, name, visible, locked, print, export}], order: [{id \| label, children}]}` |
| `layers.show` (static) | `{password?, visible: id[]}` + the file | a copy whose default configuration shows exactly those (locked layers keep theirs), as an update |
| `layers.restore` (static) | `{password?, rebase?: bool}` + the file with its own visibility + the same file as it stands | the second with the first's visibility — as an update of the first when `rebase` |
| `signatures.verify` (static) | `{password?, now}` (Unix seconds) + the PDF, then certificates the person trusts (DER) | `{signatures: [...], emptyFields, certified, dss}`: per signature its status (`valid`, `untrusted`, `modified`, `invalid`, `unchecked` past the 30th), `signedBy` (the certificate's name) and `claimedName` (the unverified `/Name`), integrity, chain and trust (`trusted`, `webRoot` — one of Mozilla's roots, which vouch for web sites, not signers — `untrustedRoot`, `incomplete`, `broken`) with `purposeOk`, timestamp (`valid`, `trusted`), revocation, changes after it, problem codes, `trustCandidate`. See `warraq-sign/src/chain.rs` for the trust policy |
| `signatures.identity` (static) | `{p12Password, now?}` + a .p12/.pfx | `{name, issuer, notAfter, validNow, key, rsa, canSign}`; `E_P12_PASSWORD` for a wrong password |
| `signatures.sign` (static) | `{password?, p12Password, field?, page, rect?, lines, image?: {width, height}, name?, reason?, location?, contact?, time, offsetMinutes, certify?: 1\|2\|3, lockFields, pss, timestamp}` + the PDF, the .p12, a font for a visible signature, the picture's RGBA | `{done: true}` + the signed file; with `timestamp`, `{done: false}` + the prepared file, the signature and the RFC 3161 request for the host to send |
| `signatures.finish` (static) | the prepared file, the signature, the request, the authority's answer | `{done: true}` + the signed file; `E_TSA` for an answer that is not for this request |
| `signatures.prepare_document_timestamp` / `finish_document_timestamp` (static) | `{password?}` + the PDF / the prepared file, the request, the answer | the file with room for a document timestamp and its request / the stamped file |
| `signatures.fetches` (static) | `{password?, now}` + the PDF, trusted certificates | `{fetches: [{url, kind: ocsp\|crl\|certificate, about}]}` + each OCSP request body (empty for a GET) |
| `signatures.add_validation` (static) | `{password?, now, kinds}` + the PDF, one answer per `kinds` entry, trusted certificates | `{certs, ocsps, crls, rejected}` + the file with them in `/DSS` |
| `signatures.certificates` (static) | a certificate file (DER, PEM, PKCS#7) | `{certificates: [...]}` + each one's DER |
| `standards.pdfa_validate` (static) | `{password?, level?: "2b"\|"2u"\|"3b"\|"1b"}` + the PDF | `{level, findings: {total, passed, items: [{clause, rule, detail, page \| null, object \| null}]}, rules: [{rule, clause}]}` — Warraq's own validator; `rules` is what it checks (ISO 19005-2/-3 clause numbers, -1 for 1b) |
| `standards.pdfa` (static) | `{password?, level?, now (ISO 8601), title?, faces: [{name, serif}]}` + the PDF, then one font per `faces` entry (substitutes for fonts the file does not carry) | `{level, findings, substituted: [{font, face, missing}], unicodeAdded, changes: [{kind, detail}], size}` + the copy, written whole and validated; `{refused: "signed"}` or `{refused: "level", reasons}` (1b: transparency, layers, jpeg2000, deepImages) |
| `standards.pdfx_validate` (static) | `{password?}` + the PDF | `{findings, rules: [{rule, clause}]}` (PDF/X-4, ISO 15930-7) |
| `standards.pdfx` (static) | `{password?, now, title?, condition?, bleed?: points, faces}` + the PDF, the printer's ICC output profile, the fonts | as `standards.pdfa` + the PDF/X-4 copy (PDF 1.6); `E_EDIT: E_PROFILE…` for a profile that is not a printer's |
| `standards.profile` (static) | an ICC profile | `{profile: false}` or `{profile: true, class, space, version, description, press}` (`press`: an output profile that converts both ways) |
| `standards.preflight` (static) | `{password?, minPpi?: 150, hairline?: 0.25}` + the PDF | `{items: [{check, severity: "error"\|"warning"\|"info", detail, pages}], sizes: [{width, height, pages}], fonts, images, truncated}` |
| `accessibility.plan` (static) | `{password?}` + the PDF | `{source: "structure"\|"reading", tagged, plan: {lang, title, pages: [{width, height, blocks: [{role, rect: [x0, y0, x1, y1], lang, alt, list, cells, pagination, text}]}]}}`; rects in points on the page as shown, y down; roles `H1`–`H6`, `P`, `LI`, `Table`, `Figure`, `Caption`, `Artifact` |
| `accessibility.tag` (static) | `{password?, plan}` (as `plan` answers, reordered or relabelled) + the PDF | `{elements, sequences, artifacts, spans, annotations, bookmarks}` + the tagged file, as an update; the old structure is replaced |
| `accessibility.check` (static) | `{password?}` + the PDF | `{checks: [{id, clause, wcag, status: "passed"\|"failed"\|"warning"\|"manual", detail, pages, fix}]}` |
| `accessibility.fix` (static) | `{password?, fixes: ("title"\|"displayTitle"\|"language"\|"tabOrder"\|"fieldTooltips"\|"bookmarks")[], title?, lang?}` + the PDF | `{applied: {fix: count}}` + the file, as an update |
| `accessibility.figures` (static) | `{password?}` + the PDF | `{figures: [{id: "n g", page, rect \| null, alt}]}` |
| `accessibility.alt` (static) | `{password?, alts: [{id, alt}]}` + the PDF | `{set}` + the file, as an update |
| `export.tables` | `{page}` | `{items: [...]}` top to bottom: `{kind: "table", ruled, direction, widths: number[] (points, left to right), rows: (({text, rows, columns}) \| null)[][]}` (`null` where a merged cell covers) and `{kind: "line", text, direction, cells: [{text, x0, x1, direction}]}` — tables from the page's ruling lines (`RenderDoc::rulings`) or its columns of text, text in reading order |
| `export.picture` | `{page, scale}` | `{width, height, textHidden}` + RGBA of the page drawn without its text (`warraq-pdf/src/textless.rs`); `textHidden` when all its text was invisible (a scan's text layer) |
| `create.document` (static) | `{page: {width, height, margins: [t, r, b, l], header?, footer?}, blocks, header?, footer?, fonts: blobIndex[], fontNames?, pictures?: blobIndex[], title?, lang?, created?}` + the faces (TTF/OTF) and pictures (PNG, JPEG, GIF, BMP, WebP, TIFF). Blocks: `{type: "text", text \| runs: [{text, bold?, italic?, underline?, strike?, color?: "#rrggbb", link?}], size?, bold?, italic?, color?, align?: "start"\|"center"\|"end"\|"justify", dir?: "auto"\|"rtl"\|"ltr", spaceBefore?, spaceAfter?, indent?, marker?, keepWithNext?, spacing?, shade?, preserve?}`, `{type: "table", rows: [{text, bold?, align?, dir?, span?, fill?}][], widths?, headerRows?, dir?, size?}`, `{type: "image", index, width?, height?, align?}`, `{type: "frame", x, y, width, height, fill?, line?: {color, width}, inset?, anchor?: "top"\|"middle"\|"bottom", blocks}` (placed on the page, y down), `{type: "page", width, height, margins?, background?}`, `{type: "pageBreak"}`, `{type: "rule"}`; `\uE000` / `\uE001` in a header or footer are the page number and count | `{pages, missingGlyphs, picturesLeftOut}` + the new PDF |
| `create.images` (static) | `{paper: "own" \| {width, height}, orientation?: "auto"\|"portrait"\|"landscape", margin?, title?, created?}` + the pictures, one page each (every page of a TIFF), upright by EXIF, JPEG unchanged | `{pages, leftOut: number[]}` + the new PDF |
| `forms.inspect` (static) | `{password?}` + the PDF | `{xfa: none\|static\|dynamic, order: name[], fields: [{name, type, value, tooltip, readOnly, widgets: [{page, rect}], scripts: {keystroke, format, validate, calculate}, supported, format, range, calculate}], notRun: [{place, page?, field?, event, text}]}` — rects as shown, `[x0, top, x1, bottom]` |
| `forms.detect` (static) | `{password?, pages?: number[]}` (every page when empty) + the PDF | `{pages: [{index, width, height, fields: [{kind: text\|checkbox\|date\|hijri\|signature, name, tooltip, rect, rtl, source, pattern}]}]}`, names unique in the file |
| `forms.create` (static) | `{password?, fields: [{page, kind, name, tooltip, rect, rtl, pattern?}]}` + the PDF | `{created: name[]}` + the file with the fields, as an update |
| `forms.set_actions` (static) | `{password?, fields: [{name, format?: {kind: number\|percent\|date\|hijri, …} \| null, range?: {min?, max?} \| null, calculate?: {op, fields} \| {expression} \| null}]}` (a key left out is left as it is; `null` removes it) + the PDF + a font | `{ok: true, changed}` + the file, calculated values stored and drawn; or `{ok: false, error: {kind: noField\|cycle\|expression, …}}` and no file |
| `forms.check_expression` (static) | `{expression, fields: name[]}` | `{ok, uses?, typed?, error?: {kind: syntax\|unknownField\|empty\|tooLong, start, end, name?}}` |
| `forms.recalculate` (static) | `{fields: [{name, value, keystroke?, format?, validate?, calculate?}], order, changed?}` | `{normalized?, rejected?: {kind: number\|date\|hijri\|special\|range, …}, values: {name: value}, shown: {name: {text, red}}}` — only the subset `warraq_pdf::forms::script` parses is run |
| `forms.drop_xfa` (static) | `{password?}` + the PDF | `{dropped}` + the file without `/XFA` (and `/NeedsRendering`), as an update |
| `forms.fix_appearances` (static) | `{password?}` + the PDF + a font, optionally + the file as it was opened | `{fields, comments}` + the file with Arabic and formatted values drawn; when the opened file is signed, only annotations changed since are redrawn |
| `ocr.add_text_layer` (static) | `{password?, pages: [{index, words: [{text, bbox: [x0, top, x1, bottom]}], angle?, replace?: bool, image?: blob index}], modified?: "D:…"}` + the PDF + a font + the cleaned-up pages (PNG/JPEG: the whole page as shown, straightened by `angle`) | `{pages, words, skipped, images, imagesKept}` + the file with an invisible, shaped layer, as an update; `replace` takes Warraq's earlier layer on the page out first; `image` replaces a page that is one scanned picture (its words are then written level); the words are kept in the page's `/PieceInfo /Warraq` |
| `ocr.layer_words` (static) | `{password?, pages?: number[]}` + the PDF | `{pages: [{index, angle, words: [{text, bbox}]}]}` — the words kept with each layer Warraq wrote (what an OCR correction starts from) |
| `library.open` (static) | `{}` + the index's bytes (no blob, or an empty one, for a new index) | `{handle, documents, words}` — an index held in memory behind a handle until `library.close`; `E_INDEX` for one that cannot be read |
| `library.add` (static) | `{handle, key, name?, kind?, modified?, bytes?, pages?, password?, now?, text?: [{page, text}]}` + the file's bytes (leave the blob out when `text` is given) | `{added, skipped?, pages, chars, date?, guessedKind, truncated}` — reads a PDF's text with Warraq's own reader; `text` is for the kinds the core does not open (Word, Excel, HTML, a scan the interface read with OCR) |
| `library.forget` (static) | `{handle, keys: string[]}` | `{documents}` — the files are never touched, only the index |
| `library.search` (static) | `{handle, query, limit?, offset?, filters?: {kinds?, folders?, tags?, from?, to?, scannedOnly?}}` | `{total, hits: [{key, name, page, line, text, spans: [[start, length]], score, date?, kind, tags}]}` |
| `library.document` (static) | `{handle, key}` | `{key, name, kind, pages, chars, date?, tags, indexed, modified, bytes, path?}` |
| `library.tag` (static) | `{handle, key, add?: string[], remove?: string[]}` | `{tags}` — by hand; a tag taken off is remembered, so no rule puts it back |
| `library.rules` (static) | `{handle, set?: [{tag, words: string[], all?, enabled?, scope?: "text"\|"name"\|"both", kinds?}], apply?: bool}` | `{rules, tagged}` — read the tag rules, replace them, and run them over what is already indexed |
| `library.stats` (static) | `{handle}` | `{documents, pages, words, bytes, kinds: {kind: count}, tags: {tag: count}}` |
| `library.save` (static) | `{handle}` | `{bytes}` + the index's bytes, for the host to write where the person's data lives |
| `library.close` (static) | `{handle}` | `{}` |

## The Library (`tools/library`)

One search across a whole folder of files instead of the open one. The index is
a cache and never the documents: no file is read except through the bytes a
host hands over, nothing is written back to any file, and nothing reaches the
network.

**`key`** is the host's own stable name for a file — its full path on the
desktop, the folder handle's id plus the relative path in the browser. Folder
filters match it as a prefix ending at `/` or `\`, so `/دفتر/2026` does not take
in `/دفتر/2026-قديم`. `library.document` echoes it back as `path` when it looks
like one.

**`kind`** is `pdf` | `scan` | `image` | `word` | `excel` | `powerpoint` |
`html` | `text` | `markdown`. A word this build does not know is taken as no
answer (the file name's ending decides instead) rather than failing a run over
a folder. **`guessedKind`** is what the core settled on: a PDF whose pages carry
no text is a `scan`, which the interface reads with OCR and hands back as
`text` under the same key.

**What comes back from `library.add`.** `added` is false with a `skipped`
reason: `unchanged` (the key is in the index and neither the file's `modified`
time nor its size has changed), `password` (a protected PDF and no password, or
the wrong one), `unreadable` (the bytes are not a PDF the core can open),
`tooLarge` (past 256 MB), `indexFull` (the index is at its cap — see below).
`truncated` says the document was longer than the index takes and the rest of
it is not in there. A password is used to open the file and never written into
the index.

**How a search is ranked.** The query is read the way the find bar reads one —
tashkeel and tatweel dropped, alef, taa marbuta, yaa and the Arabic-Indic and
Persian digits unified, case folded — then matched whole word to whole word.
The query's last word also matches as a beginning (three letters or more, up to
32 words of the index), so results narrow as the person types. A query inside
quotation marks (`"…"`, `«…»`, `“…”`) asks for that phrase and nothing else.

A document's score is Okapi BM25 over the query's words (k₁ = 1.2, b = 0.75),
multiplied by how much of the query it holds and by what those words do
together:

```
score = Σᵢ idf(tᵢ)·tf(fᵢ, len) · coverage² · (1 + 2·ln(1+phrases) + ½·ln(1+lines))
```

* **A phrase beats the same words scattered**: `phrases` counts the places
  where the query's words stand together, in order, on one line.
* **More matches beat fewer**, with diminishing returns (that is `tf`).
* **A shorter document beats a longer one on the same count**: `tf` divides by
  the document's length against the average (b = 0.75).
* **Holding the whole query beats holding half of it**, by the square of the
  fraction held; a rarer word counts for more, because `idf` rises as fewer
  documents hold it.

Hits are lines. Within a document they are ordered by what each line does — the
phrase first, then more of the query's distinct words, then more often, then by
page and line. `page` counts from zero and `line` is which line of that page it
is, counting from zero. `spans` are byte ranges of `text` that answered, so the
interface marks the match over the person's own writing, marks and all.
`total` is how many hits were ranked, at most 5 000 (50 from any one document),
and `offset`/`limit` page through that ranking. `score` is the document's; every
hit of one document carries the same one.

A file that is a copy of another — the same report in two folders — is answered
under both names from one stored text.

**The document's own date** (`date`, `YYYY-MM-DD` Gregorian) is read from the
document's first three pages, never from the file's timestamp:

* `3/4/2026`, `03-04-2026`, `2026-04-03`, `٣/٤/٢٠٢٦`; `3 أبريل 2026`,
  `3 نيسان 2026`, `3 April 2026`, `April 3, 2026`; `3 رمضان 1447هـ`,
  `١٥ ذو الحجة ١٤٤٦`.
* A four-digit number first is read year-month-day. Otherwise the four-digit
  part is the year and, of the two left, the first is the day — unless that is
  impossible (`4/25/2026` can only be month-day). A two-digit year is 19xx from
  69 up, 20xx below it (POSIX).
* A date is Hijri when its month is a Hijri month, when هـ or AH follows it, or
  when its year is between 1300 and 1500 with nothing saying otherwise; it is
  then converted through Umm al-Qura (`warraq_pdf::forms::hijri`).
* Of the dates found, the best wins: **+4** for one right after a label
  (التاريخ، بتاريخ، صدر في، حرر في، Date, Dated, Issued), **+2** for the first
  page, **+2** for a month written out rather than numbered, **+1** for the top
  quarter of its page, **+1** for carrying هـ or م. Ties go to the date that
  comes first. A date that does not exist — 31 February, a Hijri day past the
  end of its month — is thrown away, not corrected, and a document with no date
  has none.

**Tags and rules.** `library.tag` puts tags on and takes them off by hand; a tag
taken off is remembered, so a rule never argues with its owner. A rule is a tag
and the words that call for it (each a word or a phrase), looking at the text,
the file name or both, and may be narrowed to some kinds. `library.rules` reads
them, replaces them, and with `apply` runs them over everything already
indexed. Rules live in the index and go nowhere else.

**What it holds, and its bounds.** The index keeps each document's text lines,
its words' places and what the host said about the file — never the file's
bytes. Documents whose text is identical share one copy of it, keyed by
SHA-256. The caps: 200 000 documents; 20 000 pages, 400 000 lines, 2 000 000
characters and 400 000 words per document; 20 000 characters per line;
4 000 000 distinct terms; 48 000 000 characters in the whole index (about
150 MB held), past which `library.add` answers `indexFull`; 64 tags on a
document and 200 rules; eight indexes open at once. Anything past a cap is cut
with `truncated` or skipped with a reason — never a failure that stops a run
over a folder.

**The index file.** `"WRQLIB"`, a version, then the texts, the terms, the
documents and the rules, little-endian with LEB128 varints and delta-coded runs,
ending in eight bytes of SHA-256 over the rest. `library.save` writes the live
records only, so saving is also what compacts an index that has forgotten
things. Reading one treats it as hostile input — every count checked against
the bytes that are left before anything is allocated, every string validated as
UTF-8, every reference checked against what was read — and refuses a damaged,
truncated or foreign file with `E_INDEX` instead of loading half of it.
(`packages/core/fuzz/fuzz_targets/library_index.rs`.)

**`now`** is Unix seconds, because the core has no clock of its own in the
browser; without it `library.document` answers `indexed: 0`.

**`library.stats`'s `bytes`** is an estimate of what the index takes, counted
the way the file is written; `library.save` writes the real thing. On the
Arabic corpus the two are within a few per cent, and a test keeps them within
a quarter of each other.

Signing never reaches the network: the core builds a request and takes the answer; the desktop host sends it (`net_exchange`), and signs on a smart card through `pkcs11_certificates` / `pkcs11_sign`, which call `tools::signatures::sign_with` with a card-backed `warraq_sign::keys::Signer`.

Errors add `E_ARGS` (arguments that do not parse), `E_UNKNOWN_OP`, and
`E_INDEX` (a Library index that cannot be read).

Rules: every method is synchronous and pure; the host puts the module in a
Web Worker (extension: offscreen document). Errors are `Error` objects with an
English message and a stable `code` prefix (`E_PARSE`, `E_PASSWORD`, `E_RENDER`).
Never pass file paths: hosts read bytes and hand them over.
