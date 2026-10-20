import { useEffect, useState } from 'react';
import { BookOpen, Check, Layers, Library, MousePointerClick, Palette, PanelRight, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { isTauriHost } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { openSettingsAt } from '../settings/SettingsWindow';
import type { SectionId } from '../settings/SettingsWindow';
import { isApplePlatform } from '../shell/menuModel';
import { useAppDispatch, useAppState } from '../state/AppContext';
import { readJson, writeJson } from '../state/preferences';
import './tour.css';

/**
 * The welcome tour: a few screens on the desktop app's first run saying
 * what the app does and where things are — the side panel, tabs, the looks
 * in Settings, the AI tool and read aloud, asking about every document at
 * once, and the quick tools that work without opening the
 * app (desktop only). Help → Welcome tour, and Settings' quick tools, open
 * it again. Every line is about something the app does today.
 */

const SEEN_KEY = 'warraq.tour';

interface Screen {
  id: string;
  icon: LucideIcon;
  title: TKey;
  body: TKey;
  points: TKey[];
}

export function tourScreens(desktop: boolean, mac: boolean): Screen[] {
  const screens: Screen[] = [
    { id: 'welcome', icon: BookOpen, title: 'tour.welcome.title', body: 'tour.welcome.body', points: ['tour.welcome.p1', 'tour.welcome.p2'] },
    { id: 'tools', icon: PanelRight, title: 'tour.tools.title', body: 'tour.tools.body', points: ['tour.tools.p1', 'tour.tools.p2'] },
    { id: 'tabs', icon: Layers, title: 'tour.tabs.title', body: 'tour.tabs.body', points: ['tour.tabs.p1', 'tour.tabs.p2'] },
    {
      id: 'looks',
      icon: Palette,
      title: 'tour.looks.title',
      body: 'tour.looks.body',
      points: [mac ? 'tour.looks.p1Mac' : 'tour.looks.p1Other', 'tour.looks.p2'],
    },
    { id: 'ai', icon: Sparkles, title: 'tour.ai.title', body: 'tour.ai.body', points: ['tour.ai.p1', 'tour.ai.p2'] },
    { id: 'across', icon: Library, title: 'tour.across.title', body: 'tour.across.body', points: ['tour.across.p1', 'tour.across.p2'] },
  ];
  if (desktop) {
    screens.push({
      id: 'quick',
      icon: MousePointerClick,
      title: 'tour.quick.title',
      body: 'tour.quick.body',
      points: [mac ? 'tour.quick.p1Mac' : 'tour.quick.p1Windows', 'tour.quick.p2', 'tour.quick.p3'],
    });
  }
  return screens;
}

/** Where the next opening starts: the quick tools' screen from Settings, else the first. */
let startAt: string | null = null;

/** Opens the tour at one screen (by id). */
export function openTourAt(id: string, open: () => void): void {
  startAt = id;
  open();
}

export function WelcomeTour() {
  const { dialog } = useAppState();
  const dispatch = useAppDispatch();
  const { t } = useI18n();
  // Decided once, at start: the host does not change under a running window.
  const [desktop] = useState(isTauriHost);

  // The first run of the desktop app opens it by itself, once.
  useEffect(() => {
    if (!desktop || readJson<{ seen?: boolean }>(SEEN_KEY, {}).seen) return;
    writeJson(SEEN_KEY, { seen: true });
    dispatch({ type: 'DIALOG', dialog: 'tour' });
  }, [desktop, dispatch]);

  const open = dialog === 'tour';
  const close = () => dispatch({ type: 'DIALOG', dialog: null });
  return (
    <Dialog open={open} title={t('tour.title')} onClose={close}>
      {open ? <TourScreens desktop={desktop} onClose={close} onSettings={(section) => openSettingsAt(section, () => dispatch({ type: 'DIALOG', dialog: 'settings' }))} /> : null}
    </Dialog>
  );
}

function TourScreens({ desktop, onClose, onSettings }: { desktop: boolean; onClose: () => void; onSettings: (section: SectionId) => void }) {
  const { t } = useI18n();
  const [screens] = useState(() => tourScreens(desktop, isApplePlatform()));
  const [at, setAt] = useState(() => {
    const wanted = startAt ? screens.findIndex((screen) => screen.id === startAt) : 0;
    startAt = null;
    return Math.max(0, wanted);
  });
  const screen = screens[Math.min(at, screens.length - 1)]!;
  const last = at >= screens.length - 1;

  return (
    <>
      <div className="tour" aria-live="polite">
        <div className="tour-icon" aria-hidden="true">
          <Icon of={screen.icon} size={30} />
        </div>
        <h3 className="tour-title">{t(screen.title)}</h3>
        <p className="tour-body">{t(screen.body)}</p>
        <ul className="tour-points">
          {screen.points.map((point) => (
            <li key={point}>
              <Icon of={Check} size={14} />
              <span>{t(point)}</span>
            </li>
          ))}
        </ul>
        {screen.id === 'looks' ? (
          <button type="button" className="tour-link" onClick={() => onSettings('appearance')}>
            {t('tour.looksSettings')}
          </button>
        ) : null}
        {screen.id === 'quick' ? (
          <button type="button" className="tour-link" onClick={() => onSettings('quick')}>
            {t('tour.quickSettings')}
          </button>
        ) : null}
        <div className="tour-dots" role="tablist" aria-label={t('tour.step', { n: at + 1, total: screens.length })}>
          {screens.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={index === at}
              aria-label={t('tour.step', { n: index + 1, total: screens.length })}
              className={index === at ? 'tour-dot is-current' : 'tour-dot'}
              onClick={() => setAt(index)}
            />
          ))}
        </div>
      </div>
      <div className="dialog-actions">
        {at === 0 ? (
          <button type="button" className="icon-btn icon-btn-labeled" onClick={onClose}>
            {t('tour.skip')}
          </button>
        ) : (
          <button type="button" className="icon-btn icon-btn-labeled" onClick={() => setAt(at - 1)}>
            {t('tour.back')}
          </button>
        )}
        <button type="button" className="icon-btn icon-btn-labeled icon-btn-primary" onClick={last ? onClose : () => setAt(at + 1)}>
          {last ? t('tour.done') : t('tour.next')}
        </button>
      </div>
    </>
  );
}
