import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  BookOpen,
  Cloud,
  History,
  House,
  Info,
  Keyboard,
  Palette,
  Search,
  Settings2,
  Sparkles,
  Type,
  Wallet,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState } from '../state/AppContext';
import { AboutPage, AiPage, AppearancePage, CloudPage, FontsPage, GeneralPage, HistoryPage, HomePage, QuickPage, ShortcutsPage, ViewingPage, WalletPage } from './pages';
import './settings.css';

/**
 * Settings: a list of sections at the leading edge, the chosen section's page
 * beside it, and a search field over the list that finds a setting by any
 * word of its name in the language on screen. Opens from the menu (⌘, / Ctrl+,),
 * the home screen's gear and the tour; `openSettingsAt` opens it at a section.
 */

export type SectionId = 'general' | 'appearance' | 'viewing' | 'home' | 'quick' | 'ai' | 'wallet' | 'history' | 'fonts' | 'cloud' | 'shortcuts' | 'about';

interface Section {
  id: SectionId;
  icon: LucideIcon;
  title: TKey;
  /** The names of its settings, for the search. */
  words: readonly TKey[];
  page: () => ReactNode;
}

const SECTIONS: readonly Section[] = [
  { id: 'general', icon: Settings2, title: 'prefs.general', words: ['lang.label', 'prefs.startWith', 'prefs.defaultApp'], page: () => <GeneralPage /> },
  {
    id: 'appearance',
    icon: Palette,
    title: 'prefs.appearance',
    words: ['theme.label', 'look.label', 'prefs.icons', 'prefs.iconSize', 'prefs.menu', 'prefs.menuCommands', 'prefs.accent', 'prefs.reduceTransparency', 'prefs.reduceMotion', 'look.concept', 'look.glass', 'look.zood', 'look.workbench', 'look.mono'],
    page: () => <AppearancePage />,
  },
  {
    id: 'viewing',
    icon: BookOpen,
    title: 'prefs.viewing',
    words: ['prefs.pageLayout', 'prefs.openZoom', 'prefs.openIn', 'prefs.tabBar', 'prefs.tabPosition', 'prefs.pagePanel', 'prefs.toolsPanel', 'prefs.direction', 'prefs.night'],
    page: () => <ViewingPage />,
  },
  { id: 'home', icon: House, title: 'prefs.home', words: ['prefs.greeting', 'prefs.userName', 'prefs.homeSections', 'prefs.recentLimit', 'prefs.clearRecent'], page: () => <HomePage /> },
  {
    id: 'quick',
    icon: Zap,
    title: 'prefs.quick',
    words: ['quick.settings.menu', 'quick.settings.ring', 'prefs.ringTools', 'prefs.menuTools', 'prefs.ringShortcut', 'prefs.ringSize', 'prefs.output', 'prefs.outputPattern', 'quick.settings.background'],
    page: () => <QuickPage />,
  },
  {
    id: 'ai',
    icon: Sparkles,
    title: 'prefs.ai',
    words: ['settings.provider', 'settings.deviceModel', 'prefs.aiScope', 'prefs.keepChats', 'prefs.answerLanguage', 'prefs.aiPrompts', 'settings.speech'],
    page: () => <AiPage />,
  },
  {
    id: 'wallet',
    icon: Wallet,
    title: 'prefs.wallet',
    words: ['profile.title', 'wallet.addresses', 'wallet.banks', 'wallet.identity', 'memory.title'],
    page: () => <WalletPage />,
  },
  {
    id: 'history',
    icon: History,
    title: 'prefs.history',
    words: ['prefs.keepRecent', 'prefs.undoSteps', 'prefs.versions', 'prefs.autosave', 'prefs.clearAll'],
    page: () => <HistoryPage />,
  },
  { id: 'fonts', icon: Type, title: 'prefs.fonts', words: ['fontLibrary.title'], page: () => <FontsPage /> },
  { id: 'cloud', icon: Cloud, title: 'prefs.cloud', words: ['prefs.cloudSoon'], page: () => <CloudPage /> },
  { id: 'shortcuts', icon: Keyboard, title: 'prefs.shortcuts', words: ['shortcuts.title'], page: () => <ShortcutsPage /> },
  { id: 'about', icon: Info, title: 'prefs.about', words: ['help.about', 'help.tour'], page: () => <AboutPage /> },
];

let startAt: SectionId | null = null;

/** The section asked for, once. */
function takeStartAt(): SectionId | null {
  const asked = startAt;
  startAt = null;
  return asked;
}

/** Opens Settings at a section (the quick tools' "Settings…", the AI panel's details). */
export function openSettingsAt(section: SectionId, open: () => void): void {
  startAt = section;
  open();
}

/** Lower case, without Arabic diacritics and tatweel, alef forms as one: what the search compares. */
export function searchable(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');
}

export function SettingsWindow() {
  const { dialog } = useAppState();
  const dispatch = useAppDispatch();
  const { t } = useI18n();
  const open = dialog === 'settings';
  const [chosen, setCurrent] = useState<SectionId>('general');
  const [query, setQuery] = useState('');
  const pageRef = useRef<HTMLDivElement>(null);

  // Opening starts afresh: no search, and the section asked for, if any.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery('');
      const asked = takeStartAt();
      if (asked) setCurrent(asked);
    }
  }

  const matches = useMemo(() => {
    const words = searchable(query.trim());
    if (!words) return SECTIONS;
    return SECTIONS.filter((section) => [section.title, ...section.words].some((key) => searchable(t(key)).includes(words)));
  }, [query, t]);

  // A search that leaves the page on screen out shows the first it finds.
  const current = matches.length > 0 && !matches.some((section) => section.id === chosen) ? matches[0]!.id : chosen;

  useEffect(() => {
    pageRef.current?.scrollTo({ top: 0 });
  }, [current]);

  const section = SECTIONS.find((one) => one.id === current)!;

  return (
    <Dialog open={open} title={t('settings.title')} className="prefs-dialog" onClose={() => dispatch({ type: 'DIALOG', dialog: null })}>
      <div className="prefs">
        <nav className="prefs-nav" aria-label={t('prefs.sections')}>
          <div className="prefs-search">
            <Icon of={Search} size={14} />
            <input
              type="search"
              className="prefs-search-input"
              placeholder={t('prefs.search')}
              aria-label={t('prefs.search')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <ul className="prefs-nav-list">
            {matches.map((one) => (
              <li key={one.id}>
                <button
                  type="button"
                  className={one.id === current ? 'prefs-nav-item is-current' : 'prefs-nav-item'}
                  aria-current={one.id === current ? 'page' : undefined}
                  onClick={() => setCurrent(one.id)}
                >
                  <span className={`prefs-nav-icon prefs-nav-icon-${one.id}`}>
                    <Icon of={one.icon} size={14} />
                  </span>
                  <span>{t(one.title)}</span>
                </button>
              </li>
            ))}
          </ul>
          {matches.length === 0 && <p className="prefs-nav-empty">{t('prefs.noMatch')}</p>}
        </nav>
        <div className="prefs-page" ref={pageRef} role="region" aria-label={t(section.title)}>
          <h2 className="prefs-page-title">{t(section.title)}</h2>
          {open && section.page()}
        </div>
      </div>
    </Dialog>
  );
}
