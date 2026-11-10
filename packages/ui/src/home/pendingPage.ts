import { useEffect, useSyncExternalStore } from 'react';
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
/**
 * Until when a page asked for waits: EmbedPDF sets a file's opening zoom a
 * moment after it opens, and a page gone to before that is lost (the view
 * goes back to page 1 while the page box, told the page it was sent to,
 * still says the page asked for: a tab reopened at start, Ship's check of
 * 0.4.36). `EmbedViewer` holds the request while a file it has just put on
 * screen settles, and lets go once its zoom is set.
 */
let heldUntil = 0;
const listeners = new Set<() => void>();

export function requestPage(page: number): void {
  pending = page;
  asked += 1;
  for (const listener of listeners) listener();
}

/** A file is coming on screen: a page asked for waits until it has settled, `ms` at most. */
export function holdPages(ms: number): void {
  heldUntil = Date.now() + ms;
}

/** The file on screen has settled: a page asked for can be gone to now. */
export function releasePages(): void {
  heldUntil = 0;
}

/** The page asked for and not yet shown, if any. */
export function wantedPage(): number | null {
  return pending;
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
  const goToPage = services.goToPage;
  const pageInView = services.pageInView;
  // Only once the file's bytes are there to draw: before that a page asked
  // for moves nothing, and the count alone would say it had arrived.
  const pages = state.view === 'viewer' && services.documentBytes !== null ? (state.document?.pageCount ?? 0) : 0;
  useEffect(() => {
    if (wanted === null || pages < wanted) return undefined;
    // Up to 20 s: a slow machine can take that long to draw a big file the first time.
    let left = 80;
    let sent = 0;
    const timer = setInterval(() => {
      left -= 1;
      // The file is still settling: going there now would be undone.
      if (Date.now() < heldUntil && left > 0) return;
      // Arrived only when the view really shows it: EmbedPDF reports the page
      // it was sent to at once, even when the view did not move. A page near
      // the end may never come to the top (the view cannot scroll past the
      // last page): on screen after being sent there twice is arrived, so the
      // view is never held there against the person's own scrolling.
      const shown = pageInView();
      const there = shown !== null && (shown.page === wanted || (sent >= 2 && shown.visible.includes(wanted)));
      if (there || left <= 0) {
        clearInterval(timer);
        pending = null;
        for (const listener of listeners) listener();
        return;
      }
      sent += 1;
      goToPage(wanted, 'instant');
    }, 250);
    return () => clearInterval(timer);
  }, [goToPage, pageInView, pages, wanted]);
  return null;
}
