/**
 * Tauri 2 implementation of the host bridge (desktop: macOS, Windows, Linux).
 *
 * Why a host bridge at all: WKWebView (macOS) ignores `<input type=file>` and `<a download>`,
 * so opening and saving go through native dialogs (tauri-plugin-dialog) and
 * `plugin:fs|write_file` (tauri-plugin-fs). OS drag-and-drop arrives as the `zood://drop`
 * event emitted by the Rust side with CSS-pixel coordinates.
 *
 * This file imports nothing from `@tauri-apps/*`: the desktop app (`apps/desktop/src/main.ts`)
 * passes the real APIs in, which keeps `@zood/ui` free of desktop dependencies and lets
 * vitest drive the bridge with fakes. The desktop app installs it as `window.__ZOOD_HOST__`
 * before `mountApp`, so `getHost()` picks it up. File handles are absolute paths (strings).
 */
import type { DropPoint, HostBridge, OpenedFile, SaveOptions, SaveResult } from './host';
import type { SigningNetwork } from './signing';
import type { TrustStore } from './trust';

export type MenuEntry =
  | { type: 'item'; id: string; label: string; accelerator?: string; enabled?: boolean; checked?: boolean }
  | { type: 'separator' }
  | { type: 'submenu'; label: string; items: MenuEntry[] }
  | { type: 'role'; role: string; label?: string };

export interface MenuModel {
  appMenu?: { label: string; items: MenuEntry[] };
  menus: { label: string; items: MenuEntry[] }[];
}

export interface DialogFilter {
  name: string;
  extensions: string[];
}

/** The subset of the Tauri JS APIs the bridge needs (see apps/desktop/src/tauri-apis.ts). */
export interface TauriApis {
  invoke<T>(cmd: string, args?: Record<string, unknown> | Uint8Array): Promise<T>;
  listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
  openDialog(options: { multiple: boolean; directory: false; filters: DialogFilter[] }): Promise<string | string[] | null>;
  saveDialog(options: { defaultPath?: string; filters?: DialogFilter[] }): Promise<string | null>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
}

/** Renders every page of a PDF to an image at `dpi` (used for printing on Windows/Linux). */
export type PageRasterizer = (bytes: Uint8Array, dpi: number) => Promise<Blob[]>;

export interface HostInfo {
  os: 'macos' | 'windows' | 'linux' | 'other';
  titleBarOverlay: boolean;
  trafficLightsWidth: number;
  titleBarHeight: number;
  nativePdfPrint: boolean;
  /** Headless smoke test running (the desktop entry adds self-checks to its ready report). */
  smoke?: boolean;
}

export interface TauriHost extends HostBridge {
  readonly kind: 'desktop';
  info: HostInfo;
  /** Print a PDF: PDFKit on macOS, 300-dpi page images through the webview elsewhere. */
  print(bytes: Uint8Array): Promise<void>;
  /** Native menu bar (macOS) from the web menu model. */
  setMenu(model: MenuModel): void;
  /** Tell the Rust side the interface has rendered (used by the headless smoke test). */
  ready(report?: string): Promise<void>;
  /** Called when a native menu item is chosen. */
  onMenu(cb: (id: string) => void): () => void;
  /** Provide the page renderer used for printing where PDFKit is not available. */
  setPageRasterizer(r: PageRasterizer): void;
  dispose(): void;
}

export const DROP_EVENT = 'zood://drop';
export const MENU_EVENT = 'zood://menu';
export const PRINT_DPI = 300;

