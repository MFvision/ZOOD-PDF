import { useEffect, useMemo, useRef, useState } from 'react';
import '../styles/tokens.css';
import '../styles/looks.css';
import '../styles/fonts.css';
import './ring.css';
import { RING_DROP_EVENT, RING_FILES_EVENT, RING_OVER_EVENT, RING_SHOW_EVENT, onHostEvent, ringPick } from '../core/host-tauri';
import { I18nProvider } from '../i18n/I18nProvider';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { ALL_TOOLS_ICON, toolsFor } from './plan';
import { RING_INNER, RING_OUTER, RING_SIZE, inHub, ringSegments, segmentAt, toRing } from './ringGeometry';

/**
 * The ring (`src-tauri/src/ring.rs`): a transparent window the host shows at
 * the pointer when files are dragged out of File Explorer or Finder with
 * Ctrl or Shift (Option or Command) held. It stays invisible until files
 * are over it; its tools fit those files, and letting go on one opens that
 * tool's quick window. Letting go in the middle keeps the ring, to click a
 * tool; anywhere off the ring cancels.
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
  all: 'quick.short.all',
};

/** Before the host has said what the files are: a PDF's tools. */
const DEFAULT_NAMES = ['file.pdf'];

/** How long a ring holding files waits for a click before it closes. */
const CLICK_WAIT_MS = 30_000;

function RingWindow() {
  const { t } = useI18n();
  const [names, setNames] = useState<string[]>(DEFAULT_NAMES);
  // Invisible until files are dragged over it: a drag of anything else
  // (text, a rubber-band selection) shows nothing.
  const [visible, setVisible] = useState(false);
  // Files were let go in the hub: the ring stays, and a click picks the tool.
  const [holding, setHolding] = useState(false);
  const [over, setOver] = useState<number | null>(null);
  const segmentsRef = useRef<string[]>([]);

  const tools = useMemo(() => {
    const fitting = toolsFor(names);
    return [...fitting.map((tool) => ({ id: tool.id as string, icon: tool.icon })), { id: 'all', icon: ALL_TOOLS_ICON }];
  }, [names]);
  const segments = useMemo(() => ringSegments(tools.length), [tools.length]);
  useEffect(() => {
    segmentsRef.current = tools.map((tool) => tool.id);
  }, [tools]);

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
      onHostEvent<{ x: number; y: number } | null>(RING_OVER_EVENT, (at) => {
        if (!at) return setOver(null);
        const point = toRing(at, side());
        setOver(segmentAt(point.x, point.y, segmentsRef.current.length));
      }),
      onHostEvent<{ x: number; y: number }>(RING_DROP_EVENT, (at) => {
        const point = toRing(at, side());
        const index = segmentAt(point.x, point.y, segmentsRef.current.length);
        setOver(null);
        if (index !== null) return void ringPick(segmentsRef.current[index] ?? 'none');
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
  const hub = holding ? t('quick.ring.pick') : over === null ? t('quick.ring.hub') : t(SHORT[tools[over]?.id ?? 'all'] ?? 'quick.short.all');
  return (
    <main className={visible ? 'ring ring-visible' : 'ring'} aria-label={t('quick.title')} aria-hidden={!visible}>
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
              onClick={holding ? () => void ringPick(tool.id) : undefined}
            >
              <path d={segment.path} />
              <Icon x={segment.label.x - 11} y={segment.label.y - 20} width={22} height={22} aria-hidden="true" />
              <text x={segment.label.x} y={segment.label.y + 16} textAnchor="middle">
                {t(SHORT[tool.id] ?? 'quick.short.all')}
              </text>
            </g>
          );
        })}
        <g
          className="ring-hub-group"
          role={holding ? 'button' : undefined}
          aria-label={holding ? t('quick.ring.close') : undefined}
          onClick={holding ? () => void ringPick('none') : undefined}
        >
          <circle cx={center} cy={center} r={RING_INNER - 4} className="ring-hub" />
          <text x={center} y={center + 5} textAnchor="middle" className="ring-hub-text">
            {hub}
          </text>
          {holding && (
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
