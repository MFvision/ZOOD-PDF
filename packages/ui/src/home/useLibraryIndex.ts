import { useCallback, useEffect, useRef, useState } from 'react';
import { useServices } from '../state/AppContext';
import { coreLibrary } from '../library/ops';
import type { LibraryOps, LibraryStats, SearchHit } from '../library/ops';
import { onLibraryChanged } from '../library/request';
import { emptyMeta, libraryStore } from '../library/store';
import type { LibraryMeta, LibraryStore } from '../library/store';

/**
 * The Library's index as the home screen reads it: for the search field, the
 * Tags view and the Starred view. Opened only when this device holds one —
 * a home screen with no Library never touches the core for it — and read
 * only: nothing here changes the index, so the Library tool, which may be
 * open beside it, stays the one writer.
 */
export type IndexStatus = 'none' | 'opening' | 'ready' | 'failed';

export interface LibraryIndex {
  status: IndexStatus;
  /** The index file's size in bytes, for the sidebar's honest storage line. */
  bytes: number;
  meta: LibraryMeta;
  stats: LibraryStats | null;
  store: LibraryStore;
  search: (query: string, limit: number) => Promise<SearchHit[]>;
}

export function useLibraryIndex(): LibraryIndex {
  const services = useServices();
  const [store] = useState(libraryStore);
  const ops = useRef<LibraryOps>(coreLibrary(services.client));
  const [status, setStatus] = useState<IndexStatus>('opening');
  const [bytes, setBytes] = useState(0);
  const [meta, setMeta] = useState<LibraryMeta>(emptyMeta);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const handle = useRef<number | null>(null);
  // Read again when the Library panel changes what it keeps, a moment later
  // so a run of changes (each file read) is read once.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onLibraryChanged(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setVersion((one) => one + 1), 400);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const library = ops.current;
    void (async () => {
      try {
        const kept = await store.readIndex().catch(() => null);
        if (!kept || kept.byteLength === 0) {
          if (alive) {
            setStatus('none');
            setMeta(emptyMeta());
          }
          return;
        }
        const { handle: id } = await library.open(kept);
        if (!alive) {
          void library.close(id).catch(() => undefined);
          return;
        }
        handle.current = id;
        const [known, count] = await Promise.all([store.readMeta().catch(emptyMeta), library.stats(id)]);
        if (!alive) return;
        setBytes(kept.byteLength);
        setMeta(known);
        setStats(count);
        setStatus('ready');
      } catch {
        if (alive) setStatus('failed');
      }
    })();
    return () => {
      alive = false;
      const id = handle.current;
      handle.current = null;
      if (id !== null) void library.close(id).catch(() => undefined);
    };
  }, [store, version]);

  const search = useCallback(async (query: string, limit: number) => {
    const id = handle.current;
    if (id === null || query.trim().length === 0) return [];
    const found = await ops.current.search(id, query.trim(), { limit });
    return found.hits;
  }, []);

  return { status, bytes, meta, stats, store, search };
}

/** "1.2 MB" and the like, in the interface's digits. */
export function formatBytes(bytes: number, lang: 'ar' | 'en'): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const number = new Intl.NumberFormat(lang === 'ar' ? 'ar-SA-u-nu-arab' : 'en-US', { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(size);
  return `${number} ${units[unit]}`;
}
