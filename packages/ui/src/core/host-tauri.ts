import type { RequestKind, RequestMap, ResultMap } from './protocol';
import { decodeFrame, encodeFrame } from './frame';
import type { CoreStatus, DocumentMetadata, PageSize, ParagraphData, TextLineData } from './types';
import { parseReplaceResult } from './handlers';

/**
 * Desktop host adapter: routes the core protocol to the natively linked
 * `warraq-core` through Tauri commands (`apps/desktop/src-tauri/src/core_bridge.rs`)
 * instead of the WASM Web Worker.
 *
 * The editing commands (`doc_paragraphs`, `doc_replace_paragraph`, `doc_save`)
 * follow the same naming as the read-only ones; `apps/desktop` registers them
 * on the Rust side, which is the lead's file, not this package's.
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
  /** Registers a JS function the Rust side can call back by number. */
  transformCallback: (callback: (payload: never) => void, once?: boolean) => number;
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

/**
 * Tells the desktop host's `WARRAQ_DEBUG` log what happened in the webview
 * (the host prints nothing unless that is set). A no-op in a browser; never
 * fails the caller.
 */
export function uiLog(message: string): void {
  if (!isTauriHost()) return;
  invoke('ui_log', { message }).catch(() => undefined);
}

/** Header values must be ASCII, and passwords may be Arabic. */
function toHex(text: string): string {
  return Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
}

/* ------------------------------------------------------------ native files */

/**
 * The desktop shell cannot reach files the way the web build does. WKWebView
 * ignores `<input type="file">` unless the host implements the open panel, and
 * a `<a download>` click goes nowhere because wry registers no download
 * handler — both fail silently, which is how the first desktop build shipped
 * unable to open anything at all. So the dialog and fs plugins do the work
 * instead, exactly the four permissions
 * `apps/desktop/src-tauri/capabilities/default.json` grants.
 *
 * The payloads below mirror `tauri-plugin-dialog`'s `OpenDialogOptions` /
 * `SaveDialogOptions` and `tauri-plugin-fs`'s `read_file` / `write_file`. The
 * open panel adds the picked path to the fs scope, which is what then lets
 * `read_file` see it; nothing is readable that the user did not choose.
 */

/** A choice in the native panel's file-type menu, as `tauri-plugin-dialog` reads it. */
export interface FileFilter {
  name: string;
  extensions: string[];
}

const PDF_FILTER: FileFilter[] = [{ name: 'PDF', extensions: ['pdf'] }];
/** Compare's report. */
export const HTML_FILTER: FileFilter[] = [{ name: 'HTML', extensions: ['html'] }];

/** Last segment of a native path, for the window title and the recent list. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** `read_file` answers with a raw body; tolerate a plain byte array as well. */
function toArrayBuffer(body: unknown): ArrayBuffer {
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(body)) return new Uint8Array(body).buffer;
  throw new Error('E_READ: unexpected file body');
}

export interface PickedFile {
  name: string;
  bytes: ArrayBuffer;
}

/** Native open panel, then the bytes. `null` when the user cancels. */
export async function pickPdfFile(): Promise<PickedFile | null> {
  const picked = await invoke('plugin:dialog|open', {
    options: { multiple: false, directory: false, filters: PDF_FILTER },
  });
  if (typeof picked !== 'string') return null;
  return { name: baseName(picked), bytes: toArrayBuffer(await readFile(picked)) };
}

/** Several PDFs at once, from the native open panel (Combine files). */
export async function pickPdfFiles(): Promise<PickedFile[]> {
  const picked = await invoke('plugin:dialog|open', {
    options: { multiple: true, directory: false, filters: PDF_FILTER },
  });
  const paths = Array.isArray(picked) ? picked.filter((p): p is string => typeof p === 'string') : [];
  const files: PickedFile[] = [];
  for (const path of paths) files.push({ name: baseName(path), bytes: toArrayBuffer(await readFile(path)) });
  return files;
}

/**
 * `read_file_bytes` is the host's own command rather than `plugin:fs|read_file`
 * because it says plainly why a path was refused (`E_SCOPE`). Both read the
 * same scope: the dialog and the drop handler put the chosen paths in it.
 */
function readFile(path: string): Promise<unknown> {
  return invoke('read_file_bytes', { path });
}

/**
 * A PDF named on the command line (`warraq-desktop report.pdf`), claimed once
 * at boot. `null` in a browser and whenever there is nothing waiting.
 */
