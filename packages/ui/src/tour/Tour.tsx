import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { ZoodMark } from '../components/ZoodMark';
import { isTauriHost } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import { openSettingsAt } from '../settings/SettingsWindow';
import type { SectionId } from '../settings/SettingsWindow';
import { useAppDispatch, useAppState } from '../state/AppContext';
import { readJson, writeJson } from '../state/preferences';
import { askAvailable } from '../ask/settings';
import { QuickAskScene } from './quickAskScene';
import { TOUR_VERSION, newSince, tourChapters } from './chapters';
import { openTourAt, takeStartAt } from './openAt';
import type { Chapter, ChapterId } from './chapters';
import { AiScene, BasicsScene, DoneScene, FilmScene, LookScene, QuickScene, RemoteScene, WelcomeScene } from './scenes';
import type { TourProgress } from './scenes';
import { AskScene } from './askScene';
import { SupportScene } from './supportScene';
import { FoldersScene } from './foldersScene';
import { showHomeView } from '../home/homeView';
import { openSupportAt } from '../support/open';
import './tour.css';

/**
 * The welcome tour: the first impression, the training and the help centre
 * in one. It opens by itself on the desktop app's first run (and once more
 * when the tour is new), and again from Help › Welcome tour and Settings'
 * quick tools. Chapters down the side, each with a scene that moves: choose
 * the language and the look here and the tour changes with them, watch the
 * film, see where the tools are, practise the ring on sample files, connect
 * the phone with the real code, and meet the AI. Every line is about
 * something the app does today.
 */

const SEEN_KEY = 'warraq.tour';

export { openTourAt } from './openAt';

export function WelcomeTour() {
  const { dialog } = useAppState();
  const dispatch = useAppDispatch();
  const { t } = useI18n();
  // Decided once, at start: the host does not change under a running window.
  const [desktop] = useState(isTauriHost);
  const [ask] = useState(askAvailable);

  // The desktop app opens it by itself on its first run, and once when the tour is new, at what is new.
  useEffect(() => {
    const seen = readJson<{ version?: number }>(SEEN_KEY, {}).version ?? 0;
    if (!desktop || seen >= TOUR_VERSION) return;
    writeJson(SEEN_KEY, { seen: true, version: TOUR_VERSION });
    openTourAt(newSince(seen, ask), () => dispatch({ type: 'DIALOG', dialog: 'tour' }));
  }, [desktop, ask, dispatch]);

  const open = dialog === 'tour';
  const close = () => dispatch({ type: 'DIALOG', dialog: null });
  return (
    <Dialog open={open} title={t('tour.title')} onClose={close} className="tour-dialog">
      {open ? (
        <TourBook
          desktop={desktop}
          ask={ask}
          onClose={close}
          onSettings={(section) => openSettingsAt(section, () => dispatch({ type: 'DIALOG', dialog: 'settings' }))}
          onSupport={() => openSupportAt('ask', () => dispatch({ type: 'DIALOG', dialog: 'support' }))}
          onFolders={() => {
            close();
            dispatch({ type: 'SHOW_HOME', shown: true });
            showHomeView('folders');
          }}
        />
      ) : null}
    </Dialog>
  );
}

