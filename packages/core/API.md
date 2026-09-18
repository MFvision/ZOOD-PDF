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
| `redact.find` | `{query?: string, patterns?: ("email"\|"phone"\|"nationalId"\|"iban"\|"card"\|"date")[], custom?: string, pages?: number[]}` — words Arabic-aware as `search`; `custom` is a Rust `regex` (≤ 1000 chars, compiled within size limits) | `{matches: [{page, text, before, after, kind, rects: [{x, y, width, height}]}], total}` — rects are the glyph boxes in points from the top-left of the page as stored (before `/Rotate`); at most 5000 listed |
| `redact.inspect` (static) | `{password?}` + the file | `{findings: [{kind, count, details}], revisions, unreachable, signed, protected}`; kinds: metadata, scripts, attachments, comments, forms, hiddenLayers, bookmarks, thumbnails, privateData, links, hiddenText |
| `redact.scrub` (static) | `{password?, remove: kind[]}` + the file | `{size}` + the file written whole without them, with no earlier revision and nothing unreferenced; `{refused: "protected"}` for a protected file |
| `outline.list` (static) | `{password?}` + the file | `{bookmarks: [{title, depth, page \| null, open, children}]}` |
| `attachments.list` / `.get` (static) | `{password?, key?}` + the file | `{attachments: [{key, name, description, size, mime, page \| null}]}` / `{name, size}` + the attachment's bytes (never opened) |
| `attachments.add` / `.remove` (static) | `{password?, name, description?}` + the file + the new file / `{password?, key}` + the file | the file with it, or without it, as an update |
| `layers.list` (static) | `{password?}` + the file | `{layers: [{id, name, visible, locked, print, export}], order: [{id \| label, children}]}` |
| `layers.show` (static) | `{password?, visible: id[]}` + the file | a copy whose default configuration shows exactly those (locked layers keep theirs), as an update |
| `layers.restore` (static) | `{password?, rebase?: bool}` + the file with its own visibility + the same file as it stands | the second with the first's visibility — as an update of the first when `rebase` |

Errors add `E_ARGS` (arguments that do not parse) and `E_UNKNOWN_OP`.

Rules: every method is synchronous and pure; the host puts the module in a
Web Worker (extension: offscreen document). Errors are `Error` objects with an
English message and a stable `code` prefix (`E_PARSE`, `E_PASSWORD`, `E_RENDER`).
Never pass file paths: hosts read bytes and hand them over.
