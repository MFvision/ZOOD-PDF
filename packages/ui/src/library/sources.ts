import { isTauriHost, listBatchFolder, pickFolder, readBatchFile } from '../core/host-tauri';
import { kindOfName, readableFile } from './kinds';
import type { FolderRecord, LibraryMeta } from './store';
import type { IngestSource } from './ingest';

/**
 * Where the Library's files come from, and how one is found again later.
 *
 * Three hosts, one shape: the desktop picks a folder natively and walks it
 * through its own host; a browser that has the directory picker walks the
 * folder handle it is given (and keeps the handle, so the same folder is read
 * again after a reload); anything else takes files from the file picker.
 * Nothing is read until its turn comes — `bytes()` is what reads it.
 *
 * The files themselves are never written, moved or copied. Walking is
 * bounded: a folder of a million files, or one that links to itself, stops at
 * the cap instead of taking the tab with it.
 */

const MAX_FILES = 20_000;
const MAX_DEPTH = 24;

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
  sources: IngestSource[];
  /** Files under the folder the Library does not read at all, so the count is honest. */
  ignored: number;
}

/** The browser can hand the page a whole folder. Safari and Firefox cannot, yet. */
export function directoryPickerAvailable(): boolean {
  return typeof (globalThis as WithDirectoryPicker).showDirectoryPicker === 'function';
}

/** The desktop picks folders through the system panel. */
export function nativeFolders(): boolean {
  return isTauriHost();
}

function folderId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** A browser key: the folder's own id, then the file's place under it. */
export const browserKey = (folder: string, relative: string): string => `${folder}/${relative}`;

function fromFile(key: string, file: File, name = file.name): IngestSource {
  return {
    key,
    name,
    size: file.size,
    modified: file.lastModified,
    bytes: () => file.arrayBuffer(),
  };
}

/**
 * Files chosen one by one, or a folder taken by a browser that has no
 * directory picker: the key is the folder's id and the file's place under it.
 * The `File`s come back beside the sources, because these are only in hand
 * while the tab lives — after a reload a hit in one of them is reported as
 * gone rather than opened from somewhere it never was.
 */
export function sourcesFromFiles(
  files: readonly File[],
  folder: string,
): { sources: IngestSource[]; ignored: number; held: Map<string, File> } {
  const sources: IngestSource[] = [];
  const held = new Map<string, File>();
  let ignored = 0;
  for (const file of files) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    if (!readableFile(file.name)) {
      ignored += 1;
      continue;
    }
    const key = browserKey(folder, relative);
    sources.push(fromFile(key, file, file.name));
    held.set(key, file);
  }
  return { sources, ignored, held };
}

/** Everything the Library can read under a browser folder handle, subfolders too. */
export async function walkDirectory(
  handle: DirectoryHandle,
  folder: string,
  onFound?: (found: number) => void,
): Promise<{ sources: IngestSource[]; ignored: number }> {
  const sources: IngestSource[] = [];
  let ignored = 0;
  const walk = async (directory: DirectoryHandle, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || sources.length >= MAX_FILES) return;
    const entries = directory.values?.();
    if (!entries) return;
    for await (const entry of entries) {
      if (sources.length >= MAX_FILES) return;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        await walk(entry as DirectoryHandle, path, depth + 1);
        continue;
      }
      if (!readableFile(entry.name)) {
        ignored += 1;
        continue;
      }
      const fileHandle = entry as FileSystemFileHandle;
      // The file itself is read only when its turn comes; `getFile` here is
      // just for its size and date, which is what tells an unchanged file.
      const file = await fileHandle.getFile();
      sources.push(fromFile(browserKey(folder, path), file, entry.name));
      onFound?.(sources.length);
    }
  };
  await walk(handle, '', 0);
  return { sources, ignored };
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
  const { sources, ignored } = await walkDirectory(handle, id, onFound);
  return { record: { id, label: handle.name, source: 'directory', handle }, sources, ignored };
}

/** The desktop's folder picker, walked by the host. `null` when the person cancelled. */
export async function pickNativeFolder(): Promise<AddedFolder | null> {
  const path = await pickFolder(true);
  if (!path) return null;
  const found = await listBatchFolder(path, true);
  const sources = found.map(
    (file): IngestSource => ({
      key: file.path,
      name: file.name,
      size: file.size,
      // The host lists a file's size, not its date; the file is read again
      // whenever its size changed, and otherwise left alone.
      modified: 0,
      bytes: () => readBatchFile(file.path),
    }),
  );
  return { record: { id: path, label: path.split(/[\\/]/).pop() || path, source: 'path', path }, sources, ignored: 0 };
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
export async function fileForKey(
  meta: LibraryMeta,
  key: string,
  held: ReadonlyMap<string, File>,
): Promise<File | null> {
  const inHand = held.get(key);
  if (inHand) return inHand;
  const folder = folderOf(meta, key);
  const name = meta.files[key]?.name ?? key.split(/[\\/]/).pop() ?? key;
  if (folder?.source === 'path' || (!folder && isTauriHost())) {
    try {
      return new File([await readBatchFile(key)], name, { type: mimeOf(name) });
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
  return MIME[extension] ?? (kindOfName(name) === 'pdf' ? 'application/pdf' : 'application/octet-stream');
}
