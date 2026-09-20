import {
  hasLibraryHost,
  onLibraryScan,
  pickLibraryFolders,
  readLibraryFile,
  startLibraryScan,
  stopLibraryScan,
} from '../core/host-tauri';
import type { LibraryScanEvent } from '../core/host-tauri';
import { LIBRARY_ACCEPT } from './kinds';
import type { LibraryFile } from './ingest';
import type { FolderRecord, LibraryMeta } from './store';

/**
 * Where the Library's files come from, and how one is found again later.
 *
 * Three hosts, one shape: the desktop picks folders in the system panel and
 * its own host walks them (`library.rs`, part of this feature); a browser
 * that has the directory picker walks the folder handle it is given, and
 * keeps the handle so the same folder is read again after a reload; anything
 * else takes files from the file picker or a drop. Nothing is read until its
 * turn comes — `read()` is what reads it.
 *
 * The files themselves are never written, moved or copied. Walking in a
 * browser is bounded: a folder of a million files, or one that links to
 * itself, stops at the cap instead of taking the tab with it. (The desktop
 * host has its own bounds.)
 */

const MAX_FILES = 20_000;
const MAX_DEPTH = 24;

/** The extensions the Library reads, without their dots: what the desktop walk keeps. */
const EXTENSIONS = LIBRARY_ACCEPT.split(',')
  .filter((entry) => entry.startsWith('.'))
  .map((entry) => entry.slice(1).toLowerCase());

const READS = new Set(EXTENSIONS);

/** Whether the Library has a reader for a file of this name. */
export function readableFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && READS.has(name.slice(dot + 1).toLowerCase());
}