const MIME_EXTENSIONS: Record<string, string[]> = {
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'image/tiff': ['tif', 'tiff'],
  'image/bmp': ['bmp'],
  'image/*': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff', 'bmp'],
  'text/plain': ['txt'],
  'text/markdown': ['md', 'markdown'],
  'text/html': ['html', 'htm'],
  'text/csv': ['csv'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'application/x-pkcs12': ['p12', 'pfx'],
};

/** Converts an HTML `accept` list (".pdf", "application/pdf", "image/*") to dialog filters. */
export function acceptToFilters(accept: string[]): DialogFilter[] {
  const exts = new Set<string>();
  for (const raw of accept) {
    const a = raw.trim().toLowerCase();
    if (a === '' || a === '*' || a === '*/*') return [];
    if (a.startsWith('.')) {
      const e = a.slice(1);
      if (/^[a-z0-9]{1,10}$/.test(e)) exts.add(e);
    } else {
      for (const e of MIME_EXTENSIONS[a] ?? []) exts.add(e);
    }
  }
  if (exts.size === 0) return [];
  const extensions = [...exts];
  return [{ name: extensions.map((e) => e.toUpperCase()).join(', '), extensions }];
}

/** Filter for the save dialog, from the suggested name's extension. */
export function saveFilters(name: string): DialogFilter[] | undefined {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  const ext = m?.[1]?.toLowerCase();
  if (!ext) return undefined;
  return [{ name: ext.toUpperCase(), extensions: [ext] }];
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Applies the window-chrome flags as data attributes + CSS custom properties on <html>. */
export function applyChrome(root: HTMLElement, info: HostInfo): void {
  root.dataset.host = 'desktop';
  root.dataset.os = info.os;
  if (info.titleBarOverlay) root.dataset.titlebar = 'overlay';
  const set = (k: string, v: number) => root.style.setProperty(k, `${v}px`);
  set('--zood-titlebar-height', info.titleBarHeight);
  // Traffic lights sit on the physical left whatever the UI direction (the bundle is not
  // localised for RTL window chrome), so in RTL they are at the inline end.
  set('--zood-traffic-lights-left', info.trafficLightsWidth);
  const rtl = root.dir === 'rtl';
  set('--zood-titlebar-inset-inline-start', rtl ? 0 : info.trafficLightsWidth);
  set('--zood-titlebar-inset-inline-end', rtl ? info.trafficLightsWidth : 0);
}

/** Collect every custom item id in a model (used to route menu clicks). */
export function menuIds(model: MenuModel): string[] {
  const ids: string[] = [];
  const walk = (items: MenuEntry[]) => {
    for (const i of items) {
      if (i.type === 'item') ids.push(i.id);
      else if (i.type === 'submenu') walk(i.items);
    }
  };
  if (model.appMenu) walk(model.appMenu.items);
  for (const m of model.menus) walk(m.items);
  return ids;
}

/**
 * Prints page images through the webview's own print dialog (Windows: WebView2, Linux:
 * WebKitGTK) using an image-only document in a hidden iframe.
 */
export async function printImages(pages: Blob[], doc: Document = document): Promise<void> {
  if (pages.length === 0) throw new Error('nothing to print');
  const frame = doc.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  Object.assign(frame.style, { position: 'fixed', inlineSize: '0', blockSize: '0', border: '0', opacity: '0' });
  doc.body.appendChild(frame);
  const urls: string[] = [];
  try {
    const fdoc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!fdoc || !win) throw new Error('print frame unavailable');
    fdoc.open();
    fdoc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    fdoc.close();
    const style = fdoc.createElement('style');
    style.textContent =
      '@page{margin:0}html,body{margin:0;padding:0;background:#fff}' +
      'img{display:block;inline-size:100%;block-size:auto;break-after:page}' +
      'img:last-child{break-after:auto}';
    fdoc.head.appendChild(style);
    for (const page of pages) {
      const url = URL.createObjectURL(page);
      urls.push(url);
      const img = fdoc.createElement('img');
      img.alt = '';
      img.src = url;
      fdoc.body.appendChild(img);
      if (typeof img.decode === 'function') await img.decode().catch(() => undefined);
    }
    // One task for layout before the print dialog snapshots the document.
    await new Promise((r) => setTimeout(r, 0));
    win.focus();
    win.print();
  } finally {
    // print() blocks until the dialog closes in WebView2 and WebKitGTK; keep the frame a
    // little longer anyway so a spooler that reads lazily still sees the images.
    setTimeout(() => {
      for (const u of urls) URL.revokeObjectURL(u);
      frame.remove();
    }, 1000);
  }
}

/**
 * Page renderer backed by the engine's warraq-render (hayro) in the Rust host:
 * `print_open` (raw bytes) → `print_page` per page (PNG) → `print_close`.
 */
export function engineRasterizer(apis: TauriApis): PageRasterizer {
  return async (bytes, dpi) => {
    const pages = await apis.invoke<number>('print_open', bytes);
    try {
      const out: Blob[] = [];
      for (let index = 0; index < pages; index++) {
        const png = await apis.invoke<ArrayBuffer | Uint8Array>('print_page', { index, dpi });
        out.push(new Blob([png instanceof Uint8Array ? (png as Uint8Array<ArrayBuffer>) : png], { type: 'image/png' }));
      }
      return out;
    } finally {
      await apis.invoke('print_close').catch(() => undefined);
    }
  };
}

const toBytes = (v: ArrayBuffer | Uint8Array | number[]): Uint8Array =>
  v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : Uint8Array.from(v);

async function sha256Hex(der: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', der.slice().buffer as ArrayBuffer));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * Signature network (Rust `sign_timestamp` / `sign_ocsp` / `sign_fetch_crl`: http/https, no
 * redirects, size cap, timeout) and the trust list in the app data directory.
 */
export function tauriSigning(apis: TauriApis): { network: SigningNetwork; trust: TrustStore } {
  return {
    network: {
      timestamp: async (url, request) => toBytes(await apis.invoke('sign_timestamp', { url, request: Array.from(request) })),
      ocsp: async (url, request) => toBytes(await apis.invoke('sign_ocsp', { url, request: Array.from(request) })),
      fetchCrl: async (url) => toBytes(await apis.invoke('sign_fetch_crl', { url })),
    },
    trust: {
      async list() {
        const all = await apis.invoke<number[][]>('trust_list');
        return Promise.all(all.map(async (d) => ({ der: Uint8Array.from(d), sha256: await sha256Hex(Uint8Array.from(d)) })));
      },
      add: async (sha256, der) => void (await apis.invoke('trust_add', { sha256, der: Array.from(der) })),
      remove: async (sha256) => void (await apis.invoke('trust_remove', { sha256 })),
    },
  };
}

export async function createTauriHost(
  apis: TauriApis,
  opts: { root?: HTMLElement; rasterize?: PageRasterizer } = {},
): Promise<TauriHost> {
  const root = opts.root ?? document.documentElement;
  const info = await apis.invoke<HostInfo>('host_info');
  let rasterize = opts.rasterize ?? engineRasterizer(apis);
  const disposers: (() => void)[] = [];
  const menuHandlers = new Set<(id: string) => void>();
  let menuIdsKnown = new Set<string>();

  applyChrome(root, info);
  let lastLocale = '';
  const syncLocale = () => {
    applyChrome(root, info);
    const lang = root.lang || '';
    if (lang && lang !== lastLocale) {
      lastLocale = lang;
      void apis.invoke('set_locale', { locale: lang }).catch(() => undefined);
    }
  };
  syncLocale();
  const observer = new MutationObserver(syncLocale);
  observer.observe(root, { attributes: true, attributeFilter: ['lang', 'dir'] });
  disposers.push(() => observer.disconnect());

  const addListener = <T>(event: string, handler: (e: { payload: T }) => void): (() => void) => {
    let off: (() => void) | null = null;
    let cancelled = false;
    void apis.listen<T>(event, handler).then((u) => {
      if (cancelled) u();
      else off = u;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  };

  disposers.push(
    addListener<{ id: string }>(MENU_EVENT, (e) => {
      const id = e.payload?.id;
      if (typeof id !== 'string' || !menuIdsKnown.has(id)) return;
      for (const h of menuHandlers) h(id);
    }),
  );

  const readAll = async (paths: string[]): Promise<OpenedFile[]> => {
    const out: OpenedFile[] = [];
    for (const path of paths) {
      out.push({ name: baseName(path), bytes: await apis.readFile(path), handle: path });
    }
    return out;
  };

  const askAndWrite = async (name: string, bytes: Uint8Array): Promise<SaveResult | null> => {
    const defaultPath = await apis.invoke<string>('suggest_save_path', { name });
    const target = await apis.saveDialog({ defaultPath, filters: saveFilters(name) });
    if (target === null) return null;
    await apis.writeFile(target, bytes);
    return { name: baseName(target), handle: target };
  };

  return {
    kind: 'desktop',
    info,
    signing: tauriSigning(apis),

    async openFiles(opts = {}) {
      const multiple = !!opts.multiple;
      const accept = opts.accept ?? ['application/pdf', '.pdf'];
      const picked = await apis.openDialog({ multiple, directory: false, filters: acceptToFilters(accept) });
      if (picked === null) return [];
      const paths = Array.isArray(picked) ? picked : [picked];
      return readAll(multiple ? paths : paths.slice(0, 1));
    },

    async saveFile(name: string, bytes: Uint8Array, opts: SaveOptions = {}): Promise<SaveResult | null> {
      const path = typeof opts.handle === 'string' && opts.handle !== '' ? opts.handle : null;
      if (path && !opts.saveAs) {
        try {
          await apis.writeFile(path, bytes);
          return { name: baseName(path), handle: path };
        } catch {
          // Not writable any more (e.g. a recent file from an earlier session is outside the
          // fs scope, or the disk is read-only): fall back to asking where to save.
        }
      }
      return askAndWrite(name, bytes);
    },

    onHostDrop(cb: (files: OpenedFile[], point: DropPoint | null) => void) {
      return addListener<{ files: { name: string; path: string }[]; position: { x: number; y: number } }>(
        DROP_EVENT,
        (e) => {
          const { files, position } = e.payload;
          void readAll(files.map((f) => f.path)).then(
            (read) => {
              if (read.length > 0) cb(read, position ? { x: position.x, y: position.y } : null);
            },
            (err: unknown) => console.error('dropped file could not be read', err),
          );
        },
      );
    },

    async print(bytes) {
      if (info.nativePdfPrint) {
        await apis.invoke('print_pdf', bytes);
        return;
      }
      await printImages(await rasterize(bytes, PRINT_DPI));
    },

    setMenu(model) {
      menuIdsKnown = new Set(menuIds(model));
      void apis.invoke<boolean>('set_menu', { model: JSON.stringify(model) }).catch((err: unknown) => {
        console.error('native menu rejected', err);
      });
    },

    onMenu(cb) {
      menuHandlers.add(cb);
      return () => {
        menuHandlers.delete(cb);
      };
    },

    setPageRasterizer(r) {
      rasterize = r;
    },

    async ready(report?: string) {
      await apis.invoke('app_ready', report === undefined ? {} : { report });
    },

    dispose() {
      for (const d of disposers.splice(0)) d();
      menuHandlers.clear();
    },
  };
}
