import type { RequestKind, RequestMap, ResultMap } from './protocol';
import type { CoreStatus, DocumentMetadata, PageSize, TextLineData } from './types';

/**
 * Desktop host adapter: routes the core protocol to the natively linked
 * `warraq-core` through Tauri commands (`apps/desktop/src-tauri/src/core_bridge.rs`)
 * instead of the WASM Web Worker.
 *
 * Same API, different rasterizer: PDFium natively, hayro in the browser
 * (ADR-0003, narrowed by ADR-0006). Browsers never reach this file — the check
 * is `window.__TAURI_INTERNALS__`, which Tauri injects into its webview even
 * with `withGlobalTauri: false`. Talking to it directly keeps `@warraq/ui`
 * free of a `@tauri-apps/api` dependency the web build would have to carry.
 */

type InvokeOptions = { headers?: Record<string, string> };
type Invoke = (cmd: string, args?: unknown, options?: InvokeOptions) => Promise<unknown>;

interface TauriInternals {
  invoke: Invoke;
}

function internals(): TauriInternals | null {
  const found = (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  return found && typeof found.invoke === 'function' ? found : null;
}

/** True inside the Tauri webview, false in every browser. */
export function isTauriHost(): boolean {
  return internals() !== null;
}

function invoke(cmd: string, args?: unknown, options?: InvokeOptions): Promise<unknown> {
  const host = internals();
  if (!host) return Promise.reject(new Error('E_HOST: not running inside Tauri'));
  return host.invoke(cmd, args, options);
}

/** Header values must be ASCII, and passwords may be Arabic. */
function toHex(text: string): string {
  return Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
}

/** `width` u32 LE + `height` u32 LE + RGBA8, as `encode_bitmap` writes it. */
function decodeRenderedPage(buffer: ArrayBuffer): ResultMap['render_page'] {
  if (buffer.byteLength < 8) throw new Error('E_RENDER: truncated page bitmap');
  const header = new DataView(buffer, 0, 8);
  const width = header.getUint32(0, true);
  const height = header.getUint32(4, true);
  const expected = width * height * 4;
  if (buffer.byteLength - 8 < expected) throw new Error('E_RENDER: short page bitmap');
  // Copy so the result owns a transferable buffer, exactly like the worker path.
  const rgba = new Uint8ClampedArray(new ArrayBuffer(expected));
  rgba.set(new Uint8Array(buffer, 8, expected));
  return { width, height, rgba };
}

function toMetadata(json: string, pageCount: number): DocumentMetadata {
  try {
    const parsed = JSON.parse(json) as Partial<DocumentMetadata>;
    return { ...parsed, pages: parsed.pages ?? pageCount, encrypted: Boolean(parsed.encrypted) };
  } catch {
    return { pages: pageCount, encrypted: false };
  }
}

async function openDocument(bytes: ArrayBuffer, password?: string): Promise<ResultMap['open']> {
  const options =
    password === undefined ? undefined : { headers: { 'x-warraq-password-hex': toHex(password) } };
  const handle = (await invoke('doc_open', bytes, options)) as number;
  const pageCount = (await invoke('doc_page_count', { handle })) as number;
  const pageSizes: PageSize[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    const size = (await invoke('doc_page_size', { handle, index })) as [number, number];
    pageSizes.push([size[0] ?? 0, size[1] ?? 0]);
  }
  const metadata = toMetadata((await invoke('doc_metadata', { handle })) as string, pageCount);
  return { doc: handle, pageCount, pageSizes, metadata };
}

/**
 * The status the UI shows for the desktop core: `kind: 'native'` plus the
 * engine string from `core_engine()` ("pdfium+hayro", or "hayro" when the
 * dynamic library could not be loaded and the core degraded).
 */
export async function nativeCoreStatus(): Promise<CoreStatus> {
  const [version, engine] = (await Promise.all([
    invoke('core_version'),
    invoke('core_engine'),
  ])) as [string, string];
  return { kind: 'native', version, engine };
}

/** A protocol request before the client stamps an id on it. */
type HostRequest = { [K in RequestKind]: { kind: K } & RequestMap[K] }[RequestKind];

async function dispatch(message: HostRequest): Promise<unknown> {
  switch (message.kind) {
    case 'init':
      return nativeCoreStatus();
    case 'open':
      return openDocument(message.bytes, message.password);
    case 'page_count':
      return invoke('doc_page_count', { handle: message.doc });
    case 'page_size': {
      const size = (await invoke('doc_page_size', {
        handle: message.doc,
        index: message.index,
      })) as [number, number];
      return [size[0] ?? 0, size[1] ?? 0];
    }
    case 'render_page': {
      const body = (await invoke('doc_render_page', {
        handle: message.doc,
        index: message.index,
        scale: message.scale,
      })) as ArrayBuffer;
      return decodeRenderedPage(body);
    }
    case 'extract_text':
      return invoke('doc_extract_text', { handle: message.doc, index: message.index });
    case 'text_lines':
      return (await invoke('doc_text_lines', {
        handle: message.doc,
        index: message.index,
      })) as TextLineData[];
    case 'search':
      return invoke('doc_search', { handle: message.doc, query: message.query });
    case 'metadata': {
      const pageCount = (await invoke('doc_page_count', { handle: message.doc })) as number;
      const json = (await invoke('doc_metadata', { handle: message.doc })) as string;
      return toMetadata(json, pageCount);
    }
    case 'free':
      await invoke('doc_close', { handle: message.doc });
      return null;
    default: {
      const unknown = message as { kind: string };
      throw new Error(`E_UNKNOWN: unknown request ${unknown.kind}`);
    }
  }
}

/** Handles one protocol request against the native core. */
export async function handleTauriRequest<K extends RequestKind>(
  kind: K,
  payload: RequestMap[K],
): Promise<ResultMap[K]> {
  // The union is exhaustive over `kind`, but TS cannot see that through `K`.
  const message = { kind, ...payload } as unknown as HostRequest;
  return (await dispatch(message)) as ResultMap[K];
}
