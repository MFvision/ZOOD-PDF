import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import {
  Check,
  ChevronRight,
  FileText,
  Folder,
  Languages,
  MessageCircle,
  MousePointer2,
  PenLine,
  RotateCcw,
  ShieldCheck,
  Signature,
  SquareTerminal,
  Sparkles,
  Type,
  UserX,
  Volume2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from '../components/Icon';
import { ZoodMark } from '../components/ZoodMark';
import { useReducedMotion } from '../components/useReducedMotion';
import { askAvailable } from '../ask/settings';
import { isTauriHost } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { findQuickTool, ringToolsFor } from '../quick/plan';
import type { QuickTool } from '../quick/plan';
import { RING_INNER, RING_OUTER, RING_SIZE, hitRing, outward, ringSegments, subSegments } from '../quick/ringGeometry';
import type { RingHit } from '../quick/ringGeometry';
import { useRemoteView } from '../remote/store';
import { LookPreview } from '../settings/LookPreview';
import type { SectionId } from '../settings/SettingsWindow';
import type { ChapterId } from './chapters';
import { isApplePlatform } from '../shell/menuModel';
import { useAppDispatch, useAppState } from '../state/AppContext';
import { LOOK_IDS } from '../state/preferences';
import type { ThemeMode } from '../state/preferences';
import { useSettings } from '../state/settings';
import { commandOf } from '../ai/chat/commands';
import type { Command } from '../ai/chat/commands';
import { findTool } from '../tools/tools';
import '../remote/remote.css';

/** What the person did on the way, for the last chapter's list. */
export interface TourProgress {
  film: boolean;
  ring: boolean;
  ask: boolean;
}

// The website's film (website/assets/film): WebM first, MP4 (H.264) where WebM does not play.
const FILM = {
  ar: {
    webm: new URL('../../public/film/film-ar.webm', import.meta.url).href,
    mp4: new URL('../../public/film/film-ar.mp4', import.meta.url).href,
    poster: new URL('../../public/film/film-ar.webp', import.meta.url).href,
  },
  en: {
    webm: new URL('../../public/film/film-en.webm', import.meta.url).href,
    mp4: new URL('../../public/film/film-en.mp4', import.meta.url).href,
    poster: new URL('../../public/film/film-en.webp', import.meta.url).href,
  },
};

/**
 * A scene that plays its steps in turn, `ms` apart, round and round. Picking
 * a step stops it there; Reduce Motion never starts it (the person steps
 * through by hand).
 */
export function usePhases(count: number, ms: number): { phase: number; pick: (n: number) => void; playing: boolean; replay: () => void } {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState(0);
  const [paused, setPaused] = useState(false);
  const playing = !reduced && !paused;
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setPhase((p) => (p + 1) % count), ms);
    return () => window.clearInterval(timer);
  }, [playing, count, ms]);
  return {
    phase,
    playing,
    pick: (n) => {
      setPaused(true);
      setPhase(n);
    },
    replay: () => {
      setPhase(0);
      setPaused(false);
    },
  };
}

