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
| `signatures.verify` (static) | `{password?, now}` (Unix seconds) + the PDF, then certificates the person trusts (DER) | `{signatures: [...], emptyFields, certified, dss}`: per signature its status (`valid`, `untrusted`, `modified`, `invalid`), signer, integrity, chain and trust, timestamp, revocation, changes after it, `trustCandidate` |
| `signatures.identity` (static) | `{p12Password, now?}` + a .p12/.pfx | `{name, issuer, notAfter, validNow, key, rsa, canSign}`; `E_P12_PASSWORD` for a wrong password |
| `signatures.sign` (static) | `{password?, p12Password, field?, page, rect?, lines, image?: {width, height}, name?, reason?, location?, contact?, time, offsetMinutes, certify?: 1\|2\|3, lockFields, pss, timestamp}` + the PDF, the .p12, a font for a visible signature, the picture's RGBA | `{done: true}` + the signed file; with `timestamp`, `{done: false}` + the prepared file, the signature and the RFC 3161 request for the host to send |
| `signatures.finish` (static) | the prepared file, the signature, the request, the authority's answer | `{done: true}` + the signed file; `E_TSA` for an answer that is not for this request |
| `signatures.prepare_document_timestamp` / `finish_document_timestamp` (static) | `{password?}` + the PDF / the prepared file, the request, the answer | the file with room for a document timestamp and its request / the stamped file |
| `signatures.fetches` (static) | `{password?, now}` + the PDF, trusted certificates | `{fetches: [{url, kind: ocsp\|crl\|certificate, about}]}` + each OCSP request body (empty for a GET) |
| `signatures.add_validation` (static) | `{password?, now, kinds}` + the PDF, one answer per `kinds` entry, trusted certificates | `{certs, ocsps, crls, rejected}` + the file with them in `/DSS` |
| `signatures.certificates` (static) | a certificate file (DER, PEM, PKCS#7) | `{certificates: [...]}` + each one's DER |

Signing never reaches the network: the core builds a request and takes the answer; the desktop host sends it (`net_exchange`), and signs on a smart card through `pkcs11_certificates` / `pkcs11_sign`, which call `tools::signatures::sign_with` with a card-backed `warraq_sign::keys::Signer`.

Errors add `E_ARGS` (arguments that do not parse) and `E_UNKNOWN_OP`.

Rules: every method is synchronous and pure; the host puts the module in a
Web Worker (extension: offscreen document). Errors are `Error` objects with an
English message and a stable `code` prefix (`E_PARSE`, `E_PASSWORD`, `E_RENDER`).
Never pass file paths: hosts read bytes and hand them over.
