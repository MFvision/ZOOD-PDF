/**
 * A request handed to the Library panel from outside it: the home screen's
 * Tags view asks it to open with one tag chosen as a filter. Taken once when
 * the panel mounts, or applied at once if it is already open.
 */
export interface LibraryRequest {
  tag: string;
}

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