/** The steps beside a scene: the one playing is lit, and each can be picked. */
export function Steps({ steps, phase, onPick }: { steps: { icon: LucideIcon; text: TKey }[]; phase: number; onPick: (n: number) => void }) {
  const { t } = useI18n();
  return (
    <ol className="tour-steps">
      {steps.map((step, index) => (
        <li key={step.text}>
          <button type="button" className={index === phase ? 'tour-step is-current' : 'tour-step'} aria-pressed={index === phase} onClick={() => onPick(index)}>
            <span className="tour-step-icon" aria-hidden="true">
              <Icon of={step.icon} size={15} />
            </span>
            <span>{t(step.text)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ Welcome */

export function WelcomeScene() {
  const { t, lang, setLang } = useI18n();
  const pills: { icon: LucideIcon; text: TKey }[] = [
    { icon: UserX, text: 'tour.welcome.pill1' },
    { icon: Languages, text: 'tour.welcome.pill2' },
    { icon: ShieldCheck, text: 'tour.welcome.pill3' },
  ];
  return (
    <div className="tour-scene">
      <div className="tour-stage tour-welcome-stage">
        <Glow />
        <div className="tour-welcome-mark">
          <ZoodMark size={132} loop />
        </div>
        <p className="tour-welcome-name">
          <bdi>{t('app.name')}</bdi>
        </p>
        <ul className="tour-pills">
          {pills.map((pill, index) => (
            <li key={pill.text} style={{ '--i': index } as CSSProperties}>
              <Icon of={pill.icon} size={14} />
              <span>{t(pill.text)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="tour-field">
        <p className="tour-field-label" id="tour-lang-label">
          {t('tour.welcome.lang')}
        </p>
        <div className="tour-choice tour-choice-big" role="radiogroup" aria-labelledby="tour-lang-label">
          {(['ar', 'en'] as const).map((one) => (
            <button key={one} type="button" role="radio" aria-checked={lang === one} lang={one} className="tour-choice-item" onClick={() => setLang(one)}>
              <span className="tour-choice-glyph" aria-hidden="true">
                {one === 'ar' ? 'ع' : 'A'}
              </span>
              {t(`lang.${one}`)}
              {lang === one && <Icon of={Check} size={14} className="tour-choice-tick" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Soft colour moving slowly behind a stage, in the chapter's hue and the look's accent. */
export function Glow() {
  return (
    <div className="tour-glow" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

/* --------------------------------------------------------------------- Look */

export function LookScene({ onSettings }: { onSettings: (section: SectionId) => void }) {
  const { t, dir } = useI18n();
  const { theme, look } = useAppState();
  const dispatch = useAppDispatch();
  const settings = useSettings();
  const dark = useDark(theme);
  return (
    <div className="tour-scene">
      <div className="tour-field">
        <p className="tour-field-label" id="tour-theme-label">
          {t('theme.label')}
        </p>
        <div className="tour-choice" role="radiogroup" aria-labelledby="tour-theme-label">
          {(['system', 'light', 'dark'] as ThemeMode[]).map((one) => (
            <button key={one} type="button" role="radio" aria-checked={theme === one} className="tour-choice-item" onClick={() => dispatch({ type: 'SET_THEME', theme: one })}>
              {t(`theme.${one}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="tour-field">
        <p className="tour-field-label" id="tour-look-label">
          {t('look.label')}
        </p>
        <div className="tour-looks" role="radiogroup" aria-labelledby="tour-look-label">
          {LOOK_IDS.map((one, index) => (
            <button
              key={one}
              type="button"
              role="radio"
              aria-checked={look === one}
              className={look === one ? 'tour-look is-current' : 'tour-look'}
              style={{ '--i': index } as CSSProperties}
              onClick={() => dispatch({ type: 'SET_LOOK', look: one })}
            >
              <span className="tour-look-picture">
                <LookPreview look={one} dark={dark} rtl={dir === 'rtl'} plainIcons={one === 'mono' || settings.icons === 'plain'} />
                {look === one && (
                  <span className="tour-look-check" aria-hidden="true">
                    <Icon of={Check} size={12} />
                  </span>
                )}
              </span>
              <span className="tour-look-name">{t(`look.${one}`)}</span>
            </button>
          ))}
        </div>
      </div>
      <button type="button" className="link-btn tour-link" onClick={() => onSettings('appearance')}>
        {t('tour.looksSettings')}
      </button>
    </div>
  );
}

/** Whether the pictures show dark: the appearance chosen, or the system's. */
function useDark(theme: ThemeMode): boolean {
  const [systemDark, setSystemDark] = useState(() => globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  useEffect(() => {
    const query = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) return;
    const onChange = () => setSystemDark(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return theme === 'dark' || (theme === 'system' && systemDark);
}

/* --------------------------------------------------------------------- Film */

export function FilmScene({ onWatched }: { onWatched: () => void }) {
  const { t, lang } = useI18n();
  const [failed, setFailed] = useState(false);
  const film = FILM[lang === 'ar' ? 'ar' : 'en'];
  return (
    <div className="tour-scene">
      <div className="tour-film">
        {failed ? (
          <div className="tour-film-failed">
            <img src={film.poster} alt="" />
            <p>{t('tour.film.failed')}</p>
          </div>
        ) : (
          <video key={film.mp4} poster={film.poster} controls playsInline preload="metadata" aria-label={t('tour.film.label')} onPlay={onWatched}>
            <source src={film.webm} type="video/webm" />
            {/* The last source failing means none played. */}
            <source src={film.mp4} type="video/mp4" onError={() => setFailed(true)} />
          </video>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- Basics */

const BASICS: { icon: LucideIcon; text: TKey }[] = [
  { icon: FileText, text: 'tour.basics.s1' },
  { icon: PenLine, text: 'tour.basics.s2' },
  { icon: Type, text: 'tour.basics.s3' },
  { icon: Folder, text: 'tour.basics.s4' },
  { icon: Check, text: 'tour.basics.s5' },
];

export function BasicsScene() {
  const { t } = useI18n();
  const { phase, pick, playing, replay } = usePhases(BASICS.length, 2600);
  return (
    <div className="tour-scene tour-split">
      <div>
        <Steps steps={BASICS} phase={phase} onPick={pick} />
        {!playing && <Replay onClick={replay} />}
      </div>
      <div className="tour-stage">
        <Glow />
        <div className="mock" data-phase={phase} aria-hidden="true">
          <div className="mock-bar">
            <span className="mock-dots">
              <i />
              <i />
              <i />
            </span>
            <span className="mock-tab is-on">{t('tour.mock.file')}</span>
            <span className="mock-tab mock-tab-new">{t('tour.mock.file2')}</span>
          </div>
          <div className="mock-body">
            <div className="mock-page">
              <span className="mock-line mock-line-title" />
              <span className="mock-line" />
              <span className="mock-line mock-line-short" />
              <span className="mock-line mock-line-edit">
                <span>{t('tour.mock.newText')}</span>
              </span>
              <span className="mock-line" />
              <span className="mock-line mock-line-short" />
              <span className="mock-sig">
                <Icon of={Signature} size={22} />
              </span>
            </div>
            <div className="mock-panel">
              <p>{t('tour.mock.tools')}</p>
              {(
                [
                  [Type, 'tour.mock.edit'],
                  [Signature, 'tour.mock.sign'],
                  [Folder, 'tour.mock.organize'],
                  [FileText, 'tour.mock.convert'],
                ] as const
              ).map(([icon, label], index) => (
                <span key={label} className={index === 0 ? 'mock-tool is-hot' : 'mock-tool'}>
                  <Icon of={icon} size={12} />
                  {t(label)}
                </span>
              ))}
            </div>
          </div>
          <span className="mock-file">
            <Icon of={FileText} size={18} />
            {t('tour.mock.file')}
          </span>
          <span className="mock-thumb" />
          <span className="mock-toast">
            <Icon of={Check} size={13} />
            {t('tour.mock.saved')}
          </span>
          <span className="mock-cursor">
            <Icon of={MousePointer2} size={18} />
          </span>
        </div>
      </div>
    </div>
  );
}

export function Replay({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button type="button" className="link-btn tour-link tour-replay" onClick={onClick}>
      <Icon of={RotateCcw} size={13} />
      {t('tour.replay')}
    </button>
  );
}

/* -------------------------------------------------------------- Quick tools */

const SHORT_KEY = (id: string) => `quick.short.${id}` as TKey;
/** The ring as a PDF has it out of the box, Convert's half circle and all. */
const RING_TOOLS = ringToolsFor(['a.pdf'], []);
/** The right-click menu's first tools, as the file manager shows them. */
const MENU_TOOLS = ['compress', 'word', 'ocr', 'split', 'rotate'].map((id) => findQuickTool(id)).filter((tool): tool is QuickTool => tool !== undefined);
const RESULT_EXTENSION: Record<string, string> = { word: 'docx', excel: 'xlsx', powerpoint: 'pptx', text: 'txt', images: 'zip', jpg: 'zip', webp: 'zip' };
/** How big the practice ring is drawn, in CSS pixels: the ring itself, its half circle drawn beyond. */
const PRACTICE_SIDE = 248;
/** The ring's own part of its drawing (the window round it holds the half circle). */
const RING_VIEW = 300;
const POP = 7;
const PRACTICE_RUN_MS = 1400;

export function QuickScene({ onPractised, onSettings }: { onPractised: () => void; onSettings: (section: SectionId) => void }) {
  const { t } = useI18n();
  const [part, setPart] = useState<'menu' | 'ring'>('menu');
  return (
    <div className="tour-scene">
      <div className="tour-choice" role="tablist" aria-label={t('tour.ch.quick')}>
        {(['menu', 'ring'] as const).map((one) => (
          <button key={one} type="button" role="tab" aria-selected={part === one} className="tour-choice-item" onClick={() => setPart(one)}>
            {t(one === 'menu' ? 'tour.quick.tabMenu' : 'tour.quick.tabRing')}
          </button>
        ))}
      </div>
      <div key={part} className="tour-part">
        {part === 'menu' ? <RightClickDemo /> : <RingPractice onPractised={onPractised} />}
      </div>
      <button type="button" className="link-btn tour-link" onClick={() => onSettings('quick')}>
        {t('tour.quickSettings')}
      </button>
    </div>
  );
}

function RightClickDemo() {
  const { t } = useI18n();
  const mac = isApplePlatform();
  const { phase, pick, playing, replay } = usePhases(4, 1700);
  return (
    <div className="tour-split">
      <div>
        <p className="tour-note">{t(mac ? 'tour.quick.p1Mac' : 'tour.quick.p1Windows')}</p>
        <div className="tour-scrub" role="group" aria-label={t('tour.quick.tabMenu')}>
          {[0, 1, 2, 3].map((n) => (
            <button key={n} type="button" aria-label={t('tour.step', { n: n + 1, total: 4 })} aria-pressed={phase === n} className={phase === n ? 'is-current' : undefined} onClick={() => pick(n)} />
          ))}
        </div>
        {!playing && <Replay onClick={replay} />}
      </div>
      <div className="tour-stage">
        <Glow />
        <div className="files-mock" data-phase={phase} aria-hidden="true">
          <div className="files-head">
            <Icon of={Folder} size={14} />
            <span>{mac ? 'Finder' : 'File Explorer'}</span>
          </div>
          {(['tour.mock.file', 'tour.mock.file2', 'tour.mock.file3'] as const).map((name, index) => (
            <span key={name} className={index === 0 ? 'files-row is-picked' : 'files-row'}>
              <Icon of={FileText} size={14} />
              {t(name)}
            </span>
          ))}
          <span className="files-row files-row-new">
            <Icon of={FileText} size={14} />
            {`${t('tour.mock.file').replace(/\.pdf$/, '')} (${t('quick.short.compress')}).pdf`}
          </span>
          <div className="files-menu">
            <span>{t('tour.quick.menuOpen')}</span>
            <span>{t('tour.quick.menuCopy')}</span>
            <span>{t('tour.quick.menuRename')}</span>
            <hr />
            <span className="files-menu-zood">
              <ZoodMark size={14} />
              {t(mac ? 'tour.quick.menuItem' : 'tour.quick.menuItemWindows')}
              <Icon of={ChevronRight} size={12} mirror />
            </span>
          </div>
          <div className="files-sub">
            {MENU_TOOLS.map((tool, index) => (
              <span key={tool.id} className={index === 0 ? 'is-hot' : undefined}>
                <Icon of={tool.icon} size={12} />
                {t(tool.labelKey)}
              </span>
            ))}
          </div>
          <span className="files-toast">
            <Icon of={Check} size={13} />
            {t('tour.quick.savedBeside')}
          </span>
          <span className="mock-cursor">
            <Icon of={MousePointer2} size={18} />
          </span>
        </div>
      </div>
    </div>
  );
}

interface Practice {
  /** The ring's centre in the box. */
  cx: number;
  cy: number;
  /** The dragged file's name and where the pointer is, or null once let go in the hub (the ring waits for a click). */
  file: string;
  at: { x: number; y: number } | null;
}

function RingPractice({ onPractised }: { onPractised: () => void }) {
  const { t } = useI18n();
  const mac = isApplePlatform();
  const box = useRef<HTMLDivElement>(null);
  const [files, setFiles] = useState<string[]>(() => [t('tour.mock.file'), t('tour.mock.file2')]);
  const [made, setMade] = useState<string | null>(null);
  const [ring, setRing] = useState<Practice | null>(null);
  const [over, setOver] = useState<number | null>(null);
  // Convert's half circle, open behind its segment, and the format under the pointer.
  const [open, setOpen] = useState<number | null>(null);
  const [sub, setSub] = useState<number | null>(null);
  const [work, setWork] = useState<{ tool: string; progress: number; done: boolean } | null>(null);
  const [nudge, setNudge] = useState(0);
  const segments = ringSegments(RING_TOOLS.length);
  const scale = PRACTICE_SIDE / RING_VIEW;
  const half = PRACTICE_SIDE / 2;
  const openGroup = open !== null ? RING_TOOLS[open] : undefined;
  const halves = open !== null && openGroup?.members ? subSegments(open, RING_TOOLS.length, openGroup.members.length) : [];

  const place = (event: { clientX: number; clientY: number }) => {
    const rect = box.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, w: rect.width, h: rect.height };
  };
  const hitFor = (practice: Practice, x: number, y: number): RingHit => {
    const members = open !== null ? (RING_TOOLS[open]?.members?.length ?? 0) : 0;
    return hitRing((x - practice.cx) / scale + RING_SIZE / 2, (y - practice.cy) / scale + RING_SIZE / 2, RING_TOOLS.length, open !== null && members > 0 ? { index: open, members } : null);
  };
  const track = (hit: RingHit) => {
    if (hit?.kind === 'sub') {
      setSub(hit.index);
      return setOver(open);
    }
    setSub(null);
    if (hit?.kind === 'segment') {
      setOver(hit.index);
      return setOpen(RING_TOOLS[hit.index]?.members ? hit.index : null);
    }
    setOver(null);
    if (hit?.kind === 'hub') setOpen(null);
  };

  const onDown = (file: string) => (event: ReactPointerEvent<HTMLElement>) => {
    if (work) return;
    if (!(event.ctrlKey || event.shiftKey || event.altKey || event.metaKey)) {
      setNudge((n) => n + 1);
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const { x, y, w, h } = place(event);
    const cx = Math.max(half + 4, Math.min(w - half - 4, x));
    const cy = Math.max(half + 4, Math.min(h - half - 4, y));
    setMade(null);
    setOpen(null);
    setSub(null);
    setRing({ cx, cy, file, at: { x, y } });
  };
  const onMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!ring?.at) return;
    const { x, y } = place(event);
    setRing({ ...ring, at: { x, y } });
    track(hitFor(ring, x, y));
  };
  const onUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (!ring?.at) return;
    const { x, y } = place(event);
    const hit = hitFor(ring, x, y);
    setOver(null);
    setSub(null);
    if (hit?.kind === 'sub') {
      const member = openGroup?.members?.[hit.index];
      if (member) return run(member.id, ring.file);
    }
    if (hit?.kind === 'segment') {
      const item = RING_TOOLS[hit.index]!;
      if (!item.members) return run(item.id, ring.file);
      // Let go on Convert: its half circle stays open for a click.
      setOpen(hit.index);
      return setRing({ ...ring, at: null });
    }
    setOpen(null);
    if (hit?.kind === 'hub') return setRing({ ...ring, at: null });
    setRing(null);
  };

  const run = (tool: string, file: string) => {
    setOpen(null);
    setSub(null);
    setRing((current) => (current ? { ...current, at: null } : current));
    setWork({ tool, progress: 0, done: false });
    let started: number | null = null;
    const step = (now: number) => {
      started ??= now;
      const progress = Math.min(1, (now - started) / PRACTICE_RUN_MS);
      setWork({ tool, progress, done: progress >= 1 });
      if (progress < 1) return void requestAnimationFrame(step);
      const name = `${file.replace(/\.pdf$/, '')} (${t(SHORT_KEY(tool))}).${RESULT_EXTENSION[tool] ?? 'pdf'}`;
      window.setTimeout(() => {
        setWork(null);
        setRing(null);
        setMade(name);
        setFiles((before) => (before.includes(name) ? before : [...before, name]));
        onPractised();
      }, 700);
    };
    requestAnimationFrame(step);
  };

  // Keyboard and touch: the ring at the middle, waiting for a click on a tool.
  const openForClick = () => {
    const rect = box.current!.getBoundingClientRect();
    setMade(null);
    setRing({ cx: rect.width / 2, cy: rect.height / 2, file: files[0]!, at: null });
  };

  const band = (RING_INNER + RING_OUTER) / 2;
  const circumference = 2 * Math.PI * band;
  const center = RING_SIZE / 2;
  const overFormat = sub !== null ? openGroup?.members?.[sub] : undefined;
  const hub = work
    ? work.done
      ? '✓'
      : `${Math.round(work.progress * 100)}%`
    : overFormat && openGroup
      ? t('quick.ring.dropIn', { group: t(SHORT_KEY(openGroup.id)), format: overFormat.makes ?? t(SHORT_KEY(overFormat.id)) })
      : over !== null
        ? RING_TOOLS[over]!.members
          ? t('quick.ring.outward')
          : t(SHORT_KEY(RING_TOOLS[over]!.id))
        : t('tour.quick.ringHub');

  return (
    <div className="ring-practice">
      <p className="tour-note">
        <strong>{t(mac ? 'tour.quick.ringHowMac' : 'tour.quick.ringHowWindows')}</strong> {t(mac ? 'tour.quick.ringShortcutMac' : 'tour.quick.ringShortcutWindows')}
      </p>
      <div ref={box} className="practice-box">
        <Glow />
        <span className="practice-label">{t('tour.quick.ringPractice')}</span>
        <ul className="practice-files">
          {files.map((file) => (
            <li key={file}>
              <span
                role="img"
                aria-label={file}
                className={[file === made ? 'practice-file is-new' : 'practice-file', ring?.at && ring.file === file ? 'is-lifted' : ''].filter(Boolean).join(' ')}
                onPointerDown={onDown(file)}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={() => setRing(null)}
              >
                <Icon of={FileText} size={26} />
                <span>{file}</span>
              </span>
            </li>
          ))}
        </ul>
        {nudge > 0 && !ring && (
          <p key={nudge} className="practice-nudge" role="status">
            {t(mac ? 'tour.quick.ringHoldMac' : 'tour.quick.ringHoldWindows')}
          </p>
        )}
        {made && !ring && (
          <p className="practice-done" role="status">
            <Icon of={Check} size={14} />
            {t('tour.quick.ringDone', { name: made })}
          </p>
        )}
        {ring && (
          <svg
            className={work ? 'practice-ring is-working' : 'practice-ring'}
            viewBox={`${center - RING_VIEW / 2} ${center - RING_VIEW / 2} ${RING_VIEW} ${RING_VIEW}`}
            width={PRACTICE_SIDE}
            height={PRACTICE_SIDE}
            style={{ left: ring.cx - half, top: ring.cy - half }}
            role="group"
            aria-label={t('quick.title')}
          >
            <circle cx={center} cy={center} r={RING_OUTER + 4} className="practice-ring-shadow" />
            {openGroup?.members &&
              halves.map((halfCircle, k) => {
                const member = openGroup.members![k]!;
                const pick = () => run(member.id, ring.file);
                return (
                  <g
                    key={member.id}
                    className={k === sub ? 'practice-sub is-over' : 'practice-sub'}
                    role={!ring.at && !work ? 'button' : undefined}
                    tabIndex={!ring.at && !work ? 0 : undefined}
                    aria-label={t(member.labelKey)}
                    onPointerEnter={!ring.at ? () => setSub(k) : undefined}
                    onPointerLeave={!ring.at ? () => setSub(null) : undefined}
                    onClick={!ring.at && !work ? pick : undefined}
                    onKeyDown={(event) => {
                      if (!ring.at && !work && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault();
                        pick();
                      }
                    }}
                    style={{ '--i': k, transformOrigin: `${center}px ${center}px` } as CSSProperties}
                  >
                    <path d={halfCircle.path} />
                    <text x={halfCircle.label.x} y={halfCircle.label.y + 4} textAnchor="middle">
                      {member.makes ?? t(SHORT_KEY(member.id))}
                    </text>
                  </g>
                );
              })}
            {segments.map((segment, index) => {
              const tool = RING_TOOLS[index]!;
              const ToolIcon = tool.icon;
              const popped = index === open;
              const shift = popped ? outward(index, RING_TOOLS.length, POP) : null;
              const choose = () => (tool.members ? setOpen(index) : run(tool.id, ring.file));
              return (
                <g
                  key={tool.id}
                  className={index === over || popped ? 'practice-segment is-over' : 'practice-segment'}
                  role={!ring.at && !work ? 'button' : undefined}
                  tabIndex={!ring.at && !work ? 0 : undefined}
                  aria-label={t(SHORT_KEY(tool.id))}
                  aria-expanded={tool.members && !ring.at ? popped : undefined}
                  onPointerEnter={
                    !ring.at
                      ? () => {
                          setOver(index);
                          setSub(null);
                          setOpen(tool.members ? index : null);
                        }
                      : undefined
                  }
                  onPointerLeave={!ring.at ? () => setOver(null) : undefined}
                  onClick={!ring.at && !work ? choose : undefined}
                  onKeyDown={(event) => {
                    if (!ring.at && !work && (event.key === 'Enter' || event.key === ' ')) {
                      event.preventDefault();
                      choose();
                    }
                  }}
                  style={{ '--i': index, ...(shift ? { transform: `translate(${shift.x}px, ${shift.y}px)` } : {}) } as CSSProperties}
                >
                  <path d={segment.path} />
                  <ToolIcon x={segment.label.x - 11} y={segment.label.y - 20} width={22} height={22} aria-hidden="true" />
                  <text x={segment.label.x} y={segment.label.y + 16} textAnchor="middle">
                    {t(SHORT_KEY(tool.id))}
                  </text>
                </g>
              );
            })}
            {work && (
              <g className={work.done ? 'practice-progress is-done' : 'practice-progress'}>
                <circle cx={center} cy={center} r={band} className="practice-track" />
                <circle cx={center} cy={center} r={band} className="practice-bar" strokeDasharray={`${circumference * work.progress} ${circumference}`} transform={`rotate(-90 ${center} ${center})`} />
              </g>
            )}
            <circle cx={center} cy={center} r={RING_INNER - 4} className="practice-hub" />
            <text x={center} y={center + 5} textAnchor="middle" className="practice-hub-text">
              {hub}
            </text>
          </svg>
        )}
        {ring?.at && (
          <span className="practice-ghost" style={{ left: ring.at.x, top: ring.at.y }} aria-hidden="true">
            <Icon of={FileText} size={20} />
          </span>
        )}
      </div>
      {!ring && (
        <button type="button" className="link-btn tour-link" onClick={openForClick}>
          {t('tour.quick.ringClick')}
        </button>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------- AI */

/** What a command typed into the AI chat does, said in the tour's practice. */
function commandWords(command: Command, t: ReturnType<typeof useI18n>['t']): string {
  switch (command.kind) {
    case 'tool':
      return t('tour.ai.does.tool', { name: t(findTool(command.tool)?.labelKey ?? 'tool.ai') });
    case 'openFile':
      return t('tour.ai.does.openFile');
    case 'home':
      return t('tour.ai.does.home');
    case 'settings':
      return t('tour.ai.does.settings');
    case 'tour':
      return t('tour.ai.does.tour');
    case 'shortcuts':
      return t('tour.ai.does.shortcuts');
    case 'theme':
      return t(command.theme === 'dark' ? 'tour.ai.does.dark' : 'tour.ai.does.light');
    case 'page':
      return t('tour.ai.does.page', { page: command.page });
    case 'find':
      return t('tour.ai.does.find', { query: command.query });
    case 'zoom':
      return t(command.direction === 'in' ? 'tour.ai.does.zoomIn' : 'tour.ai.does.zoomOut');
  }
}

/**
 * The AI chapter, in two parts: the chat about anything with the commands
 * it does in the app (first), and
 * the chat about a document with read aloud.
 */
export function AiScene() {
  const { t } = useI18n();
  const [part, setPart] = useState<'chat' | 'document'>('chat');
  return (
    <div className="tour-scene">
      <div className="tour-choice" role="tablist" aria-label={t('tour.ch.ai')}>
        {(['chat', 'document'] as const).map((one) => (
          <button key={one} type="button" role="tab" aria-selected={part === one} className="tour-choice-item" onClick={() => setPart(one)}>
            {t(one === 'chat' ? 'tour.ai.tabChat' : 'tour.ai.tabDocument')}
          </button>
        ))}
      </div>
      <div key={part} className="tour-part">
        {part === 'chat' ? <AiChatPart /> : <AiDocumentPart />}
      </div>
    </div>
  );
}

function AiChatPart() {
  const { t } = useI18n();
  const { phase, pick, playing, replay } = usePhases(4, 2000);
  const [tried, setTried] = useState('');
  const [said, setSaid] = useState<{ command: boolean; text: string } | null>(null);
  const steps: { icon: LucideIcon; text: TKey }[] = [
    { icon: MessageCircle, text: 'tour.ai.p3' },
    { icon: SquareTerminal, text: 'tour.ai.p4' },
  ];
  const words = t('tour.ai.chatAnswer').split(' ');
  const tryIt = () => {
    const text = tried.trim();
    if (!text) return;
    // Only said here, not done: the practice changes nothing in the app.
    const command = commandOf(text);
    setSaid(command ? { command: true, text: commandWords(command, t) } : { command: false, text: t('tour.ai.notCommand') });
  };
  return (
    <div className="tour-split">
      <div>
        <Steps steps={steps} phase={phase >= 3 ? 1 : 0} onPick={(n) => pick(n === 0 ? 2 : 3)} />
        {!playing && <Replay onClick={replay} />}
        <form
          className="tour-try"
          onSubmit={(event) => {
            event.preventDefault();
            tryIt();
          }}
        >
          <label className="tour-try-label" htmlFor="tour-ai-try">
            {t('tour.ai.tryLabel')}
          </label>
          <div className="tour-try-row">
            <input
              id="tour-ai-try"
              className="text-input"
              dir="auto"
              maxLength={60}
              placeholder={t('tour.ai.tryPlaceholder')}
              value={tried}
              onChange={(event) => {
                setTried(event.target.value);
                setSaid(null);
              }}
            />
            <button type="submit" className="icon-btn icon-btn-labeled icon-btn-primary" disabled={tried.trim().length === 0}>
              {t('tour.ai.tryGo')}
            </button>
          </div>
          {said && (
            <p className={said.command ? 'tour-try-said is-command' : 'tour-try-said'} role="status">
              {said.command && <Icon of={Check} size={13} />}
              <span>{said.text}</span>
            </p>
          )}
        </form>
      </div>
      <div className="tour-stage">
        <Glow />
        <div className="chat-mock" data-phase={phase} aria-hidden="true">
          <span className="chat-q">{t('tour.ai.chatQuestion')}</span>
          <span className="chat-typing">
            <i />
            <i />
            <i />
          </span>
          <span className="chat-a">
            <span className="chat-a-head">
              <Icon of={Sparkles} size={13} />
              {t('app.name')}
            </span>
            <span className="chat-a-text">
              {words.map((word, index) => (
                <span key={index} style={{ '--w': index } as CSSProperties}>
                  {word}{' '}
                </span>
              ))}
            </span>
          </span>
          <span className="chat-speaker">
            <Icon of={Check} size={15} />
            {t('tour.ai.chatCommand')}
          </span>
        </div>
      </div>
    </div>
  );
}

function AiDocumentPart() {
  const { t } = useI18n();
  const { phase, pick, playing, replay } = usePhases(4, 2000);
  const steps: { icon: LucideIcon; text: TKey }[] = [
    { icon: Sparkles, text: 'tour.ai.p1' },
    { icon: Volume2, text: 'tour.ai.p2' },
  ];
  const words = t('tour.ai.answer').split(' ');
  return (
    <div className="tour-split">
      <div>
        <Steps steps={steps} phase={phase >= 3 ? 1 : 0} onPick={(n) => pick(n === 0 ? 2 : 3)} />
        {!playing && <Replay onClick={replay} />}
      </div>
      <div className="tour-stage">
        <Glow />
        <div className="chat-mock" data-phase={phase} aria-hidden="true">
          <span className="chat-q">{t('tour.ai.question')}</span>
          <span className="chat-typing">
            <i />
            <i />
            <i />
          </span>
          <span className="chat-a">
            <span className="chat-a-head">
              <Icon of={Sparkles} size={13} />
              {t('app.name')}
            </span>
            <span className="chat-a-text">
              {words.map((word, index) => (
                <span key={index} style={{ '--w': index } as CSSProperties}>
                  {word}{' '}
                </span>
              ))}
            </span>
            <span className="chat-source">{t('tour.ai.source')}</span>
          </span>
          <span className="chat-speaker">
            <Icon of={Volume2} size={15} />
            {t('tour.ai.reading')}
            <span className="chat-bars">
              <i />
              <i />
              <i />
              <i />
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- Done */

/** The tour's last page: what was set and tried; a "Not yet" goes back to its chapter. */
export function DoneScene({ progress, onChapter }: { progress: TourProgress; onChapter: (id: ChapterId) => void }) {
  const { t, lang } = useI18n();
  const { look } = useAppState();
  const { status } = useRemoteView();
  const [desktop] = useState(isTauriHost);
  const phone = (status?.phones.length ?? 0) > 0 || (status?.remembered.length ?? 0) > 0;
  const rows: { text: string; done: boolean; chapter?: ChapterId }[] = [
    { text: t('tour.done.lang', { value: t(`lang.${lang}`) }), done: true },
    { text: t('tour.done.look', { value: t(`look.${look}`) }), done: true },
    { text: t('tour.done.film'), done: progress.film, chapter: 'film' },
    ...(desktop
      ? [
          { text: t('tour.done.ring'), done: progress.ring, chapter: 'quick' as const },
          ...(askAvailable() ? [{ text: t('tour.done.ask'), done: progress.ask, chapter: 'ask' as const }] : []),
          { text: t('tour.done.phone'), done: phone, chapter: 'remote' as const },
        ]
      : []),
  ];
  return (
    <div className="tour-scene">
      <div className="tour-stage tour-welcome-stage tour-done-stage">
        <Glow />
        <span className="tour-done-mark" aria-hidden="true">
          <ZoodMark size={56} loop />
        </span>
        <span className="tour-burst" aria-hidden="true">
          {Array.from({ length: 12 }, (_, index) => (
            <i key={index} style={{ '--a': `${index * 30}deg` } as CSSProperties} />
          ))}
        </span>
        <svg className="tour-done-tick" viewBox="0 0 64 64" width="84" height="84" aria-hidden="true">
          <circle cx="32" cy="32" r="29" />
          <path d="M19 33 l9 9 l17 -19" />
        </svg>
      </div>
      <ul className="tour-summary">
        {rows.map((row, index) => (
          <li key={row.text} className={row.done ? 'is-done' : undefined} style={{ '--i': index } as CSSProperties}>
            <span className="tour-summary-mark" aria-hidden="true">
              {row.done ? <Icon of={Check} size={13} /> : null}
            </span>
            <span>{row.text}</span>
            {!row.done &&
              (row.chapter ? (
                <button type="button" className="tour-summary-later tour-summary-go" onClick={() => onChapter(row.chapter!)}>
                  {t('tour.done.notYet')}
                </button>
              ) : (
                <span className="tour-summary-later">{t('tour.done.notYet')}</span>
              ))}
          </li>
        ))}
      </ul>
      <p className="tour-note">{t('tour.helpNote')}</p>
    </div>
  );
}
