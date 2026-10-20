import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Ellipsis, FilePlus2, FileText, FolderOpen, LayoutGrid, List, Star, StarOff, Trash2 } from 'lucide-react';
import { ContextMenu } from '../components/ContextMenu';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { isTauriHost, recentFolder } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import { useServices } from '../state/AppContext';
import { readJson, writeJson } from '../state/preferences';
import { readRecentDates, readRecentSizes, readRecentThumbnails } from '../state/recent';
import { starId, toggleStarred, useStarred } from '../state/starred';
import { describeDate } from './dates';
import { DropZone } from './DropZone';
import { formatBytes } from './useLibraryIndex';

interface RecentListProps {
  /**
   * A row that pages sideways (the home view), every file as a grid (the
   * Recents view), or a table of name, date, size and place (the Workbench
   * look's home), which a switch turns into the grid and back.
   */
  layout: 'row' | 'grid' | 'table';
  onSeeAll?: () => void;
}

type TableView = 'table' | 'grid';
const VIEW_KEY = 'zood.recentView';
const readView = (): TableView => (readJson<unknown>(VIEW_KEY, 'table') === 'grid' ? 'grid' : 'table');

/** Where each recent file was, by name: asked of the desktop, which keeps the paths; nothing in a browser. */
function useRecentFolders(names: readonly string[], wanted: boolean): Record<string, string> {
  const [folders, setFolders] = useState<Record<string, string>>({});
  const key = names.join('\n');
  useEffect(() => {
    if (!wanted || !isTauriHost()) return undefined;
    let live = true;
    void Promise.all(key.split('\n').filter(Boolean).map(async (name) => [name, await recentFolder(name)] as const)).then((found) => {
      if (live) setFolders(Object.fromEntries(found.filter((entry): entry is readonly [string, string] => entry[1] !== null)));
    });
    return () => {
      live = false;
    };
  }, [key, wanted]);
  return folders;
}

/**
 * Recent files as paper cards: each with the picture of its first page, its
 * name, when it was last opened, and a ⋯ menu (Open, Star, Remove from
 * recents). Only the name, that small picture and the time are kept, so in
 * a browser choosing one asks for the file again (a browser cannot reopen a
 * file by itself); the desktop app also keeps where it was, and opens it
 * directly. The row pages with ‹ ›; the grid shows them all.
 */