function TourBook({ desktop, ask, onClose, onSettings, onSupport, onFolders }: { desktop: boolean; ask: boolean; onClose: () => void; onSettings: (section: SectionId) => void; onSupport: () => void; onFolders: () => void }) {
  const { t, dir } = useI18n();
  const [chapters] = useState(() => tourChapters(desktop, ask));
  const [at, setAt] = useState(() => {
    const id = takeStartAt();
    return Math.max(0, id ? chapters.findIndex((chapter) => chapter.id === id) : 0);
  });
  // Which way the last move went, so the next chapter comes in from that side.
  const [heading, setHeading] = useState<1 | -1>(1);
  const [seen, setSeen] = useState<ReadonlySet<ChapterId>>(() => new Set([chapters[at]!.id]));
  const [progress, setProgress] = useState<TourProgress>({ film: false, ring: false, ask: false });
  const stage = useRef<HTMLDivElement>(null);

  const chapter = chapters[Math.min(at, chapters.length - 1)]!;
  const last = at >= chapters.length - 1;

  const go = (index: number) => {
    const next = Math.max(0, Math.min(chapters.length - 1, index));
    if (next === at) return;
    setHeading(next > at ? 1 : -1);
    setAt(next);
    setSeen((before) => new Set(before).add(chapters[next]!.id));
    stage.current?.scrollTo?.({ top: 0 });
  };

  // The arrow keys turn the pages, the way the reading direction runs (not inside a field or the film).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, video, [role="radiogroup"], [role="tablist"]')) return;
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    if (event.key === forward) {
      event.preventDefault();
      go(at + 1);
    } else if (event.key === back) {
      event.preventDefault();
      go(at - 1);
    }
  };

  const NextArrow = dir === 'rtl' ? ArrowLeft : ArrowRight;
  // --heading: the side the next chapter comes in from, mirrored for right-to-left.
  const style = { '--chapter-hue': chapter.hue, '--heading': dir === 'rtl' ? -heading : heading } as CSSProperties;

  return (
    <div className="tour" style={style} onKeyDown={onKeyDown}>
      <nav className="tour-rail" aria-label={t('tour.chapters')}>
        <div className="tour-rail-brand">
          <ZoodMark size={34} loop />
          <span>{t('tour.minutes')}</span>
        </div>
        <ol className="tour-rail-list">
          {chapters.map((one, index) => (
            <li key={one.id}>
              <button
                type="button"
                className={['tour-rail-item', index === at ? 'is-current' : '', seen.has(one.id) && index !== at ? 'is-seen' : ''].filter(Boolean).join(' ')}
                aria-current={index === at ? 'step' : undefined}
                style={{ '--item-hue': one.hue } as CSSProperties}
                onClick={() => go(index)}
              >
                <span className="tour-rail-icon" aria-hidden="true">
                  {seen.has(one.id) && index !== at ? <Icon of={Check} size={13} /> : one.icon ? <Icon of={one.icon} size={14} /> : <ZoodMark size={15} />}
                </span>
                <span className="tour-rail-label">{t(one.label)}</span>
              </button>
            </li>
          ))}
        </ol>
        <p className="tour-rail-note">{t('tour.helpNote')}</p>
      </nav>

      <section className="tour-page" aria-labelledby="tour-chapter-title">
        <div className="tour-meter" role="progressbar" aria-valuemin={1} aria-valuemax={chapters.length} aria-valuenow={at + 1} aria-label={t('tour.step', { n: at + 1, total: chapters.length })}>
          <span style={{ inlineSize: `${((at + 1) / chapters.length) * 100}%` }} />
        </div>
        <div ref={stage} className="tour-scroll" aria-live="polite">
          <div key={chapter.id} className="tour-chapter">
            <ChapterHead chapter={chapter} n={at + 1} total={chapters.length} />
            <Scene chapter={chapter} progress={progress} onProgress={(patch) => setProgress((before) => ({ ...before, ...patch }))} onSettings={onSettings} onSupport={onSupport} onFolders={onFolders} />
          </div>
        </div>
        <div className="tour-actions">
          {at === 0 ? (
            <button type="button" className="icon-btn icon-btn-labeled" onClick={onClose}>
              {t('tour.skip')}
            </button>
          ) : (
            <button type="button" className="icon-btn icon-btn-labeled" onClick={() => go(at - 1)}>
              {t('tour.back')}
            </button>
          )}
          <button type="button" className="icon-btn icon-btn-labeled icon-btn-primary tour-next" onClick={last ? onClose : () => go(at + 1)}>
            <span>{last ? t('tour.done') : t('tour.next')}</span>
            {!last && <Icon of={NextArrow} size={15} />}
          </button>
        </div>
      </section>
    </div>
  );
}

function ChapterHead({ chapter, n, total }: { chapter: Chapter; n: number; total: number }) {
  const { t } = useI18n();
  return (
    <header className="tour-head">
      <p className="tour-eyebrow">{t('tour.chapterOf', { n, total })}</p>
      <h3 id="tour-chapter-title" className="tour-title">
        {t(chapter.title)}
      </h3>
      <p className="tour-body">{t(chapter.body)}</p>
    </header>
  );
}

function Scene({ chapter, progress, onProgress, onSettings, onSupport, onFolders }: { chapter: Chapter; progress: TourProgress; onProgress: (patch: Partial<TourProgress>) => void; onSettings: (section: SectionId) => void; onSupport: () => void; onFolders: () => void }) {
  switch (chapter.id) {
    case 'welcome':
      return <WelcomeScene />;
    case 'look':
      return <LookScene onSettings={onSettings} />;
    case 'film':
      return <FilmScene onWatched={() => onProgress({ film: true })} />;
    case 'basics':
      return <BasicsScene />;
    case 'folders':
      return <FoldersScene onOpen={onFolders} />;
    case 'quick':
      return <QuickScene onPractised={() => onProgress({ ring: true })} onSettings={onSettings} />;
    case 'ask':
      return <AskScene onPractised={() => onProgress({ ask: true })} onSettings={onSettings} />;
    case 'quickask':
      return <QuickAskScene onSettings={onSettings} />;
    case 'remote':
      return <RemoteScene />;
    case 'ai':
      return <AiScene />;
    case 'support':
      return <SupportScene onOpen={onSupport} />;
    case 'done':
      return <DoneScene progress={progress} />;
  }
}
