import { useState } from 'react';
import { ChevronRight, Clock, Folder, FolderOpen, House, Star, Tag } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { APP_ICON } from '../components/appIcon';
import { cx } from '../components/cx';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState } from '../state/AppContext';
import { ContextMenu } from '../components/ContextMenu';
import { ToolIcon } from '../tools/ToolIcon';
import { findTool } from '../tools/tools';
import { TOOL_GROUPS } from '../tools/groups';
import type { ToolGroup } from '../tools/groups';
import { formatBytes } from './useLibraryIndex';
import type { LibraryIndex } from './useLibraryIndex';

export type HomeView = 'home' | 'recents' | 'starred' | 'tags' | 'folders';

const VIEWS: { id: HomeView; label: TKey; icon: LucideIcon }[] = [
  { id: 'home', label: 'home.nav.home', icon: House },
  { id: 'recents', label: 'home.nav.recents', icon: Clock },
  { id: 'starred', label: 'home.nav.starred', icon: Star },
  { id: 'tags', label: 'home.nav.tags', icon: Tag },
  { id: 'folders', label: 'home.nav.folders', icon: Folder },
];

interface HomeSidebarProps {
  view: HomeView;
  onView: (view: HomeView) => void;
  index: LibraryIndex;
}

/**
 * The home screen's sidebar: the app's mark and name, the places — Home,
 * Recents, Starred, Tags, and Folders (with the cloud drives) — then the
 * tools under eight headings, each opening a short menu of its tools, and at the bottom what the Library's index takes on this device (the
 * only storage the app has; there is no quota to show).
 */
export function HomeSidebar({ view, onView, index }: HomeSidebarProps) {
  const { t, lang, dir } = useI18n();
  const { rightPane } = useAppState();
  const dispatch = useAppDispatch();
  const [menu, setMenu] = useState<{ group: ToolGroup; at: { x: number; y: number }; from: HTMLElement } | null>(null);
  const choose = (group: ToolGroup, from: HTMLElement) => {
    const only = group.tools.length === 1 ? group.tools[0] : undefined;
    if (only) return dispatch({ type: 'SET_ACTIVE_TOOL', tool: only });
    // The menu opens beside the heading, on the side away from the sidebar's edge.
    const box = from.getBoundingClientRect();
    setMenu({ group, at: { x: dir === 'rtl' ? box.left - 228 : box.right + 4, y: box.top }, from });
  };
  return (
    <nav className="home-sidebar glass" aria-label={t('home.nav')}>
      <div className="home-brand">
        {/* The mark catches the light now and then (styles/motion.css). */}
        <span className="home-brand-icon">
          <img src={APP_ICON} alt="" width={40} height={40} />
        </span>
        <div className="home-brand-text">
          <p className="home-brand-name">
            <bdi>{t('app.name')}</bdi>
          </p>
          <p className="home-brand-tagline">{t('app.tagline')}</p>
        </div>
      </div>
      <ul className="home-nav">
        {VIEWS.map((one) => (
          <li key={one.id}>
            <button
              type="button"
              className={cx('home-nav-item', view === one.id && 'is-current')}
              aria-current={view === one.id ? 'page' : undefined}
              onClick={() => onView(one.id)}
            >
              {/* Folders shows its folder open while it is the place on screen. */}
              <Icon of={one.id === 'folders' && view === 'folders' ? FolderOpen : one.icon} size={17} />
              <span>{t(one.label)}</span>
            </button>
          </li>
        ))}
      </ul>
      <h3 className="home-nav-heading" id="home-sidebar-tools">
        {t('home.tools')}
      </h3>
      <ul className="home-nav home-nav-tools" aria-labelledby="home-sidebar-tools">
        {TOOL_GROUPS.map((group) => {
          const lead = findTool(group.tools[0]!)!;
          const current = rightPane.activeTool !== null && group.tools.includes(rightPane.activeTool);
          const single = group.tools.length === 1;
          return (
            <li key={group.id}>
              <button
                type="button"
                className={cx('home-nav-item', current && 'is-current')}
                aria-current={current ? 'true' : undefined}
                aria-haspopup={single ? undefined : 'menu'}
                aria-expanded={single ? undefined : menu?.group.id === group.id}
                onClick={(event) => choose(group, event.currentTarget)}
              >
                <ToolIcon tool={lead} size="small" />
                <span>{t(group.label)}</span>
                {!single && <Icon of={ChevronRight} size={14} mirror />}
              </button>
            </li>
          );
        })}
      </ul>
      <ContextMenu
        at={menu?.at ?? null}
        label={menu ? t('home.groupMenu', { group: t(menu.group.label) }) : ''}
        items={(menu?.group.tools ?? []).map((id) => {
          const tool = findTool(id)!;
          return { id, label: t(tool.labelKey), icon: <ToolIcon tool={tool} size="small" />, onSelect: () => dispatch({ type: 'SET_ACTIVE_TOOL', tool: id }) };
        })}
        returnTo={menu?.from}
        onClose={() => setMenu(null)}
      />
      <p className="home-storage" role="status">
        {index.status === 'ready' ? t('home.storage', { size: formatBytes(index.bytes, lang) }) : t('home.storageNone')}
      </p>
    </nav>
  );
}
