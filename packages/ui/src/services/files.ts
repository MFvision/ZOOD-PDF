/**
 * Web implementation of the HostBridge (PWA and extension): `<input type=file>` to open,
 * File System Access API to save when the browser has it, otherwise `<a download>`.
 */
import type { DropPoint, HostBridge, OpenedFile, SaveOptions, SaveResult } from './host';

interface WritableLike {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
interface FileHandleLike {
  name: string;
  createWritable(): Promise<WritableLike>;
}
type SavePicker = (opts: {
  suggestedName: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileHandleLike>;

export function isPdfBytes(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

export function ensurePdfName(name: string): string {
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

async function readFiles(list: ArrayLike<File>): Promise<OpenedFile[]> {
  const files = Array.from(list);
  return Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
}

function isFileHandle(h: unknown): h is FileHandleLike {
  return !!h && typeof (h as FileHandleLike).createWritable === 'function';
}

async function writeHandle(handle: FileHandleLike, bytes: Uint8Array): Promise<void> {
  const w = await handle.createWritable();
  await w.write(bytes);
  await w.close();
}

function downloadViaAnchor(name: string, bytes: Uint8Array, type = 'application/pdf'): void {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  // Never revoke right after click: some hosts start reading the URL asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function webHost(kind: 'web' | 'extension' = 'web'): HostBridge {
  return {
    kind,
    openFiles(opts = {}) {
      return new Promise<OpenedFile[]>((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = (opts.accept ?? ['application/pdf', '.pdf']).join(',');
        input.multiple = !!opts.multiple;
        input.style.display = 'none';
        let settled = false;
        const finish = (files: ArrayLike<File> | null) => {
          if (settled) return;
          settled = true;
          input.remove();
          // Grab the FileList synchronously; reading happens afterwards.
          const snapshot = files ? Array.from(files) : [];
          readFiles(snapshot).then(resolve, reject);
        };
        input.addEventListener('change', () => finish(input.files));
        input.addEventListener('cancel', () => finish(null));
        document.body.append(input);
        input.click();
      });
    },

    async saveFile(name: string, bytes: Uint8Array, opts: SaveOptions = {}): Promise<SaveResult | null> {
      try {
        if (!opts.saveAs && isFileHandle(opts.handle)) {
          await writeHandle(opts.handle, bytes);
          return { name: opts.handle.name, handle: opts.handle };
        }
        const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
        if (typeof picker === 'function') {
          const zip = opts.mimeType === 'application/zip';
          const handle = await picker({
            suggestedName: name,
            types: zip
              ? [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }]
              : [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
          });
          await writeHandle(handle, bytes);
          return { name: handle.name, handle };
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return null;
        throw e;
      }
      downloadViaAnchor(name, bytes, opts.mimeType);
      return { name };
    },

    onHostDrop(cb: (files: OpenedFile[], point: DropPoint | null) => void) {
      const over = (e: DragEvent) => {
        if (e.dataTransfer && Array.from(e.dataTransfer.types ?? []).includes('Files')) e.preventDefault();
      };
      const drop = (e: DragEvent) => {
        const list = e.dataTransfer?.files;
        if (!list || list.length === 0) return;
        e.preventDefault();
        const snapshot = Array.from(list); // must be captured before the event returns
        const point = { x: e.clientX, y: e.clientY };
        void readFiles(snapshot).then((files) => cb(files, point));
      };
      window.addEventListener('dragover', over);
      window.addEventListener('drop', drop);
      return () => {
        window.removeEventListener('dragover', over);
        window.removeEventListener('drop', drop);
      };
    },
  };
}
