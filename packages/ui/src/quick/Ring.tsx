import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Smartphone, Sparkles } from 'lucide-react';
import '../styles/tokens.css';
import '../styles/looks.css';
import '../styles/looks/premium.css';
import '../styles/appearance.css';
import '../styles/fonts.css';
import './ring.css';
import { getSharedCoreClient } from '../core/client';
import { RING_DROP_EVENT, RING_FILES_EVENT, RING_HOLD_EVENT, RING_OVER_EVENT, RING_SHOW_EVENT, onHostEvent, ringDone, ringPhone, ringPick, ringTake } from '../core/host-tauri';
import { I18nProvider } from '../i18n/I18nProvider';
import { useI18n } from '../i18n/useT';
import type { TKey, TParams } from '../i18n/messages';
import type { FileState } from '../batch/run';
import { useSettings } from '../state/settings';
import { defaultLook, readPreferences } from '../state/preferences';
import { applyAppearance } from '../settings/SettingsEffects';
import { ALL_TOOLS_ICON, findQuickTool, ringToolsFor, startingOptions } from './plan';
import type { RingItem } from './plan';
import { runQuick, wantsPassword } from './runQuick';
import { RING_INNER, RING_OUTER, RING_SIZE, hitRing, outward, ringSegments, subSegments, toRing } from './ringGeometry';
import type { RingHit } from './ringGeometry';

/**
 * The ring (`src-tauri/src/ring.rs`): a transparent window the host shows at
 * the pointer when files are dragged out of File Explorer or Finder with
 * Ctrl or Shift (Option or Command) held. It stays invisible until files
 * are over it; its tools fit those files. Letting go on a tool that needs
 * nothing more runs it there and then, its progress going round the ring
 * (results beside the originals); a tool that needs a password, pages or a
 * size opens its quick window. Letting go in the middle keeps the ring, to
 * click a tool; anywhere off the ring cancels. A group (Convert) opens a
 * half circle of its formats behind it when the pointer reaches it, and the
 * pointer moves on outward to one; the hub always says what letting go will
 * do. Ctrl+Alt+Z (Command+Option+Z) opens it at the pointer on the files
 * selected in the file manager, the same way.
 */

const SHORT: Record<string, TKey> = {
  compress: 'quick.short.compress',
  word: 'quick.short.word',
  images: 'quick.short.images',
  jpg: 'quick.short.jpg',
  webp: 'quick.short.webp',
  ocr: 'quick.short.ocr',
  combine: 'quick.short.combine',
  rotate: 'quick.short.rotate',
  extract: 'quick.short.extract',
  protect: 'quick.short.protect',
  topdf: 'quick.short.topdf',
  excel: 'quick.short.excel',
  powerpoint: 'quick.short.powerpoint',
  text: 'quick.short.text',
  split: 'quick.short.split',
  resize: 'quick.short.resize',
  numbers: 'quick.short.numbers',
  watermark: 'quick.short.watermark',
  sign: 'quick.short.sign',
  unlock: 'quick.short.unlock',
  phone: 'quick.short.phone',
  sort: 'quick.short.sort',
  convert: 'quick.short.convert',
  all: 'quick.short.all',
};

/** How long the tick (or the cross) stays before the ring goes. */
const DONE_SHOWN_MS = 1200;
const FAILED_SHOWN_MS = 2600;

/** How far a group's segment moves out while its half circle is open. */
const POP = 7;

/** A tool running on the ring: how far it has got, and how it ended. */
interface Work {
  tool: string;
  progress: number;
  end: 'done' | 'failed' | null;
}

/** How far the files have got, from 0 to 1: a file part-way through a long step counts its part. */
function progressOf(states: ReadonlyMap<number, FileState>, total: number): number {
  let sum = 0;
  for (const state of states.values()) {
    if (state.state === 'done' || state.state === 'failed' || state.state === 'cancelled') sum += 1;
    else if (state.state === 'working' && state.detail?.params) {
      const { page, of, part } = state.detail.params as { page?: number; of?: number; part?: number };
      const at = page ?? part ?? 0;
      if (of) sum += Math.min(0.95, at / of);
    }
  }
  return total > 0 ? Math.min(1, sum / total) : 0;
}

