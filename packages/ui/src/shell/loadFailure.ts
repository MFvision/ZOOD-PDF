import { useSyncExternalStore } from 'react';

/**
 * Parts of the web app (the page viewer's engine, the OCR reader, a tool)
 * are fetched the first time they are needed. When that fetch fails — the
 * connection dropped, or a new version of the site was published and the
 * old parts are gone — the browser remembers the failure until the page is
 * reloaded, and the part that needed it waits forever: the viewer stayed on
 * "Initializing PDF engine…" and every later file stayed on "Opening…".
 * Vite announces each such failure as `vite:preloadError`; the shell then
 * says so, with Reload, instead of a spinner that never ends.
 */

let failed = false;
const listeners = new Set<() => void>();

/** A part of the app could not be fetched: show the message (once is enough). */
export function noteLoadFailure(): void {
  if (failed) return;
  failed = true;
  for (const listener of listeners) listener();
}

/** Back to nothing failed (the tests). */
export function resetLoadFailure(): void {
  failed = false;
  for (const listener of listeners) listener();
}

export function loadFailed(): boolean {
  return failed;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLoadFailed(): boolean {
  return useSyncExternalStore(subscribe, loadFailed, loadFailed);
}

/** Listens on `target` (the window) for parts that could not be fetched. */
export function watchLoadFailures(target: Pick<EventTarget, 'addEventListener'> | undefined = globalThis as unknown as EventTarget): void {
  target?.addEventListener?.('vite:preloadError', () => noteLoadFailure());
}

watchLoadFailures();
