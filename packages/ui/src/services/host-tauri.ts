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
 * vitest drive the bridge with fakes.
 */

export interface HostFile {
  name: string;
  bytes: Uint8Array;
  path?: string;
}

export type MenuEntry =
  | { type: 'item'; id: string; label: string; accelerator?: string; enabled?: boolean; checked?: boolean }
  | { type: 'separator' }
  | { type: 'submenu'; label: string; items: MenuEntry[] }
  | { type: 'role'; role: string; label?: string };

export interface MenuModel {
  appMenu?: { label: string; items: MenuEntry[] };
  menus: { label: string; items: MenuEntry[] }[];
}

export interface HostBridge {
  kind: 'web' | 'desktop' | 'extension';
  openFiles(opts: { multiple: boolean; accept: string[] }): Promise<HostFile[]>;
  saveFile(suggestedName: string, bytes: Uint8Array, path?: string): Promise<{ path?: string } | null>;
  onHostDrop(cb: (files: HostFile[], pos: { x: number; y: number }) => void): () => void;
  print(bytes: Uint8Array): Promise<void>;
  setMenu?(model: MenuModel): void;
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
}

export interface TauriHost extends HostBridge {
  kind: 'desktop';
  info: HostInfo;
  /** Tell the Rust side the interface has rendered (used by the headless smoke test). */
  ready(): Promise<void>;
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
  if (!m) return undefined;
  const ext = m[1].toLowerCase();
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

export async function createTauriHost(
  apis: TauriApis,
  opts: { root?: HTMLElement; rasterize?: PageRasterizer } = {},
): Promise<TauriHost> {
  const root = opts.root ?? document.documentElement;
  const info = await apis.invoke<HostInfo>('host_info');
  let rasterize = opts.rasterize;
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

  const readAll = async (paths: string[]): Promise<HostFile[]> => {
    const out: HostFile[] = [];
    for (const path of paths) {
      out.push({ name: baseName(path), bytes: await apis.readFile(path), path });
    }
    return out;
  };

  return {
    kind: 'desktop',
    info,

    async openFiles({ multiple, accept }) {
      const picked = await apis.openDialog({ multiple, directory: false, filters: acceptToFilters(accept) });
      if (picked === null) return [];
      const paths = Array.isArray(picked) ? picked : [picked];
      return readAll(multiple ? paths : paths.slice(0, 1));
    },

    async saveFile(suggestedName, bytes, path) {
      if (path) {
        try {
          await apis.writeFile(path, bytes);
          return { path };
        } catch {
          // Not writable any more (e.g. a recent file from a previous session is outside the
          // fs scope, or the disk is read-only): fall back to asking where to save.
        }
      }
      const defaultPath = await apis.invoke<string>('suggest_save_path', { name: suggestedName });
      const target = await apis.saveDialog({ defaultPath, filters: saveFilters(suggestedName) });
      if (target === null) return null;
      await apis.writeFile(target, bytes);
      return { path: target };
    },

    onHostDrop(cb) {
      return addListener<{ files: { name: string; path: string }[]; position: { x: number; y: number } }>(
        DROP_EVENT,
        (e) => {
          const { files, position } = e.payload;
          void readAll(files.map((f) => f.path)).then((read) => {
            if (read.length > 0) cb(read, { x: position.x, y: position.y });
          });
        },
      );
    },

    async print(bytes) {
      if (info.nativePdfPrint) {
        await apis.invoke('print_pdf', bytes);
        return;
      }
      if (!rasterize) throw new Error('print: no page renderer registered');
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
      return () => menuHandlers.delete(cb);
    },

    setPageRasterizer(r) {
      rasterize = r;
    },

    async ready() {
      await apis.invoke('app_ready');
    },

    dispose() {
      for (const d of disposers.splice(0)) d();
      menuHandlers.clear();
    },
  };
}
