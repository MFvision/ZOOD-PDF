import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import { useServices } from '../state/AppContext';
import { visibleBookmarks } from './tree';
import type { Bookmark } from './tree';
import './docpanes.css';

/**
 * Bookmarks: the file's outline, read by Warraq's core (`outline.list`), in
 * either view — a click goes to the page in whichever view is on screen.
 */
export function BookmarksPane() {
  const t = useT();
  const { client, documentBytes, documentPassword, goToPage } = useServices();
  const [items, setItems] = useState<Bookmark[] | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<number>>(new Set());

  useEffect(() => {
    if (!documentBytes) return;
    let cancelled = false;
    client
      .callStatic<{ bookmarks: Bookmark[] }>('outline.list', { password: documentPassword ?? null }, [documentBytes.slice(0)])
      .then(({ result }) => {
        if (cancelled) return;
        setItems(result.bookmarks);
        // As the file says: entries it keeps closed start closed.
        setClosed(new Set(result.bookmarks.flatMap((b, i) => (b.children > 0 && !b.open ? [i] : []))));
      })
      .catch(() => !cancelled && setItems([]));
    return () => {
      cancelled = true;
    };
  }, [client, documentBytes, documentPassword]);

  const shown = useMemo(() => (items ? visibleBookmarks(items, closed) : []), [items, closed]);

  if (items === null) return <p className="docpane-note">{t('pane.loading')}</p>;
  if (items.length === 0) return <p className="docpane-note">{t('bookmarks.none')}</p>;

  const toggle = (index: number) =>
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  return (
    <ul className="docpane-list" role="tree" aria-label={t('pane.bookmarks')}>
      {shown.map(({ item, index }) => {
        const open = !closed.has(index);
        return (
          <li
            key={index}
            role="treeitem"
            aria-level={item.depth + 1}
            aria-expanded={item.children > 0 ? open : undefined}
            className="docpane-row"
            style={{ paddingInlineStart: `${item.depth * 14 + 4}px` }}
          >
            {item.children > 0 ? (
              <button
                type="button"
                className="docpane-twisty"
                aria-label={t(open ? 'bookmarks.collapse' : 'bookmarks.expand', { title: item.title })}
                onClick={() => toggle(index)}
              >
                <Icon of={open ? ChevronDown : ChevronRight} size={14} mirror={!open} />
              </button>
            ) : (
              <span className="docpane-twisty" aria-hidden="true" />
            )}
            <button
              type="button"
              className="docpane-link"
              dir="auto"
              disabled={item.page === null}
              title={item.page === null ? t('bookmarks.elsewhere') : undefined}
              onClick={() => item.page !== null && goToPage(item.page + 1)}
            >
              {item.title || '—'}
              {item.page === null && <Icon of={ExternalLink} size={12} />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
