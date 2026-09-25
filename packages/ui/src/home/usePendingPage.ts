import { useEffect, useRef, useState } from 'react';
import { useAppState, useServices } from '../state/AppContext';

/**
 * Brings a page up once the document a search hit came from is open. EmbedPDF
 * draws the file a moment after it opens, and a page asked for before it has
 * drawn is dropped: the page is asked for again until the view really shows
 * it, then let go of (the Library panel does the same).
 */
export function usePendingPage(): (page: number) => void {
  const state = useAppState();
  const services = useServices();
  const [pending, setPending] = useState<number | null>(null);
  const at = useRef(state.currentPage);
  useEffect(() => {
    at.current = state.currentPage;
  }, [state.currentPage]);
  const goToPage = services.goToPage;
  const pages = state.document?.pageCount ?? 0;
  useEffect(() => {
    if (pending === null || pages < pending) return undefined;
    let left = 24;
    const timer = setInterval(() => {
      left -= 1;
      if (at.current === pending || left <= 0) {
        clearInterval(timer);
        setPending(null);
        return;
      }
      goToPage(pending);
    }, 250);
    return () => clearInterval(timer);
  }, [goToPage, pages, pending]);
  return setPending;
}
