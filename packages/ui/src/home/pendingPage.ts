import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useAppState, useServices } from '../state/AppContext';

/**
 * A page to bring up once the document a search hit came from is open.
 * EmbedPDF draws the file a moment after it opens, and a page asked for
 * before it has drawn is dropped: the page is asked for again until the
 * view really shows it, then let go of (the Library panel does the same).
 *
 * The request outlives the home screen, which is gone the moment the
 * document opens: it is kept here, and `PendingPage` — mounted in the shell
 * — carries it out.
 */
let pending: number | null = null;
let asked = 0;
const listeners = new Set<() => void>();

export function requestPage(page: number): void {
  pending = page;
  asked += 1;
  for (const listener of listeners) listener();
}

/** How many pages have been asked for so far: a change says one was asked for since. */
export function pageRequests(): number {
  return pending === null ? asked : -1;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => pending;

/** Mounted once in the shell: goes to the requested page when the document can show it. */
export function PendingPage(): null {
  const state = useAppState();
  const services = useServices();
  const wanted = useSyncExternalStore(subscribe, read, read);
  const at = useRef(state.currentPage);
  useEffect(() => {
    at.current = state.currentPage;
  }, [state.currentPage]);
  const goToPage = services.goToPage;
  // Only once the file's bytes are there to draw: before that a page asked
  // for moves nothing, and the count alone would say it had arrived.
  const pages = state.view === 'viewer' && services.documentBytes !== null ? (state.document?.pageCount ?? 0) : 0;
  useEffect(() => {
    if (wanted === null || pages < wanted) return undefined;
    // Up to 20 s: a slow machine can take that long to draw a big file the first time.
    let left = 80;
    const timer = setInterval(() => {
      left -= 1;
      if (at.current === wanted || left <= 0) {
        clearInterval(timer);
        pending = null;
        for (const listener of listeners) listener();
        return;
      }
      goToPage(wanted);
    }, 250);
    return () => clearInterval(timer);
  }, [goToPage, pages, wanted]);
  return null;
}
