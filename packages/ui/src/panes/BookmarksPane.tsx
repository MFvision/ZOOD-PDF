import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import { useServices } from '../state/AppContext';
import { treeKey, visibleBookmarks } from './tree';
import type { Bookmark } from './tree';
import './docpanes.css';

/**
 * Bookmarks: the file's outline, read by Warraq's core (`outline.list`), in
 * either view — a click goes to the page in whichever view is on screen.
 *
 * A tree, as its role says: one stop in the Tab order, the arrow keys move
 * through the entries (right opens one and left closes it, mirrored in
 * Arabic), Home and End go to the ends, Enter goes to the page. An entry that
 * goes outside the file says so; one that goes nowhere is a heading.
 */
export function BookmarksPane() {
  const { t, dir } = useI18n();
  const { client, documentBytes, documentPassword, goToPage } = useServices();
  const [items, setItems] = useState<Bookmark[] | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<number>>(new Set());
  // The entry that is the tree's stop in the Tab order, by its index.
  const [current, setCurrent] = useState(0);
  const rows = useRef(new Map<number, HTMLLIElement>());

  useEffect(() => {
    if (!documentBytes) return;
    let cancelled = false;
    client
      .callStatic<{ bookmarks: Bookmark[] }>('outline.list', { password: documentPassword ?? null }, [documentBytes.slice(0)])
      .then(({ result }) => {
        if (cancelled) return;
        setItems(result.bookmarks);
        setCurrent(0);
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

  // The stop stays on a shown entry: one hidden by closing its parent hands it on.
  const stop = shown.some(({ index }) => index === current) ? current : (shown[0]?.index ?? 0);

  const setOpen = (index: number, open: boolean) =>
    setClosed((before) => {
      const next = new Set(before);
      if (open) next.delete(index);
      else next.add(index);
      return next;
    });

  const focus = (index: number) => {
    setCurrent(index);
    rows.current.get(index)?.focus();
  };

  const activate = (item: Bookmark, index: number) => {
    if (item.page !== null) goToPage(item.page + 1);
    else if (item.children > 0) setOpen(index, closed.has(index));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const at = shown.findIndex(({ index }) => index === stop);
    const here = shown[at];
    if (!here) return;
    const { item, index } = here;
    const open = item.children > 0 && !closed.has(index);
    switch (treeKey(event.key, dir)) {
      case 'next':
        if (shown[at + 1]) focus(shown[at + 1]!.index);
        break;
      case 'previous':
        if (at > 0) focus(shown[at - 1]!.index);
        break;
      case 'first':
        focus(shown[0]!.index);
        break;
      case 'last':
        focus(shown[shown.length - 1]!.index);
        break;
      case 'open':
        if (item.children > 0 && !open) setOpen(index, true);
        else if (open && shown[at + 1]) focus(shown[at + 1]!.index);
        break;
      case 'close': {
        if (open) {
          setOpen(index, false);
          break;
        }
        // To the entry this one is under.
        const parent = shown
          .slice(0, at)
          .reverse()
          .find((s) => s.item.depth < item.depth);
        if (parent) focus(parent.index);
        break;
      }
      case 'activate':
        activate(item, index);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <ul className="docpane-list" role="tree" aria-label={t('pane.bookmarks')} onKeyDown={onKeyDown}>
      {shown.map(({ item, index }) => {
        const open = !closed.has(index);
        const outside = item.page === null && item.outside;
        return (
          <li
            key={index}
            ref={(row) => {
              if (row) rows.current.set(index, row);
              else rows.current.delete(index);
            }}
            role="treeitem"
            aria-level={item.depth + 1}
            aria-expanded={item.children > 0 ? open : undefined}
            tabIndex={index === stop ? 0 : -1}
            className="docpane-row"
            style={{ paddingInlineStart: `${item.depth * 14 + 4}px` }}
            title={outside ? t('bookmarks.elsewhere') : undefined}
            aria-description={outside ? t('bookmarks.elsewhere') : undefined}
            onFocus={() => setCurrent(index)}
            onClick={() => activate(item, index)}
          >
            {item.children > 0 ? (
              // The pointer's way to open and close; the keyboard's is the arrows.
              <span
                className="docpane-twisty"
                aria-hidden="true"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(index, !open);
                }}
              >
                <Icon of={open ? ChevronDown : ChevronRight} size={14} mirror={!open} />
              </span>
            ) : (
              <span className="docpane-twisty" aria-hidden="true" />
            )}
            <span className={item.page !== null || outside ? 'docpane-link' : 'docpane-heading'} dir="auto">
              {item.title || '—'}
              {outside && <Icon of={ExternalLink} size={12} />}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