export function RecentList({ layout: asked, onSeeAll }: RecentListProps) {
  const { t, lang, dir } = useI18n();
  const { recent, openRecent, clearRecent, removeRecent, requestOpenFile, requestCreateFiles } = useServices();
  const switchable = asked === 'table';
  const [view, setView] = useState<TableView>(readView);
  const layout = switchable ? view : asked;
  const sizes = readRecentSizes(recent);
  const folders = useRecentFolders(recent, layout === 'table');
  const chooseView = (next: TableView) => {
    setView(next);
    writeJson(VIEW_KEY, next);
  };
  const starred = useStarred();
  const thumbnails = readRecentThumbnails();
  const dates = readRecentDates(recent);
  const [menu, setMenu] = useState<{ name: string; at: { x: number; y: number }; from: HTMLElement } | null>(null);
  const scroller = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  // Which arrows do anything: none at all when every card is already in view.
  useEffect(() => {
    const list = scroller.current;
    if (!list || layout !== 'row') return undefined;
    const measure = () => {
      const travelled = Math.abs(list.scrollLeft);
      const room = list.scrollWidth - list.clientWidth;
      setEdges({ start: travelled <= 1, end: travelled >= room - 1 });
    };
    measure();
    list.addEventListener('scroll', measure, { passive: true });
    const watcher = new ResizeObserver(measure);
    watcher.observe(list);
    return () => {
      list.removeEventListener('scroll', measure);
      watcher.disconnect();
    };
  }, [layout, recent.length]);

  const page = (step: 1 | -1) => {
    const list = scroller.current;
    if (!list) return;
    // Forward is towards the reading end: to the left in Arabic.
    const sign = dir === 'rtl' ? -step : step;
    list.scrollBy({ left: sign * list.clientWidth * 0.8, behavior: 'smooth' });
  };

  const starOf = (name: string) => starred.some((item) => item.id === starId('recent', name));
  const items = (name: string) => [
    { id: 'open', label: t('file.open'), icon: <Icon of={FolderOpen} size={14} />, onSelect: () => openRecent(name) },
    {
      id: 'star',
      label: t(starOf(name) ? 'starred.remove' : 'starred.add', { name }),
      icon: <Icon of={starOf(name) ? StarOff : Star} size={14} />,
      onSelect: () => toggleStarred({ id: starId('recent', name), name, source: 'recent' }),
    },
    {
      id: 'remove',
      label: t('home.recentRemove'),
      icon: <Icon of={Trash2} size={14} />,
      separatorBefore: true,
      onSelect: () => removeRecent(name),
    },
  ];

  return (
    <section className="home-section" aria-labelledby="home-recent">
      <div className="home-section-header">
        <h2 id="home-recent">{t('home.recent')}</h2>
        <div className="home-section-tools">
          {recent.length > 0 && layout === 'row' && onSeeAll && (
            <button type="button" className="link-btn" onClick={onSeeAll}>
              {t('home.recentAll')}
            </button>
          )}
          {recent.length > 0 && (
            <button type="button" className="link-btn" onClick={clearRecent}>
              {t('home.recentClear')}
            </button>
          )}
          {switchable && (
            <span className="segmented recent-view-switch" role="radiogroup" aria-label={t('home.recentView')}>
              {(['table', 'grid'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  className="segmented-item"
                  aria-checked={view === option}
                  aria-label={t(option === 'table' ? 'home.recentList' : 'home.recentGrid')}
                  title={t(option === 'table' ? 'home.recentList' : 'home.recentGrid')}
                  onClick={() => chooseView(option)}
                >
                  <Icon of={option === 'table' ? List : LayoutGrid} size={14} />
                </button>
              ))}
            </span>
          )}
          {layout === 'row' && recent.length > 0 && (
            <span className="home-paging">
              <IconButton label={t('home.recentPrev')} icon={<Icon of={ChevronLeft} mirror />} disabled={edges.start} onClick={() => page(-1)} />
              <IconButton label={t('home.recentNext')} icon={<Icon of={ChevronRight} mirror />} disabled={edges.end} onClick={() => page(1)} />
            </span>
          )}
        </div>
      </div>
      {recent.length === 0 && layout !== 'grid' ? (
        // Nothing opened yet: what to do first, not an empty shelf.
        <div className="recent-empty">
          <span className="recent-empty-mark" aria-hidden="true">
            <Icon of={FileText} size={26} />
          </span>
          <div className="recent-empty-text">
            <p className="recent-empty-title">{t('home.recentEmptyTitle')}</p>
            <p>{t('home.recentEmptyText')}</p>
          </div>
          <div className="recent-empty-actions">
            <button type="button" className="icon-btn icon-btn-labeled icon-btn-primary" onClick={requestOpenFile}>
              <Icon of={FolderOpen} size={16} />
              <span>{t('home.recentEmptyOpen')}</span>
            </button>
            <button type="button" className="icon-btn icon-btn-labeled" onClick={requestCreateFiles}>
              <Icon of={FilePlus2} size={16} />
              <span>{t('home.recentEmptyCreate')}</span>
            </button>
          </div>
        </div>
      ) : layout === 'table' ? (
        recent.length > 0 && (
          <table className="recent-table">
            <thead>
              <tr>
                <th scope="col">{t('home.col.name')}</th>
                <th scope="col">{t('home.col.opened')}</th>
                <th scope="col">{t('home.col.size')}</th>
                <th scope="col">{t('home.col.place')}</th>
                <th scope="col">
                  <span className="sr-only">{t('home.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {recent.map((name) => (
                <tr key={name}>
                  <td className="recent-table-name">
                    <button type="button" className="recent-table-open" onClick={() => openRecent(name)} title={t('home.recentOpen', { name })}>
                      <span className="recent-table-thumb" aria-hidden="true">
                        {thumbnails[name] ? <img src={thumbnails[name]} alt="" /> : <Icon of={FileText} size={14} />}
                      </span>
                      {starOf(name) && (
                        <span className="recent-table-star" role="img" aria-label={t('home.starred')}>
                          <Icon of={Star} size={12} />
                        </span>
                      )}
                      <span dir="auto">{name.replace(/\.pdf$/i, '')}</span>
                    </button>
                  </td>
                  <td>{dates[name] !== undefined ? describeDate(dates[name], lang, t) : '—'}</td>
                  <td>{sizes[name] !== undefined ? formatBytes(sizes[name], lang) : '—'}</td>
                  <td className="recent-table-place" title={folders[name]} dir="auto">
                    {folders[name] ?? (isTauriHost() ? '—' : t('home.placeBrowser'))}
                  </td>
                  <td>
                    <IconButton
                      className="recent-more"
                      label={t('home.recentMenu', { name })}
                      icon={<Icon of={Ellipsis} size={16} />}
                      aria-haspopup="menu"
                      aria-expanded={menu?.name === name}
                      onClick={(event) => {
                        const box = event.currentTarget.getBoundingClientRect();
                        setMenu({ name, at: { x: dir === 'rtl' ? box.left : box.right - 200, y: box.bottom + 4 }, from: event.currentTarget });
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : (
      <ul ref={scroller} className={layout === 'row' ? 'recent-row' : 'recent-grid'}>
        {layout === 'grid' && (
          <li>
            <DropZone />
          </li>
        )}
        {recent.map((name) => (
          <li key={name} className="recent-card">
            <button type="button" className="recent-item" onClick={() => openRecent(name)} title={t('home.recentOpen', { name })}>
              <span className="recent-page">
                {thumbnails[name] ? <img src={thumbnails[name]} alt="" /> : <Icon of={FileText} size={28} />}
                {starOf(name) && (
                  <span className="recent-star" aria-hidden="true">
                    <Icon of={Star} size={11} />
                  </span>
                )}
              </span>
              <span className="recent-name" dir="auto">
                {name.replace(/\.pdf$/i, '')}
              </span>
              {dates[name] !== undefined && <span className="recent-date">{describeDate(dates[name], lang, t)}</span>}
            </button>
            <IconButton
              className="recent-more"
              label={t('home.recentMenu', { name })}
              icon={<Icon of={Ellipsis} size={16} />}
              aria-haspopup="menu"
              aria-expanded={menu?.name === name}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                setMenu({ name, at: { x: dir === 'rtl' ? box.right - 200 : box.left, y: box.bottom + 4 }, from: event.currentTarget });
              }}
            />
          </li>
        ))}
      </ul>
      )}
      <ContextMenu
        at={menu?.at ?? null}
        label={menu ? t('home.recentMenu', { name: menu.name }) : ''}
        items={menu ? items(menu.name) : []}
        returnTo={menu?.from}
        onClose={() => setMenu(null)}
      />
      {recent.length > 0 ? (
        <p className="home-note">{t(isTauriHost() ? 'home.recentHintDesktop' : 'home.recentHint')}</p>
      ) : (
        layout === 'grid' && <p className="home-note">{t('home.recentEmpty')}</p>
      )}
    </section>
  );
}
