import type { RequestKind, RequestMap, ResultMap } from './protocol';
import { decodeFrame, encodeFrame } from './frame';
import type { CoreStatus, DocumentMetadata, PageSize, ParagraphData, TextLineData } from './types';
import { parseReplaceResult } from './handlers';
import { note } from '../support/log';

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
  /** Forgets a callback registered with `transformCallback` (Tauri 2's core script). */
  unregisterCallback?: (id: number) => void;
}

function internals(): TauriInternals | null {
  const found = (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  return found && typeof found.invoke === 'function' ? found : null;
}

/** This window's label in the desktop app ("main", "doc-2"…); null in a browser. */
export function currentWindowLabel(): string | null {
  const found = (globalThis as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__;
  return found?.metadata?.currentWindow?.label ?? null;
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
 * A command of the desktop host, for the parts of the interface that have
 * commands of their own there (the on-device model, the person's details).
 * Rejects outside Tauri; callers ask `isTauriHost()` first.
 */
export function invokeHost(cmd: string, args?: unknown): Promise<unknown> {
  return invoke(cmd, args);
}

/** Subscribes to a host event by name; returns the unsubscribe. A no-op in a browser. */
export function onHostEvent<T>(event: string, handle: (payload: T) => void): () => void {
  const host = internals();
  if (!host) return () => {};
  return listen(host, event, ((received: { payload?: T }) => {
    if (received?.payload !== undefined) handle(received.payload);
  }) as (payload: never) => void);
}

/**
 * Tells the desktop host's `WARRAQ_DEBUG` log what happened in the webview
 * (the host prints nothing unless that is set). A no-op in a browser; never
 * fails the caller.
 */
export function uiLog(message: string): void {
  note('info', message);
  if (!isTauriHost()) return;
  invoke('ui_log', { message }).catch(() => undefined);
}

/**
 * Opens a web or e-mail address in the system's browser or mail app, after
 * the person confirmed it (`links/openLink.ts`). The host checks the address
 * again: only `http`, `https` and `mailto` are opened.
 */
export async function openExternalUrl(url: string): Promise<void> {
  await invoke('open_url', { url });
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

/** One kind of file in a native open or save panel: its name there, and its extensions. */
export interface FileFilter {
  name: string;
  extensions: string[];
}

const PDF: FileFilter = { name: 'PDF', extensions: ['pdf'] };
const PDF_FILTER = [PDF];

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
  /** Where it was read from, so the recent list can open it again. */
  path?: string;
}

/**
 * The path each file read from this device came from, by the `File` the
 * open path is handed: dropped, picked and double-clicked files all become
 * plain `File`s on the way, and the recent list needs to know where they were.
 */
const nativePaths = new WeakMap<File, string>();

/** Notes that `file` was read from `path` (a no-op without one). */
export function keepNativePath(file: File, path: string | undefined): File {
  if (path) nativePaths.set(file, path);
  return file;
}

/** Where `file` was read from on this device, if it was. */
export function nativePathOf(file: File): string | undefined {
  return nativePaths.get(file);
}

/** Native open panel, then the bytes. `null` when the user cancels. */
export async function pickPdfFile(): Promise<PickedFile | null> {
  const picked = await invoke('plugin:dialog|open', {
    options: { multiple: false, directory: false, filters: PDF_FILTER },
  });
  if (typeof picked !== 'string') return null;
  return { name: baseName(picked), bytes: toArrayBuffer(await readFile(picked)), path: picked };
}

/** Any files the native open panel allows through `filters` (none: every file). */
export async function pickFiles(filters: FileFilter[], multiple: boolean): Promise<PickedFile[]> {
  const picked = await invoke('plugin:dialog|open', {
    options: { multiple, directory: false, filters },
  });
  const paths = Array.isArray(picked)
    ? picked.filter((p): p is string => typeof p === 'string')
    : typeof picked === 'string'
      ? [picked]
      : [];
  const files: PickedFile[] = [];
  for (const path of paths) files.push({ name: baseName(path), bytes: toArrayBuffer(await readFile(path)) });
  return files;
}

/**
 * A security token's PKCS#11 module, from the native open panel: its path,
 * which the panel lets the app use (the host loads only a module the person
 * chose this way, or one in the system's own folders). `null` when cancelled.
 */
export async function pickModulePath(): Promise<string | null> {
  const picked = await invoke('plugin:dialog|open', {
    options: { multiple: false, directory: false, filters: [{ name: 'PKCS#11', extensions: ['so', 'dll', 'dylib'] }] },
  });
  return typeof picked === 'string' ? picked : null;
}

/** Several PDFs at once, from the native open panel (Combine files). */
export function pickPdfFiles(): Promise<PickedFile[]> {
  return pickFiles(PDF_FILTER, true);
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
 * A PDF named on the command line (`warraq-desktop report.pdf`, which is how
 * Explorer opens a double-clicked PDF), claimed once — at boot, and again
 * each time `onOpenFileRequest` fires. `null` in a browser and whenever
 * there is nothing waiting.
 */
export async function takeStartupFile(): Promise<PickedFile | null> {
  if (!internals()) return null;
  const path = await invoke('startup_file');
  if (typeof path !== 'string') return null;
  return { name: baseName(path), bytes: toArrayBuffer(await readFile(path)), path };
}

/** The editor tool the waiting file opens at (`fillSign` for a quick "Sign"), claimed once. */
export async function takeStartupTool(): Promise<string | null> {
  if (!internals()) return null;
  const tool = await invoke('startup_tool');
  return typeof tool === 'string' ? tool : null;
}

/** Emitted by `apps/desktop/src-tauri/src/lib.rs` when a second launch handed a PDF to this window. */
export const OPEN_FILE_EVENT = 'warraq://open-file';

/**
 * Subscribes to PDFs opened from outside while the app runs (another one
 * double-clicked in Explorer): each time, a file waits for `takeStartupFile`.
 * A no-op in a browser.
 */
export function onOpenFileRequest(handle: () => void): () => void {
  const host = internals();
  if (!host) return () => {};
  return listen(host, OPEN_FILE_EVENT, (() => handle()) as (payload: never) => void);
}

/* ------------------------------------------------------------ recent files */

/**
 * Keeps where a recent file was opened from (`src-tauri/src/recent.rs`), so
 * choosing it on the home screen opens it again directly. The host refuses a
 * path the person did not choose. Never fails the caller.
 */
export function rememberRecentPath(name: string, path: string): void {
  if (!internals()) return;
  invoke('recent_remember', { name, path }).catch(() => undefined);
}

/** Forgets where a recent file was, or every one when `name` is absent. Never fails the caller. */
export function forgetRecentPath(name?: string): void {
  if (!internals()) return;
  invoke('recent_forget', { name: name ?? null }).catch(() => undefined);
}

/**
 * The recent file `name`, read again from where it was last opened. `null`
 * when that is not known or the file is no longer there (moved, renamed,
 * deleted): the person is then asked for it.
 */
export async function openRecentFile(name: string): Promise<PickedFile | null> {
  if (!internals()) return null;
  const path = await invoke('recent_path', { name });
  if (typeof path !== 'string') return null;
  return { name: baseName(path), bytes: toArrayBuffer(await readFile(path)), path };
}

/**
 * The folder a recent file was last opened from, for the Workbench home's
 * table; `null` in a browser, or when the desktop does not know it.
 */
export async function recentFolder(name: string): Promise<string | null> {
  if (!internals()) return null;
  const path = await invoke('recent_path', { name }).catch(() => null);
  if (typeof path !== 'string') return null;
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut > 0 ? path.slice(0, cut) : null;
}

/* -------------------------------------------------------------- quick tools */

/** What a quick tools window works on (`src-tauri/src/quick.rs`). */
export interface QuickJob {
  /** The tool the right-click menu named, or null for the chooser. */
  tool: string | null;
  files: { name: string; path: string; size: number }[];
}

/** True in a quick tools window, which the file manager opened: not the editor. */
export function isQuickWindow(): boolean {
  if (!internals()) return false;
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').has('quick');
  } catch {
    return false;
  }
}

/** This quick window's files and tool; null outside one. */
export async function quickJob(): Promise<QuickJob | null> {
  if (!internals()) return null;
  return ((await invoke('quick_job')) as QuickJob | null) ?? null;
}

/** Closes this quick window (the app ends with it if nothing else is open). */
export function quickClose(): Promise<void> {
  return invoke('quick_close').then(() => undefined);
}

/** Opens a quick tool's result in the editor, or a file at the editor's own tool for one (`sign`). */
export function quickOpenInEditor(path: string, tool?: string): Promise<void> {
  return invoke('quick_open_in_editor', { path, tool: tool ?? null }).then(() => undefined);
}

/**
 * The file manager's right-click menu for the quick tools
 * (`src-tauri/src/shell_menu.rs`): `registry` on Windows, where the app
 * puts it in and takes it out; `service` on macOS, where the system's own
 * settings do; `none` elsewhere.
 */
export interface ShellMenuState {
  kind: 'registry' | 'service' | 'none';
  on: boolean;
}

export async function shellMenuState(): Promise<ShellMenuState> {
  if (!internals()) return { kind: 'none', on: false };
  return (await invoke('shell_menu_state')) as ShellMenuState;
}

/** Puts the menu in, in `lang`, with `tools` in that order (all when empty), or takes it out. */
export async function setShellMenu(on: boolean, lang: string, tools: readonly string[] = []): Promise<ShellMenuState> {
  if (!internals()) return { kind: 'none', on: false };
  return (await invoke('shell_menu_set', { on, lang, tools })) as ShellMenuState;
}

/* --------------------------------------------------------------------- ring */

/** True in the ring's window (`src-tauri/src/ring.rs`). */
export function isRingWindow(): boolean {
  if (!internals()) return false;
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').has('ring');
  } catch {
    return false;
  }
}

export const RING_SHOW_EVENT = 'ring://show';
export const RING_FILES_EVENT = 'ring://files';
export const RING_OVER_EVENT = 'ring://over';
export const RING_DROP_EVENT = 'ring://drop';
/** The ring opened by its keyboard shortcut, already holding the selected files. */
export const RING_HOLD_EVENT = 'ring://hold';

/** The tool the files were let go on, or `none`; `only`, of those files, these paths. */
export function ringPick(tool: string, only?: readonly string[]): Promise<void> {
  return invoke('ring_pick', { tool, only: only ?? null }).then(() => undefined);
}

/** A phone is connected to the remote now: the ring offers "To phone". */
export function ringPhone(): Promise<boolean> {
  return invoke('ring_phone').then((on) => on === true, () => false);
}

/** The files let go on the ring, for a tool the ring runs itself; they stay held for `ringPick`. */
export async function ringTake(): Promise<QuickJob['files']> {
  return ((await invoke('ring_take')) as QuickJob['files'] | null) ?? [];
}

/** The ring's tool finished: the ring goes. */
export function ringDone(done: number, failed: number): Promise<void> {
  return invoke('ring_done', { done, failed }).then(() => undefined);
}

/** The ring's switches: the ring itself, and keeping the app ready at sign-in. */
export interface RingSettings {
  ring: boolean;
  background: boolean;
  /** 0.85, 1 or 1.2 (`ring.rs`, SCALES). */
  scale: number;
  /** The keyboard shortcut, as Tauri writes one ("CommandOrControl+Alt+Z"). */
  shortcut: string;
  /** The key held while dragging that opens the ring; `any` is Ctrl or Shift (Option or Command on a Mac). */
  dragKey: RingDragKey;
}

export type RingDragKey = 'any' | 'ctrl' | 'shift' | 'alt' | 'meta';

export async function ringSettings(): Promise<RingSettings | null> {
  if (!internals()) return null;
  return (await invoke('ring_settings')) as RingSettings;
}

export async function configureRing(settings: RingSettings): Promise<RingSettings> {
  return (await invoke('ring_configure', { ring: settings.ring, background: settings.background, scale: settings.scale, shortcut: settings.shortcut, dragKey: settings.dragKey })) as RingSettings;
}

/* ---------------------------------------------------------------- system */

/** The signed-in person's name for the greeting; empty outside the desktop app. */
export async function systemUserName(): Promise<string> {
  if (!internals()) return '';
  return ((await invoke('system_user_name')) as string) ?? '';
}

/** Opens Windows' Default apps page; false where there is none to open. */
export async function openDefaultApps(): Promise<boolean> {
  if (!internals()) return false;
  return (await invoke('open_default_apps')) as boolean;
}

/**
 * Opens a file this run may read in an editor window of its own (Settings ›
 * Viewing › Open documents in: New windows; `src-tauri/src/doc_window.rs`).
 */
export async function openDocumentWindow(path: string): Promise<boolean> {
  if (!internals()) return false;
  try {
    await invoke('open_document_window', { path });
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------- dropped on the app */

/** Emitted by `apps/desktop/src-tauri/src/lib.rs` after an OS drag-and-drop. */
export const FILE_DROP_EVENT = 'warraq://file-drop';

/** Emitted while files are dragged over the window; the webview sees no HTML drag events. */
export const FILE_DRAG_EVENT = 'warraq://file-drag';

/** Where on the page, in CSS pixels, files are over or were let go. */
export interface DropPoint {
  x: number;
  y: number;
}

interface DropEvent {
  payload?: { paths?: string[]; x?: number; y?: number };
}

interface DragEvent {
  payload?: { kind?: 'over' | 'leave'; x?: number; y?: number };
}

/** Listens to a host event until the returned function is called. */
function listen(host: TauriInternals, event: string, handle: (payload: never) => void): () => void {
  const handler = host.transformCallback(handle);
  let stop: (() => void) | null = null;
  let cancelled = false;
  void invoke('plugin:event|listen', { event, target: { kind: 'Any' }, handler })
    .then((id) => {
      // A failed unlisten is not actionable — the window is going away — but an
      // unhandled rejection would still surface in the app.
      const unlisten = () => void invoke('plugin:event|unlisten', { event, eventId: id }).catch(() => {});
      if (cancelled) unlisten();
      else stop = unlisten;
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    stop?.();
    // The callback would otherwise stay registered — and keep whatever its
    // closure holds alive — for as long as the window is open.
    host.unregisterCallback?.(handler);
  };
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
export function onNativeFileDrop(onFiles: (files: PickedFile[], at: DropPoint | null) => void): () => void {
  const host = internals();
  if (!host) return () => {};
  return listen(host, FILE_DROP_EVENT, ((event: DropEvent) => {
    const paths = event?.payload?.paths ?? [];
    const { x, y } = event?.payload ?? {};
    const at = typeof x === 'number' && typeof y === 'number' ? { x, y } : null;
    void Promise.all(
      paths.map(async (path) => ({
        name: baseName(path),
        bytes: toArrayBuffer(await readFile(path)),
        path,
      })),
    )
      .then((files) => {
        if (files.length > 0) onFiles(files, at);
      })
      .catch(() => {});
  }) as (payload: never) => void);
}

/**
 * Subscribes to files being dragged over the window: `at` while they are
 * over it, `null` once they have left or been dropped.
 */
export function onNativeFileDrag(onDrag: (at: DropPoint | null) => void): () => void {
  const host = internals();
  if (!host) return () => {};
  return listen(host, FILE_DRAG_EVENT, ((event: DragEvent) => {
    const { kind, x, y } = event?.payload ?? {};
    onDrag(kind === 'over' && typeof x === 'number' && typeof y === 'number' ? { x, y } : null);
  }) as (payload: never) => void);
}

/* ------------------------------------------------------------- menu bar */

/** Emitted by `apps/desktop/src-tauri/src/menu.rs` when an item of the macOS menu bar is chosen. */
export const MENU_EVENT = 'warraq://menu';

/** One item of the macOS menu bar, as `menu.rs` builds it (`MenuSpec` there). */
export interface NativeMenuItem {
  id: string;
  label: string;
  accelerator?: string;
  enabled: boolean;
  /** Present on check and radio items only. */
  checked?: boolean;
  separatorBefore: boolean;
}

export interface NativeMenu {
  id: string;
  label: string;
  items: NativeMenuItem[];
}

/** The system items the host adds itself, in the interface's language. */
export interface NativeMenuLabels {
  appName: string;
  services: string;
  hide: string;
  hideOthers: string;
  showAll: string;
  quit: string;
  window: string;
  minimize: string;
  zoom: string;
  bringAllToFront: string;
  fullscreen: string;
  closeWindow: string;
  cut: string;
  copy: string;
  paste: string;
  selectAll: string;
}

export interface NativeMenuSpec {
  labels: NativeMenuLabels;
  menus: NativeMenu[];
}

/**
 * Hands the menu bar to the macOS host: built the first time and whenever a
 * label or an item changes, otherwise only enabled and checked are updated.
 * A no-op in a browser.
 */
export function setNativeMenu(spec: NativeMenuSpec): Promise<void> {
  if (!internals()) return Promise.resolve();
  return invoke('set_menu', { spec }).then(() => undefined);
}

/** Subscribes to items chosen in the macOS menu bar (their ids). Returns the unsubscribe. */
export function onNativeMenu(onItem: (id: string) => void): () => void {
  const host = internals();
  if (!host) return () => {};
  return listen(host, MENU_EVENT, ((event: { payload?: unknown }) => {
    if (typeof event?.payload === 'string') onItem(event.payload);
  }) as (payload: never) => void);
}

/**
 * Native save panel for one kind of file, then the write. `false` when the
 * user cancels, which is not an error and must not be reported as a failed
 * save.
 *
 * Header values are ASCII, so the path is percent-encoded — `write_file`
 * percent-decodes it, which is what keeps an Arabic filename intact.
 */
export async function saveFileAs(bytes: Uint8Array, suggestedName: string, filter: FileFilter): Promise<boolean> {
  const path = await invoke('plugin:dialog|save', {
    options: { defaultPath: suggestedName, filters: [filter] },
  });
  if (typeof path !== 'string') return false;
  await invoke('plugin:fs|write_file', bytes, { headers: { path: encodeURIComponent(path) } });
  return true;
}

/** Whether the desktop host can print: the interface offers Print only then. */
export async function printAvailable(): Promise<boolean> {
  if (!internals()) return false;
  return (await invoke('print_available')) === true;
}

/**
 * How the desktop host prints: `pdfkit` — it prints the file itself
 * (`printPdf`, macOS) — or `pages`: the interface lays the pages out for
 * print and the host opens the webview's print dialog on them
 * (`printWebview`; Windows, Linux, and macOS with `WARRAQ_PRINT=pages`).
 */
export async function printMode(): Promise<'pdfkit' | 'pages'> {
  return (await invoke('print_mode')) === 'pages' ? 'pages' : 'pdfkit';
}

/** Opens the webview's own print dialog, on what the page's print style sheet lets through. */
export async function printWebview(): Promise<void> {
  await invoke('print_webview');
}

/**
 * Opens the system print sheet for `bytes` — the file as it stands — with its
 * password, if it has one, in the header `doc_open` reads. Rejects with the
 * host's reason: `E_PASSWORD`, `E_PRINT_FORBIDDEN` (the file does not allow
 * printing), `E_PRINT`.
 */
export async function printPdf(bytes: ArrayBuffer, password?: string): Promise<void> {
  const options =
    password === undefined ? undefined : { headers: { 'x-warraq-password-hex': toHex(password) } };
  await invoke('print_pdf', bytes, options);
}

/** `saveFileAs` for a PDF. */
export function savePdfFile(bytes: Uint8Array, suggestedName: string): Promise<boolean> {
  return saveFileAs(bytes, suggestedName, PDF);
}

/* ------------------------------------------------------------------ batch */

/**
 * A file for the batch, known by its path and read only when its turn comes
 * (`src-tauri/src/batch.rs`): a folder of a thousand PDFs is not held in
 * memory at once.
 */
export interface BatchSource {
  name: string;
  path: string;
  /** Its place under the chosen folder, when it came from one. */
  relative?: string;
  size?: number;
}

/** PDFs from the native open panel, by path. */
export async function pickBatchFiles(): Promise<BatchSource[]> {
  const picked = await invoke('plugin:dialog|open', { options: { multiple: true, directory: false, filters: PDF_FILTER } });
  const paths = Array.isArray(picked) ? picked.filter((p): p is string => typeof p === 'string') : typeof picked === 'string' ? [picked] : [];
  return paths.map((path) => ({ name: baseName(path), path }));
}

/**
 * A folder from the native panel. `recursive` puts everything under it in
 * the file scope (so its subfolders' PDFs can be read); without it, only
 * the folder itself — enough to write results into.
 */
export async function pickFolder(recursive: boolean): Promise<string | null> {
  const picked = await invoke('plugin:dialog|open', { options: { multiple: false, directory: true, recursive } });
  return typeof picked === 'string' ? picked : null;
}

/** The PDFs in a folder chosen with `pickFolder(true)`, subfolders too when `recursive`. */
export async function listBatchFolder(path: string, recursive: boolean): Promise<BatchSource[]> {
  const found = (await invoke('batch_list_folder', { path, recursive })) as { path: string; name: string; relative: string; size: number }[];
  return found.map(({ path: file, name, relative, size }) => ({ path: file, name, relative, size }));
}

/** One batch file's bytes, when its turn comes. */
export async function readBatchFile(path: string): Promise<ArrayBuffer> {
  return toArrayBuffer(await readFile(path));
}

/** Where a result goes: a folder chosen for the results, or beside its original. */
export type BatchTarget = { dir: string } | { beside: string };

/**
 * Writes one result, never over a file already there ("name (2).pdf"
 * instead). Returns the path written.
 */
export async function writeBatchResult(bytes: Uint8Array, name: string, target: BatchTarget): Promise<string> {
  const headers: Record<string, string> = { 'x-warraq-name': encodeURIComponent(name) };
  if ('dir' in target) headers['x-warraq-dir'] = encodeURIComponent(target.dir);
  else headers['x-warraq-beside'] = encodeURIComponent(target.beside);
  return (await invoke('batch_write', bytes, { headers })) as string;
}

/* -------------------------------------------------------------------- share */

/**
 * Share › Email as an attachment (`src-tauri/src/share.rs`): the file as it
 * stands is written to the app's own share folder and a new message opens
 * in the person's mail program with it attached. Nothing is sent by the app.
 */
export async function emailAttachment(bytes: Uint8Array, name: string): Promise<void> {
  const path = (await invoke('share_prepare', bytes, { headers: { 'x-warraq-name': encodeURIComponent(name) } })) as string;
  await invoke('share_email', { path });
}

/**
 * The check the desktop host asks the interface to run by itself, from its
 * environment (`WARRAQ_SELFCHECK`, with `WARRAQ_DEBUG`): null in a browser
 * and in every ordinary run.
 */
export async function debugSelfCheck(): Promise<string | null> {
  if (!internals()) return null;
  const check = await invoke('debug_selfcheck').catch(() => null);
  return typeof check === 'string' ? check : null;
}

/* ------------------------------------------------------------- signatures */

/**
 * One request to a timestamp authority or a certificate status responder,
 * made by the desktop host (`src-tauri/src/signing.rs`): a POST of `body`
 * when there is one, else a GET. Only ever on the person's click; the answer
 * comes back as bytes, or the promise rejects with `E_NET: …`.
 */
export async function netExchange(url: string, body?: ArrayBuffer, contentType?: string): Promise<ArrayBuffer> {
  const headers: Record<string, string> = { 'x-warraq-url': encodeURIComponent(url) };
  if (contentType) headers['x-warraq-content-type'] = contentType;
  return (await invoke('net_exchange', body ?? new ArrayBuffer(0), { headers })) as ArrayBuffer;
}

/** A certificate on a smart card or token, as `pkcs11_certificates` lists it. */
export interface TokenCertificate {
  slot: number;
  /** CKA_ID, hex: how the key beside it is found. */
  id: string;
  label: string;
  name: string;
  issuer: string;
  notAfter: string;
}

/** The certificates on the tokens a PKCS#11 module (a path the person chose) can see, after the PIN. */
export async function pkcs11Certificates(module: string, pin: string): Promise<TokenCertificate[]> {
  return JSON.parse(
    (await invoke('pkcs11_certificates', undefined, {
      headers: { 'x-warraq-module': encodeURIComponent(module), 'x-warraq-pin-hex': toHex(pin) },
    })) as string,
  ) as TokenCertificate[];
}

/**
 * Signs on the token: the same arguments and blobs as `signatures.sign`
 * without the certificate file (the PDF, the face, the picture), and the
 * same answer, framed as `core_call` frames it.
 */
export async function pkcs11Sign(
  module: string,
  pin: string,
  certificate: TokenCertificate,
  args: object,
  blobs: ArrayBuffer[],
): Promise<{ json: string; blobs: ArrayBuffer[] }> {
  const reply = (await invoke('pkcs11_sign', encodeFrame(JSON.stringify(args), blobs), {
    headers: {
      'x-warraq-module': encodeURIComponent(module),
      'x-warraq-pin-hex': toHex(pin),
      'x-warraq-slot': String(certificate.slot),
      'x-warraq-key-id': certificate.id,
    },
  })) as ArrayBuffer;
  return decodeFrame(reply);
}

/* ------------------------------------------------------------ cloud drives */

/**
 * The desktop's side of OneDrive and Google Drive (`src-tauri/src/cloud.rs`):
 * a one-shot listener on 127.0.0.1 for the browser to come back to after a
 * sign-in, the refresh token kept in the system keychain (never handed to
 * the page), and each request to a drive sent from Rust to that drive's own
 * hosts. Only ever on the person's click.
 */

/** Opens the listener of a new sign-in (cancelling one under way); its port goes in the redirect URI. */
export async function cloudAuthListen(): Promise<number> {
  return (await invoke('cloud_auth_listen')) as number;
}

/**
 * Waits for the browser to come back with `state`, and answers the redirect's
 * parameters. Rejects with `E_CLOUD_TIMEOUT`, `E_CLOUD_CANCELLED` or
 * `E_CLOUD_DENIED: <error>: <why>`.
 */
export async function cloudAuthWait(state: string): Promise<Record<string, string>> {
  return (await invoke('cloud_auth_wait', { expectedState: state })) as Record<string, string>;
}

export async function cloudAuthCancel(): Promise<void> {
  await invoke('cloud_auth_cancel');
}

/**
 * A code redeemed or a refresh at `url`, `provider`'s token endpoint. `form`
 * carries neither a refresh token nor a secret; the host adds the kept token
 * to a refresh and keeps the one that comes back. Answers the endpoint's JSON
 * without it.
 */
export async function cloudToken(provider: string, url: string, form: Record<string, string>): Promise<unknown> {
  return JSON.parse((await invoke('cloud_token', { provider, url, form })) as string) as unknown;
}

/** Whether the keychain holds a sign-in for `provider`. */
export async function cloudHasSession(provider: string): Promise<boolean> {
  return (await invoke('cloud_has_session', { provider })) === true;
}

/** Signs out: revokes at `revokeUrl` when given (Google's), then forgets. Answers whether revoked. */
export async function cloudForget(provider: string, revokeUrl?: string): Promise<boolean> {
  return (await invoke('cloud_forget', { provider, revokeUrl: revokeUrl ?? null })) === true;
}

export interface CloudHostAnswer {
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer;
}

/** One request to a drive, sent by the host, which follows no redirect (the caller does). */
export async function cloudHttp(
  provider: string,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: ArrayBuffer,
): Promise<CloudHostAnswer> {
  const frame = encodeFrame(JSON.stringify({ provider, method, url, headers }), body ? [body] : []);
  const { json, blobs } = decodeFrame((await invoke('cloud_http', frame)) as ArrayBuffer);
  const head = JSON.parse(json) as { status: number; headers?: Record<string, string> };
  return { status: head.status, headers: head.headers ?? {}, body: blobs[0] ?? new ArrayBuffer(0) };
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

/**
 * The desktop core fell back to the pure-Rust renderer: PDFium's library did
 * not bind (`core_engine()` says "hayro" alone). Nothing fails, but Warraq's
 * own drawing of pages — Edit text, Organize, Scan & OCR, page pictures — is
 * hayro's, so the toolbar says so rather than leave it a mystery. Browsers
 * never had PDFium in the core, and say nothing.
 */
export function withoutPdfium(status: CoreStatus | null): boolean {
  return status?.kind === 'native' && status.engine === 'hayro';
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

/* ---------------------------------------------------------------- library */

/**
 * The Library's side of the desktop host (`apps/desktop/src-tauri/src/library.rs`).
 *
 * The shape is the one a folder of ten thousand files needs: the walk is
 * started and answers at once with a number, its findings arrive as events in
 * batches while it runs, and Stop is a second call — nothing here waits on a
 * promise for minutes, and no file's bytes are read to list it. A file is read
 * only when its turn comes.
 *
 * Where the index lives is the host's business, not the page's: the app's own
 * data directory (`~/Library/Application Support/app.warraq.desktop/library`
 * on macOS, `%APPDATA%` on Windows, `~/.local/share` on Linux), never a
 * temporary folder, and `deleteLibraryIndex` really removes it.
 */

/** One folder the person chose, and how much of it they chose. */
export interface LibraryScanRoot {
  path: string;
  /** Its subfolders too. */
  recursive?: boolean;
  /** Full paths of subfolders to leave out — what was unticked. */
  exclude?: string[];
}

/** What the index already holds for a file, so unchanged files are not read again. */
export interface LibraryKnownFile {
  key: string;
  size: number;
  /** Milliseconds since the epoch, as the walk reports them. */
  modified: number;
}

/** The arguments of one walk, or of the watcher. */
export interface LibraryScanRequest {
  roots: LibraryScanRoot[];
  /** Lower-case, without dots. Omitted: the host's own list of the kinds it reads. */
  extensions?: string[];
  /** Only for a walk; the watcher ignores it. */
  known?: LibraryKnownFile[];
}

/** One file found under a chosen folder. Its bytes are not read to list it. */
export interface LibraryFile {
  /** `library.add`'s `key`: the full path. */
  key: string;
  name: string;
  /** Its place under the chosen folder, `/`-separated on every platform. */
  relative: string;
  /** The chosen folder it was found under. */
  root: string;
  size: number;
  modified: number;
  /** Lower-case, no dot; empty when the name has no extension. */
  extension: string;
  /** `new` and `changed` need reading; `same` is already indexed. */
  state: 'new' | 'changed' | 'same';
}

/** A file or folder the walk passed over, and why. Never fatal. */
export interface LibrarySkip {
  path: string;
  reason: 'unreadable' | 'link' | 'too-deep' | 'too-big' | 'too-many';
}

/** One message of a walk under way. `done` arrives once, and last. */
export interface LibraryScanEvent {
  scan: number;
  kind: 'progress' | 'done';
  /** The folder being read now. */
  current: string;
  files: LibraryFile[];
  skipped: LibrarySkip[];
  /** Files found so far, over every folder of this scan. */
  found: number;
  folders: number;
  /** On `done` only: indexed files no folder held any more — moved or gone. */
  missing?: string[];
  stopped: boolean;
  /** A bound was reached: the list is short, and says so. */
  truncated: boolean;
}

/** Whether a file is still there and still what the index holds. */
export interface LibraryFileStamp {
  exists: boolean;
  size: number;
  modified: number;
}

/** An index kept in the app's data directory. */
export interface LibraryIndexFile {
  name: string;
  bytes: number;
  modified: number;
  path: string;
}

/** What the watcher found since its last look. */
export interface LibraryWatchEvent {
  added: LibraryFile[];
  changed: LibraryFile[];
  /** Keys that are no longer there. */
  removed: string[];
  /** Set on the last event when the watcher gave up, with the reason. */
  stopped?: 'too-many';
}

/** Whether the watcher took the folders, and how it works when it did. */
export interface LibraryWatchAnswer {
  watching: boolean;
  /** How many files it re-checks each time. */
  files: number;
  /** How often, in seconds — said plainly, rather than implying live notifications. */
  seconds: number;
  reason?: 'too-many';
}

/** Emitted by `library.rs` while a folder is walked. */
export const LIBRARY_SCAN_EVENT = 'warraq://library-scan';

/** Emitted by `library.rs` when a watched folder changes. */
export const LIBRARY_WATCH_EVENT = 'warraq://library-watch';

/** Whether the Library can reach whole folders: only the desktop host can. */
export function hasLibraryHost(): boolean {
  return isTauriHost();
}

/**
 * The native folder picker, several folders at once. `recursive` puts
 * everything under each of them in the file scope, which is what then lets
 * the walk and the reads see it — nothing outside is reachable.
 */
export async function pickLibraryFolders(): Promise<string[]> {
  const picked = await invoke('plugin:dialog|open', {
    options: { multiple: true, directory: true, recursive: true },
  });
  if (Array.isArray(picked)) return picked.filter((p): p is string => typeof p === 'string');
  return typeof picked === 'string' ? [picked] : [];
}

/**
 * Starts walking the chosen folders and answers at once with the number that
 * names this walk. Everything it finds arrives through `onLibraryScan`.
 */
export async function startLibraryScan(request: LibraryScanRequest): Promise<number> {
  return (await invoke('library_scan_start', { request })) as number;
}

/** Stops a walk. `false` when it had already finished, which is not an error. */
export async function stopLibraryScan(scan: number): Promise<boolean> {
  return (await invoke('library_scan_stop', { scan })) === true;
}

/** Subscribes to a walk's progress and findings. Returns the unsubscribe. */
export function onLibraryScan(onEvent: (event: LibraryScanEvent) => void): () => void {
  const host = internals();
  if (!host) return () => {};
  return listen(host, LIBRARY_SCAN_EVENT, ((event: { payload?: LibraryScanEvent }) => {
    if (event?.payload) onEvent(event.payload);
  }) as (payload: never) => void);
}

/**
 * One file's bytes, when its turn comes. Rejects with `E_SCOPE` for a path
 * outside the chosen folders (a link pointing out of them included) and with
 * `E_TOO_BIG` for a file past what the Library reads.
 */
export async function readLibraryFile(path: string): Promise<ArrayBuffer> {
  return toArrayBuffer(await invoke('library_read_file', { path }));
}

/** Whether a file is still there, and still what the index holds. */
export async function statLibraryFile(path: string): Promise<LibraryFileStamp> {
  return (await invoke('library_stat', { path })) as LibraryFileStamp;
}

/** Where the indexes live on this device, to show the person whose data it is. */
export async function libraryIndexFolder(): Promise<string> {
  return (await invoke('library_index_path')) as string;
}

/** Writes the index the core handed over, whole or not at all. Answers its size. */
export async function saveLibraryIndex(name: string, bytes: Uint8Array): Promise<number> {
  return (await invoke('library_index_save', bytes, {
    headers: { 'x-warraq-name': encodeURIComponent(name) },
  })) as number;
}

/** The index's bytes, or `null` on a first run, when there is none yet. */
export async function loadLibraryIndex(name: string): Promise<ArrayBuffer | null> {
  try {
    return toArrayBuffer(await invoke('library_index_load', { name }));
  } catch (error) {
    if (String(error).includes('E_MISSING')) return null;
    throw error;
  }
}

/** The indexes on this device, with their size and when they were written. */
export async function listLibraryIndexes(): Promise<LibraryIndexFile[]> {
  return (await invoke('library_index_list')) as LibraryIndexFile[];
}

/** Deletes an index for good. `false` when there was nothing to delete. */
export async function deleteLibraryIndex(name: string): Promise<boolean> {
  return (await invoke('library_index_delete', { name })) === true;
}

/**
 * Watches the chosen folders while the app runs. The host looks again every
 * `seconds` rather than asking the system for notifications, and says so:
 * `watching: false` with `reason: 'too-many'` when the folders hold more
 * files than it re-checks, so the panel can tell the person plainly instead
 * of implying it is watching when it is not.
 */
export async function startLibraryWatch(request: LibraryScanRequest): Promise<LibraryWatchAnswer> {
  return (await invoke('library_watch_start', { request })) as LibraryWatchAnswer;
}

/** Stops watching. Safe when nothing is watched. */
export async function stopLibraryWatch(): Promise<void> {
  await invoke('library_watch_stop');
}

/** Subscribes to what the watcher finds. Returns the unsubscribe. */
export function onLibraryWatch(onEvent: (event: LibraryWatchEvent) => void): () => void {
  const host = internals();
  if (!host) return () => {};
  return listen(host, LIBRARY_WATCH_EVENT, ((event: { payload?: LibraryWatchEvent }) => {
    if (event?.payload) onEvent(event.payload);
  }) as (payload: never) => void);
}