export async function takeStartupFile(): Promise<PickedFile | null> {
  if (!internals()) return null;
  const path = await invoke('startup_file');
  if (typeof path !== 'string') return null;
  return { name: baseName(path), bytes: toArrayBuffer(await readFile(path)) };
}

/* --------------------------------------------------------- dropped on the app */

/** Emitted by `apps/desktop/src-tauri/src/lib.rs` after an OS drag-and-drop. */
export const FILE_DROP_EVENT = 'warraq://file-drop';

interface DropEvent {
  payload?: { paths?: string[] };
}

/**
 * Subscribes to files dropped on the window, and returns the unsubscribe.
 *
 * The webview never sees the OS drop: Tauri swallows it at the native level
 * and re-emits it as this event, so the HTML5 `drop` listener the web build
 * relies on is silent here — which is why dropping a PDF on the first desktop
 * build did nothing whatsoever. Outside Tauri this is a no-op and the web
 * listener does the work.
 */
export function onNativeFileDrop(onFiles: (files: PickedFile[]) => void): () => void {
  const host = internals();
  if (!host) return () => {};

  const handler = host.transformCallback(((event: DropEvent) => {
    const paths = event?.payload?.paths ?? [];
    void Promise.all(
      paths.map(async (path) => ({
        name: baseName(path),
        bytes: toArrayBuffer(await readFile(path)),
      })),
    )
      .then((files) => {
        if (files.length > 0) onFiles(files);
      })
      .catch(() => {});
  }) as (payload: never) => void);

  let stop: (() => void) | null = null;
  let cancelled = false;
  void invoke('plugin:event|listen', {
    event: FILE_DROP_EVENT,
    target: { kind: 'Any' },
    handler,
  })
    .then((id) => {
      // A failed unlisten is not actionable — the window is going away — but an
      // unhandled rejection would still surface in the app.
      const unlisten = () =>
        void invoke('plugin:event|unlisten', { event: FILE_DROP_EVENT, eventId: id }).catch(
          () => {},
        );
      if (cancelled) unlisten();
      else stop = unlisten;
    })
    .catch(() => {});

  return () => {
    cancelled = true;
    stop?.();
  };
}

/**
 * Native save panel, then the write. `false` when the user cancels, which is
 * not an error and must not be reported as a failed save.
 *
 * Header values are ASCII, so the path is percent-encoded — `write_file`
 * percent-decodes it, which is what keeps an Arabic filename intact.
 */
export async function saveNativeFile(
  bytes: Uint8Array,
  suggestedName: string,
  filters: readonly FileFilter[],
): Promise<boolean> {
  const path = await invoke('plugin:dialog|save', {
    options: { defaultPath: suggestedName, filters },
  });
  if (typeof path !== 'string') return false;
  await invoke('plugin:fs|write_file', bytes, { headers: { path: encodeURIComponent(path) } });
  return true;
}

/** `saveNativeFile` for a PDF: the panel offers PDF as the file type. */
export function savePdfFile(bytes: Uint8Array, suggestedName: string): Promise<boolean> {
  return saveNativeFile(bytes, suggestedName, PDF_FILTER);
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
    case 'call': {
      const headers: Record<string, string> = { 'x-warraq-op': message.op };
      if (message.doc !== null) headers['x-warraq-handle'] = String(message.doc);
      const reply = (await invoke('core_call', encodeFrame(message.args, message.blobs), { headers })) as ArrayBuffer;
      return decodeFrame(reply);
    }
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
    case 'paragraphs':
      return (await invoke('doc_paragraphs', {
        handle: message.doc,
        index: message.index,
      })) as ParagraphData[];
    case 'replace_paragraph': {
      const json = (await invoke('doc_replace_paragraph', {
        handle: message.doc,
        index: message.index,
        para: message.para,
        text: message.text,
        font: Array.from(new Uint8Array(message.font)),
      })) as string;
      return parseReplaceResult(json);
    }
    case 'add_text':
      await invoke('doc_add_text', {
        handle: message.doc,
        index: message.index,
        x: message.x,
        y: message.y,
        size: message.size,
        text: message.text,
        font: Array.from(new Uint8Array(message.font)),
      });
      return null;
    case 'save': {
      // The bytes come back as a raw IPC body, like `doc_render_page`.
      const body = (await invoke('doc_save', { handle: message.doc })) as ArrayBuffer;
      const bytes = new Uint8Array(new ArrayBuffer(body.byteLength));
      bytes.set(new Uint8Array(body));
      return bytes;
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
