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

Signing never reaches the network: the core builds a request and takes the answer; the desktop host sends it (`net_exchange`), and signs on a smart card through `pkcs11_certificates` / `pkcs11_sign`, which call `tools::signatures::sign_with` with a card-backed `warraq_sign::keys::Signer`.

Errors add `E_ARGS` (arguments that do not parse) and `E_UNKNOWN_OP`.

Rules: every method is synchronous and pure; the host puts the module in a
Web Worker (extension: offscreen document). Errors are `Error` objects with an
English message and a stable `code` prefix (`E_PARSE`, `E_PASSWORD`, `E_RENDER`).
Never pass file paths: hosts read bytes and hand them over.