/** A browser folder handle, with the permission calls the type in `lib.dom` does not carry. */
interface DirectoryHandle extends FileSystemDirectoryHandle {
  values?: () => AsyncIterableIterator<FileSystemHandle>;
  queryPermission?: (options: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (options: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

type WithDirectoryPicker = {
  showDirectoryPicker?: (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<DirectoryHandle>;
};

export interface AddedFolder {
  record: FolderRecord;
  files: LibraryFile[];
  /** Files under the folder the Library has no reader for, so the count is honest. */
  ignored: number;
}

/** The browser can hand the page a whole folder. Safari and Firefox cannot, yet. */
export function directoryPickerAvailable(): boolean {
  return typeof (globalThis as WithDirectoryPicker).showDirectoryPicker === 'function';
}

/** The desktop picks folders in the system panel and walks them itself. */
export function nativeFolders(): boolean {
  return hasLibraryHost();
}

function folderId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** A browser key: the folder's own id, then the file's place under it. */
export const browserKey = (folder: string, relative: string): string => `${folder}/${relative}`;

function fromFile(key: string, file: File, relative: string): LibraryFile {
  return {
    key,
    name: file.name,
    path: relative,
    size: file.size,
    modified: file.lastModified,
    read: () => file.arrayBuffer(),
  };
}

/**
 * Files chosen one by one, or a folder taken by a browser that has no
 * directory picker. The `File`s come back beside the list, because these are
 * in hand only while the tab lives — after a reload a hit in one of them is
 * reported as gone rather than opened from somewhere it never was.
 */
export function filesFromPicker(
  files: readonly File[],
  folder: string,
): { files: LibraryFile[]; ignored: number; held: Map<string, File> } {
  const taken: LibraryFile[] = [];
  const held = new Map<string, File>();
  let ignored = 0;
  for (const file of files) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    if (!readableFile(file.name)) {
      ignored += 1;
      continue;
    }
    const key = browserKey(folder, relative);
    taken.push(fromFile(key, file, relative));
    held.set(key, file);
  }
  return { files: taken, ignored, held };
}

/** Everything the Library can read under a browser folder handle, subfolders too. */
export async function walkDirectory(
  handle: DirectoryHandle,
  folder: string,
  onFound?: (found: number) => void,
): Promise<{ files: LibraryFile[]; ignored: number }> {
  const files: LibraryFile[] = [];
  let ignored = 0;
  const walk = async (directory: DirectoryHandle, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    const entries = directory.values?.();
    if (!entries) return;
    for await (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        await walk(entry as DirectoryHandle, path, depth + 1);
        continue;
      }
      if (!readableFile(entry.name)) {
        ignored += 1;
        continue;
      }
      // The file itself is read only when its turn comes; `getFile` here is
      // for its size and date, which is what tells an unchanged file.
      const file = await (entry as FileSystemFileHandle).getFile();
      files.push(fromFile(browserKey(folder, path), file, path));
      onFound?.(files.length);
    }
  };
  await walk(handle, '', 0);
  return { files, ignored };
}

/** The browser's folder picker, walked. `null` when the person cancelled. */
export async function pickDirectory(onFound?: (found: number) => void): Promise<AddedFolder | null> {
  const picker = (globalThis as WithDirectoryPicker).showDirectoryPicker;
  if (!picker) return null;
  let handle: DirectoryHandle;
  try {
    handle = await picker({ id: 'warraq-library', mode: 'read' });
  } catch {
    // The person closed the panel, or the browser refused: nothing to add.
    return null;
  }
  const id = folderId();
  const { files, ignored } = await walkDirectory(handle, id, onFound);
  return { record: { id, label: handle.name, source: 'directory', handle }, files, ignored };
}

/**
 * The desktop's folder picker, walked by the host: it answers at once and
 * sends what it finds as it goes, so a folder of ten thousand files does not
 * hold the interface. `null` when the person cancelled.
 */
export async function pickNativeFolders(
  onFound?: (found: number, where: string) => void,
  signal?: AbortSignal,
): Promise<AddedFolder[] | null> {
  const paths = await pickLibraryFolders();
  if (paths.length === 0) return null;
  const found = new Map<string, LibraryFile[]>(paths.map((path) => [path, []]));
  await new Promise<void>((resolve, reject) => {
    let stop: (() => void) | null = null;
    let scan = 0;
    const off = onLibraryScan((event: LibraryScanEvent) => {
      if (scan && event.scan !== scan) return;
      for (const file of event.files) {
        const list = found.get(file.root);
        if (!list) continue;
        list.push({
          key: file.key,
          name: file.name,
          path: file.relative,
          size: file.size,
          modified: file.modified,
          read: () => readLibraryFile(file.key),
        });
      }
      onFound?.([...found.values()].reduce((sum, list) => sum + list.length, 0), event.current);
      if (event.kind === 'done') {
        stop?.();
        off();
        resolve();
      }
    });
    startLibraryScan({ roots: paths.map((path) => ({ path, recursive: true })), extensions: EXTENSIONS })
      .then((id) => {
        scan = id;
        const abort = () => void stopLibraryScan(id).catch(() => undefined);
        signal?.addEventListener('abort', abort, { once: true });
        stop = () => signal?.removeEventListener('abort', abort);
      })
      .catch((problem: unknown) => {
        off();
        reject(problem instanceof Error ? problem : new Error(String(problem)));
      });
  });
  return paths.map((path) => ({
    record: { id: path, label: path.split(/[\\/]/).pop() || path, source: 'path', path },
    files: found.get(path) ?? [],
    ignored: 0,
  }));
}

/** The folder a key came from, by the records the store kept. */
export function folderOf(meta: LibraryMeta, key: string): FolderRecord | undefined {
  return meta.folders.find((folder) => key === folder.id || key.startsWith(`${folder.id}/`) || key.startsWith(`${folder.id}\\`));
}

/** Every key the store has under one folder. */
export function keysUnder(meta: LibraryMeta, folder: FolderRecord): string[] {
  return Object.keys(meta.files).filter((key) => folderOf(meta, key)?.id === folder.id);
}

/**
 * The file behind a hit, for opening it. Files added in this session are
 * still in hand; after a reload a browser folder is read again through its
 * handle (asking the person once, as the browser requires) and a desktop
 * folder through its path. `null` means the file has moved or gone — the
 * panel says so and offers to forget it.
 */
export async function fileForKey(meta: LibraryMeta, key: string, held: ReadonlyMap<string, File>): Promise<File | null> {
  const inHand = held.get(key);
  if (inHand) return inHand;
  const folder = folderOf(meta, key);
  const name = meta.files[key]?.name ?? key.split(/[\\/]/).pop() ?? key;
  if (folder?.source === 'path' || (!folder && hasLibraryHost())) {
    try {
      return new File([await readLibraryFile(key)], name, { type: mimeOf(name) });
    } catch {
      return null;
    }
  }
  if (folder?.source === 'directory' && folder.handle) {
    const handle = folder.handle as DirectoryHandle;
    const state = (await handle.queryPermission?.({ mode: 'read' })) ?? 'granted';
    if (state !== 'granted' && (await handle.requestPermission?.({ mode: 'read' })) !== 'granted') return null;
    const parts = key.slice(folder.id.length + 1).split('/');
    const last = parts.pop();
    if (!last) return null;
    try {
      let at: FileSystemDirectoryHandle = handle;
      for (const part of parts) at = await at.getDirectoryHandle(part);
      return await (await at.getFileHandle(last)).getFile();
    } catch {
      return null;
    }
  }
  return null;
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
};

function mimeOf(name: string): string {
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return MIME[extension] ?? 'application/octet-stream';
}
