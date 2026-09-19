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
| `marks.text` (static) | `{password?, page}` + the PDF | `{marks, page}`: what the page's artifacts say, and what the page says without them |
| `images.list` | `{page}` (also static, with `password?` + the PDF) | `{images: [{id, matrix, clip, pixels, inline, inForm, shared}]}`; `matrix` takes the unit square onto the page as shown (points, y down) |
| `images.add` | `{page, matrix}` + the PNG/JPEG | `{id}` |
| `images.transform` | `{page, id, matrix, clip?: [u0, v0, u1, v1]}` | `{images}` |
| `images.replace` | `{page, id}` + the PNG/JPEG (fitted inside what showed) | `{images}` |
| `images.delete` | `{page, id}` | `{images}` |
| `links.list` | `{page}` (also static) | `{links: [{id, rect: [x, y, w, h], to: {uri} \| {page} \| {}}]}` |
| `links.add` | `{page, rect, to: {uri} \| {page}}` (only `http`, `https`, `mailto`) | `{links, id}` |
| `links.update` | `{page, id, rect?, to?}` | `{links}` |
| `links.remove` | `{page, id}` | `{links}` |
| `redact.find` | `{query?: string, patterns?: ("email"\|"phone"\|"nationalId"\|"iban"\|"card"\|"date")[], custom?: string, pages?: number[]}` — words Arabic-aware as `search`; `custom` is a Rust `regex` (≤ 1000 chars, compiled within size limits) | `{matches: [{page, text, before, after, kind, rects: [{x, y, width, height}]}], total}` — rects are the glyph boxes in points from the top-left of the page as stored (before `/Rotate`); at most 5000 listed |
| `redact.inspect` (static) | `{password?}` + the file | `{findings: [{kind, count, details}], revisions, unreachable, signed, protected}`; kinds: metadata, scripts, attachments, comments, forms, hiddenLayers, bookmarks, thumbnails, privateData, links, hiddenText |
| `redact.scrub` (static) | `{password?, remove: kind[]}` + the file | `{size}` + the file written whole without them, with no earlier revision and nothing unreferenced; `{refused: "protected"}` for a protected file |
| `outline.list` (static) | `{password?}` + the file | `{bookmarks: [{title, depth, page \| null, open, children}]}` |
| `attachments.list` / `.get` (static) | `{password?, key?}` + the file | `{attachments: [{key, name, description, size, mime, page \| null}]}` / `{name, size}` + the attachment's bytes (never opened) |
| `attachments.add` / `.remove` (static) | `{password?, name, description?}` + the file + the new file / `{password?, key}` + the file | the file with it, or without it, as an update |
| `layers.list` (static) | `{password?}` + the file | `{layers: [{id, name, visible, locked, print, export}], order: [{id \| label, children}]}` |
| `layers.show` (static) | `{password?, visible: id[]}` + the file | a copy whose default configuration shows exactly those (locked layers keep theirs), as an update |
| `layers.restore` (static) | `{password?, rebase?: bool}` + the file with its own visibility + the same file as it stands | the second with the first's visibility — as an update of the first when `rebase` |
| `signatures.verify` (static) | `{password?, now}` (Unix seconds) + the PDF, then certificates the person trusts (DER) | `{signatures: [...], emptyFields, certified, dss}`: per signature its status (`valid`, `untrusted`, `modified`, `invalid`), signer, integrity, chain and trust, timestamp, revocation, changes after it, `trustCandidate` |
| `signatures.identity` (static) | `{p12Password, now?}` + a .p12/.pfx | `{name, issuer, notAfter, validNow, key, rsa, canSign}`; `E_P12_PASSWORD` for a wrong password |
| `signatures.sign` (static) | `{password?, p12Password, field?, page, rect?, lines, image?: {width, height}, name?, reason?, location?, contact?, time, offsetMinutes, certify?: 1\|2\|3, lockFields, pss, timestamp}` + the PDF, the .p12, a font for a visible signature, the picture's RGBA | `{done: true}` + the signed file; with `timestamp`, `{done: false}` + the prepared file, the signature and the RFC 3161 request for the host to send |
| `signatures.finish` (static) | the prepared file, the signature, the request, the authority's answer | `{done: true}` + the signed file; `E_TSA` for an answer that is not for this request |
| `signatures.prepare_document_timestamp` / `finish_document_timestamp` (static) | `{password?}` + the PDF / the prepared file, the request, the answer | the file with room for a document timestamp and its request / the stamped file |
| `signatures.fetches` (static) | `{password?, now}` + the PDF, trusted certificates | `{fetches: [{url, kind: ocsp\|crl\|certificate, about}]}` + each OCSP request body (empty for a GET) |
| `signatures.add_validation` (static) | `{password?, now, kinds}` + the PDF, one answer per `kinds` entry, trusted certificates | `{certs, ocsps, crls, rejected}` + the file with them in `/DSS` |
| `signatures.certificates` (static) | a certificate file (DER, PEM, PKCS#7) | `{certificates: [...]}` + each one's DER |
| `forms.inspect` (static) | `{password?}` + the PDF | `{xfa: none\|static\|dynamic, order: name[], fields: [{name, type, value, tooltip, readOnly, widgets: [{page, rect}], scripts: {keystroke, format, validate, calculate}, supported, format, range, calculate}], notRun: [{place, page?, field?, event, text}]}` — rects as shown, `[x0, top, x1, bottom]` |
| `forms.detect` (static) | `{password?, pages?: number[]}` (every page when empty) + the PDF | `{pages: [{index, width, height, fields: [{kind: text\|checkbox\|date\|hijri\|signature, name, tooltip, rect, rtl, source, pattern}]}]}`, names unique in the file |
| `forms.create` (static) | `{password?, fields: [{page, kind, name, tooltip, rect, rtl, pattern?}]}` + the PDF | `{created: name[]}` + the file with the fields, as an update |
| `forms.set_actions` (static) | `{password?, fields: [{name, format?: {kind: number\|percent\|date\|hijri, …} \| null, range?: {min?, max?} \| null, calculate?: {op, fields} \| {expression} \| null}]}` (a key left out is left as it is; `null` removes it) + the PDF + a font | `{ok: true, changed}` + the file, calculated values stored and drawn; or `{ok: false, error: {kind: noField\|cycle\|expression, …}}` and no file |
| `forms.check_expression` (static) | `{expression, fields: name[]}` | `{ok, uses?, typed?, error?: {kind: syntax\|unknownField\|empty\|tooLong, start, end, name?}}` |
| `forms.recalculate` (static) | `{fields: [{name, value, keystroke?, format?, validate?, calculate?}], order, changed?}` | `{normalized?, rejected?: {kind: number\|date\|hijri\|special\|range, …}, values: {name: value}, shown: {name: {text, red}}}` — only the subset `warraq_pdf::forms::script` parses is run |
| `forms.drop_xfa` (static) | `{password?}` + the PDF | `{dropped}` + the file without `/XFA` (and `/NeedsRendering`), as an update |
| `forms.fix_appearances` (static) | `{password?}` + the PDF + a font | `{fields, comments}` + the file with Arabic and formatted values drawn |
| `ocr.add_text_layer` (static) | `{password?, pages: [{index, words: [{text, bbox: [x0, top, x1, bottom]}], angle?, replace?: bool, image?: blob index}], modified?: "D:…"}` + the PDF + a font + the cleaned-up pages (PNG/JPEG: the whole page as shown, straightened by `angle`) | `{pages, words, skipped, images, imagesKept}` + the file with an invisible, shaped layer, as an update; `replace` takes Warraq's earlier layer on the page out first; `image` replaces a page that is one scanned picture (its words are then written level); the words are kept in the page's `/PieceInfo /Warraq` |
| `ocr.layer_words` (static) | `{password?, pages?: number[]}` + the PDF | `{pages: [{index, angle, words: [{text, bbox}]}]}` — the words kept with each layer Warraq wrote (what an OCR correction starts from) |

Signing never reaches the network: the core builds a request and takes the answer; the desktop host sends it (`net_exchange`), and signs on a smart card through `pkcs11_certificates` / `pkcs11_sign`, which call `tools::signatures::sign_with` with a card-backed `warraq_sign::keys::Signer`.

Errors add `E_ARGS` (arguments that do not parse) and `E_UNKNOWN_OP`.

Rules: every method is synchronous and pure; the host puts the module in a
Web Worker (extension: offscreen document). Errors are `Error` objects with an
English message and a stable `code` prefix (`E_PARSE`, `E_PASSWORD`, `E_RENDER`).
Never pass file paths: hosts read bytes and hand them over.
