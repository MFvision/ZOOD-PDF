import {
  hasLibraryHost,
  keepNativePath,
  nativePathOf,
  onLibraryScan,
  pickLibraryFolders,
  readLibraryFile,
  startLibraryScan,
  startLibraryWatch,
  stopLibraryScan,
} from '../core/host-tauri';
import type {
  LibraryFile as HostFile,
  LibraryScanEvent,
  LibrarySkip,
  LibraryWatchAnswer,
} from '../core/host-tauri';
import { LIBRARY_ACCEPT } from './kinds';
import type { IngestFile } from './ingest';
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
  files: IngestFile[];
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

/** A key that is a file's own path on this device (`C:\…`, `\\server\…`, `/…`), as the desktop's keys are. */
export const isDevicePath = (key: string): boolean => /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(key);

/**
 * The files added in this session, by key: the panel and the home screen's
 * views (Folders, Starred, the search) open them from here, so a file just
 * added opens with one click wherever it is shown. Memory only — it goes
 * with the window.
 */
export const heldFiles = new Map<string, File>();

function fromFile(key: string, file: File): IngestFile {
  return {
    key,
    name: file.name,
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
): { files: IngestFile[]; ignored: number; held: Map<string, File> } {
  const taken: IngestFile[] = [];
  const held = new Map<string, File>();
  let ignored = 0;
  for (const file of files) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    if (!readableFile(file.name)) {
      ignored += 1;
      continue;
    }
    // The desktop knows where a chosen file is: keyed by that path, as its
    // folders' files are, it is read from there again after a restart.
    const path = nativePathOf(file);
    const key = path && isDevicePath(path) ? path : browserKey(folder, relative);
    taken.push(fromFile(key, file));
    held.set(key, file);
  }
  return { files: taken, ignored, held };
}

