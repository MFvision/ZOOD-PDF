import { Clock, Cloud, House, Star, Tag } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { APP_ICON } from '../components/appIcon';
import { cx } from '../components/cx';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState } from '../state/AppContext';
import { ToolIcon } from '../tools/ToolIcon';
import { TOOLS } from '../tools/tools';
import { formatBytes } from './useLibraryIndex';
import type { LibraryIndex } from './useLibraryIndex';

export type HomeView = 'home' | 'recents' | 'starred' | 'tags' | 'clouds';

const VIEWS: { id: HomeView; label: TKey; icon: LucideIcon }[] = [
  { id: 'home', label: 'home.nav.home', icon: House },
  { id: 'recents', label: 'home.nav.recents', icon: Clock },
  { id: 'starred', label: 'home.nav.starred', icon: Star },
  { id: 'tags', label: 'home.nav.tags', icon: Tag },
  { id: 'clouds', label: 'home.nav.clouds', icon: Cloud },
];

interface HomeSidebarProps {
  view: HomeView;
  onView: (view: HomeView) => void;
  /** Whether this build has cloud drives: the Clouds entry is there only then. */
  clouds: boolean;
  index: LibraryIndex;
}

/**
 * The home screen's sidebar: the app's mark and name, the places — Home,
 * Recents, Starred, Tags, and Clouds when the build has a drive — then every
 * tool, and at the bottom what the Library's index takes on this device (the
 * only storage the app has; there is no quota to show).
 */
export function HomeSidebar({ view, onView, clouds, index }: HomeSidebarProps) {
  const { t, lang } = useI18n();
  const { rightPane } = useAppState();
  const dispatch = useAppDispatch();
  const views = clouds ? VIEWS : VIEWS.filter((one) => one.id !== 'clouds');
  return (
    <nav className="home-sidebar glass" aria-label={t('home.nav')}>
      <div className="home-brand">
        <img src={APP_ICON} alt="" width={40} height={40} />
        <div className="home-brand-text">
          <p className="home-brand-name">
            <bdi>{t('app.name')}</bdi>
          </p>
          <p className="home-brand-tagline">{t('app.tagline')}</p>
        </div>
      </div>
      <ul className="home-nav">
        {views.map((one) => (
          <li key={one.id}>
            <button
              type="button"
              className={cx('home-nav-item', view === one.id && 'is-current')}
              aria-current={view === one.id ? 'page' : undefined}
              onClick={() => onView(one.id)}
            >
              <Icon of={one.icon} size={17} />
              <span>{t(one.label)}</span>
            </button>
          </li>
        ))}
      </ul>
      <h3 className="home-nav-heading" id="home-sidebar-tools">
        {t('home.tools')}
      </h3>
      <ul className="home-nav home-nav-tools" aria-labelledby="home-sidebar-tools">
        {TOOLS.map((tool) => (
          <li key={tool.id}>
            <button
              type="button"
              className={cx('home-nav-item', rightPane.activeTool === tool.id && 'is-current')}
              aria-current={rightPane.activeTool === tool.id ? 'true' : undefined}
              onClick={() => dispatch({ type: 'SET_ACTIVE_TOOL', tool: tool.id })}
            >
              <ToolIcon tool={tool} size="small" />
              <span>{t(tool.labelKey)}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="home-storage" role="status">
        {index.status === 'ready' ? t('home.storage', { size: formatBytes(index.bytes, lang) }) : t('home.storageNone')}
      </p>
    </nav>
  );
}
