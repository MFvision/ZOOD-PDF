/**
 * A request handed to the Library panel from outside it: the home screen's
 * Tags view asks it to open with one tag chosen as a filter, and the Folders
 * view asks it to add a folder, or files the person chose there. Taken once
 * when the panel mounts, or applied at once if it is already open.
 */
export type LibraryRequest = { tag: string } | { addFolder: true } | { addFiles: readonly File[] };

let pending: LibraryRequest | null = null;
const listeners = new Set<(request: LibraryRequest) => void>();

export function postLibraryRequest(request: LibraryRequest): void {
  pending = request;
  for (const listener of listeners) listener(request);
}

export function takeLibraryRequest(): LibraryRequest | null {
  const request = pending;
  pending = null;
  return request;
}

export function onLibraryRequest(listener: (request: LibraryRequest) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The panel says when what it keeps has changed (a folder added, a file
 * read, a folder forgotten), so the home screen's read-only view of it —
 * Folders, Tags, Starred — reads it again instead of showing the old list.
 */
const changeListeners = new Set<() => void>();

export function announceLibraryChanged(): void {
  for (const listener of changeListeners) listener();
}

export function onLibraryChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}