/** Everything the Library can read under a browser folder handle, subfolders too. */
export async function walkDirectory(
  handle: DirectoryHandle,
  folder: string,
  onFound?: (found: number) => void,
): Promise<{ files: IngestFile[]; ignored: number }> {
  const files: IngestFile[] = [];
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
      files.push(fromFile(browserKey(folder, path), file));
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

/** One file or folder the desktop walk passed over, in words a person reads. */
export interface PassedOver {
  path: string;
  reason: LibrarySkip['reason'];
}

export interface NativeScan {
  folders: AddedFolder[];
  /** What the walk passed over, and why — never fatal, but never silent either. */
  skipped: PassedOver[];
  /** Indexed files no chosen folder holds any more: moved, or gone. */
  missing: string[];
  /** The walk reached a bound of the host's, so the list is short and says so. */
  truncated: boolean;
  stopped: boolean;
}

/** A folder record for one of the paths the desktop walked. */
export const nativeFolderRecord = (path: string): FolderRecord => ({
  id: path,
  label: path.split(/[\\/]/).pop() || path,
  source: 'path',
  path,
});

/** What the index already holds, in the shape the host's walk wants. */
export type KnownFiles = Record<string, { size: number; modified: number }>;

/** The system panel: the folders a person chose, or none. */
export function pickNativeFolderPaths(): Promise<string[]> {
  return pickLibraryFolders();
}

/**
 * The folders walked by the desktop host: it answers at once and sends what
 * it finds in batches while it runs, so a folder of ten thousand files never
 * holds the interface. Stop ends the walk where it is.
 */
export async function scanNativeFolders(
  paths: readonly string[],
  known: KnownFiles,
  onFound?: (found: number, where: string) => void,
  signal?: AbortSignal,
): Promise<NativeScan> {
  const found = new Map<string, IngestFile[]>(paths.map((path) => [path, []]));
  const scan: NativeScan = { folders: [], skipped: [], missing: [], truncated: false, stopped: false };
  let letGo: (() => void) | null = null;
  await new Promise<void>((resolve, reject) => {
    let id = 0;
    const off = onLibraryScan((event: LibraryScanEvent) => {
      if (id && event.scan !== id) return;
      for (const file of event.files) {
        const list = found.get(file.root);
        if (!list) continue;
        list.push({
          key: file.key,
          name: file.name,
          size: file.size,
          modified: file.modified,
          // The walk has already weighed it: `same` saves reading and
          // hashing a file whose size and date have not moved.
          state: file.state,
          read: () => readLibraryFile(file.key),
        });
      }
      for (const passed of event.skipped) scan.skipped.push({ path: passed.path, reason: passed.reason });
      if (event.truncated) scan.truncated = true;
      onFound?.([...found.values()].reduce((sum, list) => sum + list.length, 0), event.current);
      if (event.kind === 'done') {
        scan.missing = event.missing ?? [];
        scan.stopped = event.stopped;
        letGo?.();
        off();
        resolve();
      }
    });
    startLibraryScan({
      roots: paths.map((path) => ({ path, recursive: true })),
      extensions: EXTENSIONS,
      known: Object.entries(known).map(([key, mark]) => ({ key, size: mark.size, modified: mark.modified })),
    })
      .then((started) => {
        id = started;
        const abort = () => void stopLibraryScan(started).catch(() => undefined);
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
        letGo = () => signal?.removeEventListener('abort', abort);
      })
      .catch((problem: unknown) => {
        off();
        reject(problem instanceof Error ? problem : new Error(String(problem)));
      });
  });
  scan.folders = paths.map((path) => ({ record: nativeFolderRecord(path), files: found.get(path) ?? [], ignored: 0 }));
  return scan;
}

/**
 * What the host's watcher found, as files the Library can read. The watcher
 * is a five-second re-check, not the system telling us — the panel says so
 * rather than letting a person believe it is instant.
 */
export function watchedFiles(files: readonly HostFile[]): IngestFile[] {
  return files.map((file) => ({
    key: file.key,
    name: file.name,
    size: file.size,
    modified: file.modified,
    state: file.state,
    read: () => readLibraryFile(file.key),
  }));
}

/** Asks the host to keep re-checking these folders; it may refuse, and says why. */
export function watchNativeFolders(paths: readonly string[]): Promise<LibraryWatchAnswer> {
  return startLibraryWatch({ roots: paths.map((path) => ({ path, recursive: true })), extensions: EXTENSIONS });
}

export { onLibraryWatch as onNativeWatch, stopLibraryWatch as stopNativeWatch } from '../core/host-tauri';
export type { LibraryWatchAnswer, LibraryWatchEvent } from '../core/host-tauri';

/** The folder a key came from, by the records the store kept. */
export function folderOf(meta: LibraryMeta, key: string): FolderRecord | undefined {
  // A file chosen by itself on the desktop is keyed by its own path, so its
  // record names the folder it was added under.
  const named = meta.files[key]?.folder;
  const under = named ? meta.folders.find((folder) => folder.id === named && folder.source === 'files') : undefined;
  if (under) return under;
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
export async function fileForKey(meta: LibraryMeta, key: string, held: ReadonlyMap<string, File> = heldFiles): Promise<File | null> {
  const inHand = held.get(key);
  if (inHand) return inHand;
  const folder = folderOf(meta, key);
  const name = meta.files[key]?.name ?? key.split(/[\\/]/).pop() ?? key;
  if (folder?.source === 'path' || (hasLibraryHost() && (!folder || isDevicePath(key)))) {
    try {
      return keepNativePath(new File([await readLibraryFile(key)], name, { type: mimeOf(name) }), key);
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

/**
 * Whether a file added by itself has to be chosen again before it opens: a
 * browser keeps no way back to it once the page has been reloaded. On the
 * desktop it is read from its own path instead.
 */
export function mustChooseAgain(meta: LibraryMeta, key: string): boolean {
  if (heldFiles.has(key) || (hasLibraryHost() && isDevicePath(key))) return false;
  return folderOf(meta, key)?.source === 'files';
}

/**
 * Asks for such a file again: the picker takes every kind the Library reads,
 * not only PDFs, and the file chosen — the same one, by name — is held, so it
 * opens with one click from then on. `null` when the person cancels.
 */
export function chooseAgain(key: string, name: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = LIBRARY_ACCEPT;
    input.addEventListener(
      'change',
      () => {
        const file = input.files?.[0] ?? null;
        if (file && file.name === name) heldFiles.set(key, file);
        resolve(file);
      },
      { once: true },
    );
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
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
