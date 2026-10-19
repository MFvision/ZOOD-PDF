import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import '../styles/tokens.css';
import '../styles/looks.css';
import '../styles/fonts.css';
import './ring.css';
import { getSharedCoreClient } from '../core/client';
import { RING_DROP_EVENT, RING_FILES_EVENT, RING_HOLD_EVENT, RING_OVER_EVENT, RING_SHOW_EVENT, onHostEvent, ringDone, ringPick, ringTake } from '../core/host-tauri';
import { I18nProvider } from '../i18n/I18nProvider';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import type { FileState } from '../batch/run';
import { ALL_TOOLS_ICON, findQuickTool, ringToolsFor, startingOptions } from './plan';
import { runQuick, wantsPassword } from './runQuick';
import { RING_INNER, RING_OUTER, RING_SIZE, inHub, ringSegments, segmentAt, toRing } from './ringGeometry';

/**
 * The ring (`src-tauri/src/ring.rs`): a transparent window the host shows at
 * the pointer when files are dragged out of File Explorer or Finder with
 * Ctrl or Shift (Option or Command) held. It stays invisible until files
 * are over it; its tools fit those files. Letting go on a tool that needs
 * nothing more runs it there and then, its progress going round the ring
 * (results beside the originals); a tool that needs a password, pages or a
 * size opens its quick window. Letting go in the middle keeps the ring, to
 * click a tool; anywhere off the ring cancels. Ctrl+Alt+Z (Command+Option+Z)
 * opens it at the pointer on the files selected in the file manager, the
 * same way.
 */

const SHORT: Record<string, TKey> = {
  compress: 'quick.short.compress',
  word: 'quick.short.word',
  images: 'quick.short.images',
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
  all: 'quick.short.all',
};

/** How long the tick (or the cross) stays before the ring goes. */
const DONE_SHOWN_MS = 1200;
const FAILED_SHOWN_MS = 2600;

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
  const segmentsRef = useRef<string[]>([]);

  const tools = useMemo(() => {
    const fitting = ringToolsFor(names);
    return [...fitting.map((tool) => ({ id: tool.id as string, icon: tool.icon })), { id: 'all', icon: ALL_TOOLS_ICON }];
  }, [names]);
  const segments = useMemo(() => ringSegments(tools.length), [tools.length]);
  useEffect(() => {
    segmentsRef.current = tools.map((tool) => tool.id);
  }, [tools]);

  // A tool picked: one that needs nothing more runs here; the rest open their window.
  const pickTool = (id: string) => {
    const tool = findQuickTool(id);
    if (!tool || tool.mode !== 'instant') return void ringPick(id);
    setHolding(false);
    setOver(null);
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
  const pick = useEffectEvent((id: string) => pickTool(id));

  useEffect(() => {
    document.documentElement.classList.add('ring-page');
    const side = () => window.innerWidth;
    const stops = [
      onHostEvent<null>(RING_SHOW_EVENT, () => {
        setNames(DEFAULT_NAMES);
        setOver(null);
        setVisible(false);
        setHolding(false);
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
        if (!at) return setOver(null);
        const point = toRing(at, side());
        setOver(segmentAt(point.x, point.y, segmentsRef.current.length));
      }),
      onHostEvent<{ x: number; y: number }>(RING_DROP_EVENT, (at) => {
        const point = toRing(at, side());
        const index = segmentAt(point.x, point.y, segmentsRef.current.length);
        setOver(null);
        if (index !== null) return pick(segmentsRef.current[index] ?? 'none');
        if (inHub(point.x, point.y)) return setHolding(true);
        void ringPick('none');
      }),
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
  }, [holding]);

  const center = RING_SIZE / 2;
  const hub = work
    ? work.end === 'done'
      ? t('quick.ring.done')
      : work.end === 'failed'
        ? t('quick.ring.failed')
        : `${Math.round(work.progress * 100)}%`
    : holding
      ? t('quick.ring.pick')
      : over === null
        ? t('quick.ring.hub')
        : t(SHORT[tools[over]?.id ?? 'all'] ?? 'quick.short.all');
  // The progress round the ring's band, as Filee shows it.
  const band = (RING_INNER + RING_OUTER) / 2;
  const circumference = 2 * Math.PI * band;
  return (
    <main className={['ring', visible ? 'ring-visible' : '', work ? 'ring-working' : ''].filter(Boolean).join(' ')} aria-label={t('quick.title')} aria-hidden={!visible}>
      <svg viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} role="img" aria-label={t('quick.title')}>
        <circle cx={center} cy={center} r={RING_OUTER + 4} className="ring-shadow" />
        {segments.map((segment, index) => {
          const tool = tools[index]!;
          const Icon = tool.icon;
          return (
            <g
              key={tool.id}
              className={index === over ? 'ring-segment ring-segment-over' : 'ring-segment'}
              role={holding ? 'button' : undefined}
              aria-label={holding ? t(SHORT[tool.id] ?? 'quick.short.all') : undefined}
              onPointerEnter={holding ? () => setOver(index) : undefined}
              onPointerLeave={holding ? () => setOver(null) : undefined}
              onClick={holding ? () => pickTool(tool.id) : undefined}
            >
              <path d={segment.path} />
              <Icon x={segment.label.x - 11} y={segment.label.y - 20} width={22} height={22} aria-hidden="true" />
              <text x={segment.label.x} y={segment.label.y + 16} textAnchor="middle">
                {t(SHORT[tool.id] ?? 'quick.short.all')}
              </text>
            </g>
          );
        })}
        {work ? (
          <g className={work.end ? `ring-progress ring-progress-${work.end}` : 'ring-progress'} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(work.progress * 100)} aria-label={t(SHORT[work.tool] ?? 'quick.short.all')}>
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
          <text x={center} y={center + 5} textAnchor="middle" className="ring-hub-text">
            {hub}
          </text>
          {(holding || (work && !work.end)) && (
            <text x={center} y={center + 22} textAnchor="middle" className="ring-hub-close">
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
