# `@warraq/core` — JS/WASM interface contract (Phase 1)

Produced by `pnpm build:core` (wasm-pack, target `web`) into
`packages/ui/src/core-wasm/` as `warraq_core.js` + `warraq_core_bg.wasm` + types.
The same Rust API is exposed natively to Tauri commands.

```ts
export default function init(input?: InitInput): Promise<InitOutput>; // must be awaited once
export function version(): string;                                       // e.g. "0.1.0"

export class RenderedPage { readonly width: number; readonly height: number; readonly rgba: Uint8Array; free(): void; }
export class TextLine   { readonly text: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly direction: "rtl" | "ltr"; free(): void; }

export class Document {
  static open(bytes: Uint8Array, password?: string): Document; // throws Error(message) on failure
  page_count(): number;
  page_size(index: number): Float32Array;                       // [width_pt, height_pt] after /Rotate
  render_page(index: number, scale: number): RenderedPage;     // RGBA8, premultiplied alpha over white
  extract_text(index: number): string;                          // logical-order text, lines joined by "\n"
  text_lines(index: number): TextLine[];                         // for selection/highlight overlays
  search(query: string): Uint32Array;                            // page indices with Arabic-aware normalization
  metadata(): string;                                            // JSON: {title, author, producer, creator, pages, encrypted}
  free(): void;
}
```

Rules: every method is synchronous and pure; the host puts the module in a
Web Worker (extension: offscreen document). Errors are `Error` objects with an
English message and a stable `code` prefix (`E_PARSE`, `E_PASSWORD`, `E_RENDER`).
Never pass file paths: hosts read bytes and hand them over.
