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
import { RING_INNER, RING_OUTER, RING_SIZE, ringSegments, segmentAt } from './ringGeometry';

/**
 * The ring (`src-tauri/src/ring.rs`): a transparent window the host shows at
 * the pointer when files are dragged out of File Explorer or Finder with
 * Ctrl (Option) held. Its tools fit the files being dragged — the host says
 * which once they are over it — and letting go on one opens that tool's
 * quick window. The middle, or anywhere off the ring, cancels.
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

function RingWindow() {
  const { t } = useI18n();
  const [names, setNames] = useState<string[]>(DEFAULT_NAMES);
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
    const stops = [
      onHostEvent<null>(RING_SHOW_EVENT, () => {
        setNames(DEFAULT_NAMES);
        setOver(null);
      }),
      onHostEvent<{ names: string[] }>(RING_FILES_EVENT, (payload) => {
        if (payload.names.length > 0) setNames(payload.names);
      }),
      onHostEvent<{ x: number; y: number } | null>(RING_OVER_EVENT, (at) => {
        setOver(at ? segmentAt(at.x, at.y, segmentsRef.current.length) : null);
      }),
      onHostEvent<{ x: number; y: number }>(RING_DROP_EVENT, (at) => {
        const index = segmentAt(at.x, at.y, segmentsRef.current.length);
        setOver(null);
        void ringPick(index === null ? 'none' : (segmentsRef.current[index] ?? 'none'));
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);

  const center = RING_SIZE / 2;
  return (
    <main className="ring" aria-label={t('quick.title')}>
      <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} role="img" aria-label={t('quick.title')}>
        <circle cx={center} cy={center} r={RING_OUTER + 4} className="ring-shadow" />
        {segments.map((segment, index) => {
          const tool = tools[index]!;
          const Icon = tool.icon;
          return (
            <g key={tool.id} className={index === over ? 'ring-segment ring-segment-over' : 'ring-segment'}>
              <path d={segment.path} />
              <Icon x={segment.label.x - 11} y={segment.label.y - 20} width={22} height={22} aria-hidden="true" />
              <text x={segment.label.x} y={segment.label.y + 16} textAnchor="middle">
                {t(SHORT[tool.id] ?? 'quick.short.all')}
              </text>
            </g>
          );
        })}
        <circle cx={center} cy={center} r={RING_INNER - 4} className="ring-hub" />
        <text x={center} y={center + 5} textAnchor="middle" className="ring-hub-text">
          {over === null ? t('quick.ring.cancel') : t(SHORT[tools[over]?.id ?? 'all'] ?? 'quick.short.all')}
        </text>
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
