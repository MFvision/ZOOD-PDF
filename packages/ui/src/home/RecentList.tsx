import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Ellipsis, FileText, FolderOpen, Star, StarOff, Trash2 } from 'lucide-react';
import { ContextMenu } from '../components/ContextMenu';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { isTauriHost } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import { useServices } from '../state/AppContext';
import { readRecentDates, readRecentThumbnails } from '../state/recent';
import { starId, toggleStarred, useStarred } from '../state/starred';
import { describeDate } from './dates';
import { DropZone } from './DropZone';

interface RecentListProps {
  /** A row that pages sideways (the home view), or every file as a grid (the Recents view). */
  layout: 'row' | 'grid';
  onSeeAll?: () => void;
}

/**
 * Recent files as paper cards: each with the picture of its first page, its
 * name, when it was last opened, and a ⋯ menu (Open, Star, Remove from
 * recents). Only the name, that small picture and the time are kept, so in
 * a browser choosing one asks for the file again (a browser cannot reopen a
 * file by itself); the desktop app also keeps where it was, and opens it
 * directly. The row pages with ‹ ›; the grid shows them all.
 */
export function RecentList({ layout, onSeeAll }: RecentListProps) {
  const { t, lang, dir } = useI18n();
  const { recent, openRecent, clearRecent, removeRecent } = useServices();
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
          {layout === 'row' && recent.length > 0 && (
            <span className="home-paging">
              <IconButton label={t('home.recentPrev')} icon={<Icon of={ChevronLeft} mirror />} disabled={edges.start} onClick={() => page(-1)} />
              <IconButton label={t('home.recentNext')} icon={<Icon of={ChevronRight} mirror />} disabled={edges.end} onClick={() => page(1)} />
            </span>
          )}
        </div>
      </div>
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
      <ContextMenu
        at={menu?.at ?? null}
        label={menu ? t('home.recentMenu', { name: menu.name }) : ''}
        items={menu ? items(menu.name) : []}
        returnTo={menu?.from}
        onClose={() => setMenu(null)}
      />
      <p className="home-note">{recent.length === 0 ? t('home.recentEmpty') : t(isTauriHost() ? 'home.recentHintDesktop' : 'home.recentHint')}</p>
    </section>
  );
}
