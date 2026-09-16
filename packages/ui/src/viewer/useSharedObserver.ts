import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';

type EntryCallback = (entry: IntersectionObserverEntry) => void;

export interface SharedObserver {
  /** Starts observing `element`; returns the function that stops observing it. */
  observe: (element: Element, callback: EntryCallback) => () => void;
}

/**
 * One IntersectionObserver shared by every page (instead of one per page).
 * The observer is created lazily on first `observe`, when the root is mounted.
 */
export function useSharedObserver(
  rootRef: RefObject<Element | null>,
  rootMargin: string,
  threshold: number | readonly number[],
): SharedObserver {
  const callbacks = useRef(new Map<Element, EntryCallback>());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const thresholdKey = Array.isArray(threshold) ? threshold.join(',') : String(threshold);

  const observe = useCallback(
    (element: Element, callback: EntryCallback) => {
      if (!observerRef.current) {
        observerRef.current = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) callbacks.current.get(entry.target)?.(entry);
          },
          { root: rootRef.current, rootMargin, threshold: thresholdKey.split(',').map(Number) },
        );
      }
      callbacks.current.set(element, callback);
      observerRef.current.observe(element);
      return () => {
        callbacks.current.delete(element);
        observerRef.current?.unobserve(element);
      };
    },
    [rootRef, rootMargin, thresholdKey],
  );

  useEffect(() => {
    const observer = observerRef;
    return () => {
      observer.current?.disconnect();
      observer.current = null;
    };
  }, [observe]);

  return useMemo(() => ({ observe }), [observe]);
}