/** What the hub calls the files: "1 × PDF", "3 × PDF", or "4 files" when their kinds differ. */
export function filesLabel(names: readonly string[], t: (key: TKey, params?: TParams) => string): string {
  const types = new Set(names.map((name) => (name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.') + 1).toUpperCase() : '')));
  const [type] = [...types];
  return types.size === 1 && type ? t('quick.ring.count', { n: names.length, type }) : t('quick.ring.files', { n: names.length });
}

/** Before the host has said what the files are: a PDF's tools. */
const DEFAULT_NAMES = ['file.pdf'];

/** How long a ring holding files waits for a click before it closes. */
const CLICK_WAIT_MS = 30_000;

function RingWindow() {
  const { t, lang } = useI18n();
  const [work, setWork] = useState<Work | null>(null);
  const stopper = useRef<AbortController | null>(null);
  const client = useMemo(() => getSharedCoreClient(), []);
  const [names, setNames] = useState<string[]>(DEFAULT_NAMES);
  // Invisible until files are dragged over it: a drag of anything else
  // (text, a rubber-band selection) shows nothing.
  const [visible, setVisible] = useState(false);
  // Files were let go in the hub: the ring stays, and a click picks the tool.
  const [holding, setHolding] = useState(false);
  const [over, setOver] = useState<number | null>(null);
  // The group whose half circle is open (its segment), and the format under the pointer in it.
  const [open, setOpen] = useState<number | null>(null);
  const [sub, setSub] = useState<number | null>(null);
  // A phone connected to the remote: the files can go to it ("To phone").
  const [phone, setPhone] = useState(false);
  const itemsRef = useRef<RingItem[]>([]);
  const openRef = useRef<number | null>(null);

  const settings = useSettings();
  const tools = useMemo((): RingItem[] => {
    const fitting = ringToolsFor(names, settings.ringTools);
    // Two files or more: Sort, where ZOOD suggests merging, splitting, folders and names (`sort/`).
    const sort = names.length >= 2 ? [{ id: 'sort', icon: Sparkles }] : [];
    return [...fitting, ...sort, ...(phone ? [{ id: 'phone', icon: Smartphone }] : []), { id: 'all', icon: ALL_TOOLS_ICON }];
  }, [names, settings.ringTools, phone]);

  // The look, light or dark, and the icons the main window has chosen.
  useEffect(() => {
    const apply = () => {
      const root = document.documentElement;
      const { theme, look } = readPreferences();
      if (theme && theme !== 'system') root.dataset.theme = theme;
      else delete root.dataset.theme;
      const shown = look ?? defaultLook();
      if (shown !== 'glass') root.dataset.look = shown;
      else delete root.dataset.look;
      applyAppearance(root, settings);
    };
    apply();
    window.addEventListener('storage', apply);
    return () => window.removeEventListener('storage', apply);
  }, [settings]);
  const segments = useMemo(() => ringSegments(tools.length), [tools.length]);
  useEffect(() => {
    itemsRef.current = tools;
  }, [tools]);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  const openGroup = open !== null ? tools[open] : undefined;
  const halves = useMemo(
    () => (open !== null && openGroup?.members ? subSegments(open, tools.length, openGroup.members.length) : []),
    [open, openGroup, tools.length],
  );

  // A tool picked: one that needs nothing more runs here; the rest open their window.
  const pickTool = (id: string) => {
    const tool = findQuickTool(id);
    if (!tool || tool.mode !== 'instant') return void ringPick(id);
    setHolding(false);
    setOver(null);
    setOpen(null);
    setSub(null);
    setWork({ tool: id, progress: 0, end: null });
    void (async () => {
      const files = await ringTake();
      if (files.length === 0) return void ringPick('none');
      const controller = new AbortController();
      stopper.current = controller;
      const states = new Map<number, FileState>();
      void client.init();
      try {
        await runQuick({
          tool,
          files,
          options: startingOptions(tool),
          client,
          lang,
          t,
          signal: controller.signal,
          onState: (key, state) => {
            states.set(key, state);
            setWork((current) => (current ? { ...current, progress: progressOf(states, files.length) } : current));
          },
          onOutput: () => undefined,
        });
      } catch {
        files.forEach((_, key) => states.has(key) || states.set(key, { state: 'failed', step: null, key: 'batch.error.failed' }));
      } finally {
        stopper.current = null;
      }
      const all = [...states.values()];
      const locked = files.filter((_, key) => wantsPassword(states.get(key)));
      // Protected files: their tool's window, to ask for the password.
      if (locked.length > 0) return void ringPick(tool.id, locked.map((file) => file.path));
      const failed = all.filter((state) => state.state === 'failed').length;
      const done = all.filter((state) => state.state === 'done').length;
      setWork({ tool: id, progress: 1, end: failed > 0 || done === 0 ? 'failed' : 'done' });
      window.setTimeout(() => {
        setWork(null);
        void ringDone(done, failed);
      }, failed > 0 || done === 0 ? FAILED_SHOWN_MS : DONE_SHOWN_MS);
    })();
  };

  /** What is under a point of the ring's drawing, the open group's half circle included. */
  const hitAt = (point: { x: number; y: number }): RingHit => {
    const items = itemsRef.current;
    const at = openRef.current;
    const members = at !== null ? (items[at]?.members?.length ?? 0) : 0;
    return hitRing(point.x, point.y, items.length, at !== null && members > 0 ? { index: at, members } : null);
  };

  /** The pointer over the ring: a segment lights; a group's opens its half circle; a format in it lights. */
  const track = useEffectEvent((hit: RingHit) => {
    if (hit?.kind === 'sub') {
      setSub(hit.index);
      return setOver(openRef.current);
    }
    setSub(null);
    if (hit?.kind === 'segment') {
      setOver(hit.index);
      return setOpen(itemsRef.current[hit.index]?.members ? hit.index : null);
    }
    setOver(null);
    // In the hub the half circle closes, back to the whole ring; off the ring it stays, so a wide move keeps it.
    if (hit?.kind === 'hub') setOpen(null);
  });

  /** Let go: a format or a tool runs; a group, or the hub, keeps the ring for a click; anywhere else cancels. */
  const drop = useEffectEvent((hit: RingHit) => {
    const items = itemsRef.current;
    setOver(null);
    setSub(null);
    if (hit?.kind === 'sub') {
      const member = openRef.current !== null ? items[openRef.current]?.members?.[hit.index] : undefined;
      return pickTool(member?.id ?? 'none');
    }
    if (hit?.kind === 'segment') {
      const item = items[hit.index];
      if (item?.members) {
        setOpen(hit.index);
        return setHolding(true);
      }
      return pickTool(item?.id ?? 'none');
    }
    setOpen(null);
    if (hit?.kind === 'hub') return setHolding(true);
    void ringPick('none');
  });

  useEffect(() => {
    document.documentElement.classList.add('ring-page');
    const side = () => window.innerWidth;
    const stops = [
      onHostEvent<null>(RING_SHOW_EVENT, () => {
        setNames(DEFAULT_NAMES);
        setOver(null);
        setOpen(null);
        setSub(null);
        setVisible(false);
        setHolding(false);
        void ringPhone().then(setPhone);
      }),
      onHostEvent<{ names: string[] }>(RING_FILES_EVENT, (payload) => {
        if (payload.names.length === 0) return;
        setNames(payload.names);
        setVisible(true);
      }),
      // Ctrl+Alt+Z: the selected files, held, waiting for a click.
      onHostEvent<null>(RING_HOLD_EVENT, () => {
        setVisible(true);
        setHolding(true);
      }),
      onHostEvent<{ x: number; y: number } | null>(RING_OVER_EVENT, (at) => {
        if (!at) {
          setOver(null);
          return setSub(null);
        }
        track(hitAt(toRing(at, side())));
      }),
      onHostEvent<{ x: number; y: number }>(RING_DROP_EVENT, (at) => drop(hitAt(toRing(at, side())))),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('ring-waiting', !visible);
  }, [visible]);

  useEffect(() => {
    if (!holding) return;
    const timer = window.setTimeout(() => void ringPick('none'), CLICK_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [holding, open, sub]);

  const center = RING_SIZE / 2;
  const nameOf = (id: string) => t(SHORT[id] ?? 'quick.short.all');
  const overItem = over !== null ? tools[over] : undefined;
  const overFormat = sub !== null ? openGroup?.members?.[sub] : undefined;
  // The hub's two lines: the files (or how far the work has got), then what letting go will do.
  const hubTop = work
    ? work.end === 'done'
      ? t('quick.ring.done')
      : work.end === 'failed'
        ? t('quick.ring.failed')
        : `${Math.round(work.progress * 100)}%`
    : filesLabel(names, t);
  const hubHint = work
    ? nameOf(work.tool)
    : overFormat && openGroup
      ? t(holding ? 'quick.ring.clickIn' : 'quick.ring.dropIn', { group: nameOf(openGroup.id), format: overFormat.makes ?? nameOf(overFormat.id) })
      : overItem?.members
        ? t('quick.ring.outward')
        : overItem
          ? t(holding ? 'quick.ring.click' : 'quick.ring.drop', { tool: nameOf(overItem.id) })
          : holding
            ? t('quick.ring.pick')
            : t('quick.ring.hub');
  // The progress round the ring's band, as Filee shows it.
  const band = (RING_INNER + RING_OUTER) / 2;
  const circumference = 2 * Math.PI * band;
  return (
    <main className={['ring', visible ? 'ring-visible' : '', work ? 'ring-working' : ''].filter(Boolean).join(' ')} aria-label={t('quick.title')} aria-hidden={!visible}>
      <svg viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} role="group" aria-label={t('quick.title')}>
        <defs>
          {/* Liquid glass: light from the top left, a sheen on the upper half, a bright rim. */}
          <radialGradient id="ring-glass" cx="32%" cy="22%" r="90%">
            <stop offset="0%" className="ring-glass-hi" />
            <stop offset="100%" className="ring-glass-lo" />
          </radialGradient>
          <linearGradient id="ring-rim" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" className="ring-rim-hi" />
            <stop offset="50%" className="ring-rim-mid" />
            <stop offset="100%" className="ring-rim-lo" />
          </linearGradient>
          <linearGradient id="ring-armed" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="ring-armed-hi" />
            <stop offset="100%" className="ring-armed-lo" />
          </linearGradient>
        </defs>
        <circle cx={center} cy={center} r={RING_OUTER + 4} className="ring-shadow" />
        {openGroup?.members && halves.length > 0 && (
          <g className="ring-half" key={`${openGroup.id}-${open}`}>
            {halves.map((half, k) => {
              const member = openGroup.members![k]!;
              return (
                <g
                  key={member.id}
                  className={k === sub ? 'ring-sub ring-sub-over' : 'ring-sub'}
                  style={{ '--i': k, transformOrigin: `${center}px ${center}px` } as CSSProperties}
                  // Named while a file is dragged over it too, so screen readers and
                  // UI automation can tell the slots apart; a button only when it can be clicked.
                  role={holding ? 'button' : 'img'}
                  aria-label={t(member.labelKey)}
                  onPointerEnter={holding ? () => setSub(k) : undefined}
                  onPointerLeave={holding ? () => setSub(null) : undefined}
                  onClick={holding ? () => pickTool(member.id) : undefined}
                >
                  <path d={half.path} />
                  <text x={half.label.x} y={half.label.y + 4} textAnchor="middle">
                    {member.makes ?? nameOf(member.id)}
                  </text>
                </g>
              );
            })}
          </g>
        )}
        {segments.map((segment, index) => {
          const tool = tools[index]!;
          const Icon = tool.icon;
          const popped = index === open;
          const shift = popped ? outward(index, tools.length, POP) : null;
          return (
            <g
              key={tool.id}
              className={['ring-segment', index === over || popped ? 'ring-segment-over' : '', tool.members ? 'ring-segment-group' : ''].filter(Boolean).join(' ')}
              style={shift ? { transform: `translate(${shift.x}px, ${shift.y}px)` } : undefined}
              role={holding ? 'button' : 'img'}
              aria-label={nameOf(tool.id)}
              aria-expanded={holding && tool.members ? popped : undefined}
              onPointerEnter={
                holding
                  ? () => {
                      setOver(index);
                      setSub(null);
                      setOpen(tool.members ? index : null);
                    }
                  : undefined
              }
              onPointerLeave={holding ? () => setOver(null) : undefined}
              onClick={holding ? () => (tool.members ? setOpen(index) : pickTool(tool.id)) : undefined}
            >
              <path d={segment.path} />
              <Icon x={segment.label.x - 11} y={segment.label.y - (tool.members ? 25 : 20)} width={22} height={22} aria-hidden="true" />
              <text x={segment.label.x} y={segment.label.y + (tool.members ? 11 : 16)} textAnchor="middle">
                {nameOf(tool.id)}
              </text>
              {tool.members && (
                <text x={segment.label.x} y={segment.label.y + 24} textAnchor="middle" className="ring-segment-sub">
                  {t('quick.ring.formats', { n: tool.members.length })}
                </text>
              )}
            </g>
          );
        })}
        {work ? (
          <g className={work.end ? `ring-progress ring-progress-${work.end}` : 'ring-progress'} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(work.progress * 100)} aria-label={nameOf(work.tool)}>
            <circle cx={center} cy={center} r={band} className="ring-progress-track" />
            <circle
              cx={center}
              cy={center}
              r={band}
              className="ring-progress-bar"
              strokeDasharray={`${circumference * work.progress} ${circumference}`}
              transform={`rotate(-90 ${center} ${center})`}
            />
          </g>
        ) : null}
        <g
          className="ring-hub-group"
          role={holding || (work && !work.end) ? 'button' : undefined}
          aria-label={holding || (work && !work.end) ? t('quick.ring.close') : undefined}
          onClick={work && !work.end ? () => stopper.current?.abort() : holding ? () => void ringPick('none') : undefined}
        >
          <circle cx={center} cy={center} r={RING_INNER - 4} className="ring-hub" />
          <text x={center} y={center - 5} textAnchor="middle" className="ring-hub-text">
            {hubTop}
          </text>
          <text x={center} y={center + 10} textAnchor="middle" className="ring-hub-hint">
            {hubHint}
          </text>
          {(holding || (work && !work.end)) && (
            <text x={center} y={center + 26} textAnchor="middle" className="ring-hub-close">
              {t('quick.ring.close')}
            </text>
          )}
        </g>
      </svg>
    </main>
  );
}

/** The ring's window; the desktop host mounts it instead of `App` there. */
export function RingApp() {
  return (
    <I18nProvider>
      <RingWindow />
    </I18nProvider>
  );
}
