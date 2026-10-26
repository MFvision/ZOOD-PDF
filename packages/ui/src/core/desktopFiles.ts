import { isTauriHost, keepNativePath, pickFiles, saveFileAs } from './host-tauri';
import type { FileFilter } from './host-tauri';

/**
 * The desktop webview (WKWebView) ignores a click on a file input and on a
 * download link, so every web-style way of choosing or saving a file is a
 * dead button there. Warraq's own Open and Save go through the native panels;
 * this does the same for everything else on the page — above all EmbedPDF's
 * insert image, attachment, signature upload and screenshot. It is installed
 * on desktop only.
 */

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff'];

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  json: 'application/json',
};

const extensionOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';

/** What an `accept` attribute allows, as the native panel's filters; none means any file. */
export function filtersFor(accept: string): FileFilter[] {
  const extensions = new Set<string>();
  for (const raw of accept.split(',')) {
    const item = raw.trim().toLowerCase();
    if (item === '' || item === '*' || item === '*/*') return [];
    if (item === 'image/*') IMAGE_EXTENSIONS.forEach((e) => extensions.add(e));
    else if (item.startsWith('.')) extensions.add(item.slice(1));
    else {
      const known = Object.entries(MIME_BY_EXTENSION)
        .filter(([, mime]) => mime === item)
        .map(([e]) => e);
      if (known.length === 0) return [];
      known.forEach((e) => extensions.add(e));
    }
  }
  return extensions.size > 0
    ? [{ name: [...extensions].join(', '), extensions: [...extensions] }]
    : [];
}

/** The type a file of this name is read as. */
export function mimeFor(name: string): string {
  return MIME_BY_EXTENSION[extensionOf(name)] ?? 'application/octet-stream';
}

/** The save panel's filter for a download named `name`. */
export function saveFilterFor(name: string): FileFilter {
  const extension = extensionOf(name);
  return extension
    ? { name: extension.toUpperCase(), extensions: [extension] }
    : { name: '*', extensions: ['*'] };
}

/** The bytes of a `data:` URL, base64 or percent-encoded. */
export function dataUrlBytes(url: string): Uint8Array | null {
  const match = /^data:[^,]*?(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  const body = match[2] ?? '';
  if (match[1]) {
    const binary = atob(body);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }
  return new TextEncoder().encode(decodeURIComponent(body));
}

/**
 * The Blob behind each `blob:` URL the page makes, until it is revoked. A
 * download link names its bytes by such a URL, and reading it back with
 * fetch would need `blob:` in the security policy's `connect-src`.
 */
export function blobRegistry(target: { URL: typeof URL }) {
  const blobs = new Map<string, Blob>();
  const create = target.URL.createObjectURL.bind(target.URL);
  const revoke = target.URL.revokeObjectURL.bind(target.URL);
  target.URL.createObjectURL = (object: Blob | MediaSource) => {
    const url = create(object);
    if (object instanceof Blob) blobs.set(url, object);
    return url;
  };
  target.URL.revokeObjectURL = (url: string) => {
    blobs.delete(url);
    revoke(url);
  };
  return {
    get: (url: string) => blobs.get(url),
    restore: () => {
      target.URL.createObjectURL = create;
      target.URL.revokeObjectURL = revoke;
    },
  };
}

/** Routes file inputs and download links through the native panels; returns the undo. */
export function installDesktopFileBridge(): () => void {
  if (!isTauriHost() || typeof HTMLInputElement === 'undefined') return () => undefined;
  const registry = blobRegistry(globalThis);
  const nativeInputClick = HTMLInputElement.prototype.click;
  const nativeLinkClick = HTMLAnchorElement.prototype.click;

  const choose = async (input: HTMLInputElement) => {
    const picked = await pickFiles(filtersFor(input.accept), input.multiple);
    if (picked.length === 0) {
      input.dispatchEvent(new Event('cancel', { bubbles: true }));
      return;
    }
    const transfer = new DataTransfer();
    // Where each one is, for whoever needs it again (the Library, the recent list).
    for (const file of picked)
      transfer.items.add(keepNativePath(new File([file.bytes], file.name, { type: mimeFor(file.name) }), file.path));
    input.files = transfer.files;
    // A webview that hands back its own copies of the files gets told too.
    for (const [at, file] of [...input.files].entries()) keepNativePath(file, picked[at]?.path);
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  };

  const save = (link: HTMLAnchorElement) => {
    const name = link.download || 'download';
    const href = link.href;
    // Taken now, before anything is awaited: EmbedPDF revokes the URL the
    // moment `click()` returns.
    const blob = href.startsWith('blob:') ? registry.get(href) : undefined;
    const data = href.startsWith('data:') ? dataUrlBytes(href) : null;
    return (async () => {
      const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : data;
      if (bytes && bytes.byteLength > 0) await saveFileAs(bytes, name, saveFilterFor(name));
    })();
  };

  HTMLInputElement.prototype.click = function click(this: HTMLInputElement) {
    if (this.type !== 'file') return nativeInputClick.call(this);
    void choose(this).catch(() => undefined);
  };
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    if (!this.hasAttribute('download')) return nativeLinkClick.call(this);
    void save(this).catch(() => undefined);
  };
  // A person's click, or a label's, reaches the element without `.click()`.
  const onClick = (event: MouseEvent) => {
    const target = event.composedPath()[0];
    if (target instanceof HTMLInputElement && target.type === 'file') {
      event.preventDefault();
      void choose(target).catch(() => undefined);
    } else if (target instanceof Element && target.closest('a[download]')) {
      event.preventDefault();
      void save(target.closest('a[download]') as HTMLAnchorElement).catch(() => undefined);
    }
  };
  document.addEventListener('click', onClick, true);
  return () => {
    HTMLInputElement.prototype.click = nativeInputClick;
    HTMLAnchorElement.prototype.click = nativeLinkClick;
    document.removeEventListener('click', onClick, true);
    registry.restore();
  };
}
