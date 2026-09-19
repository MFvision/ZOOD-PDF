import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { PluginRegistry } from '@embedpdf/react-pdf-viewer';
import { useT } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { pagesOnScreen, viewportBox, watchView } from './embedForms';
import { moved, resized } from './formTypes';
import type { PageRect, Proposal, ProposalKind } from './formTypes';

export const KIND_LABELS: Record<ProposalKind, TKey> = {
  text: 'forms.kind.text',
  checkbox: 'forms.kind.checkbox',
  date: 'forms.kind.date',
  hijri: 'forms.kind.hijri',
  signature: 'forms.kind.signature',
};

interface Drag {
  id: string;
  mode: 'move' | 'resize';
  x: number;
  y: number;
  rect: PageRect;
  scale: number;
  page: { width: number; height: number };
}

/**
 * Detection's proposals drawn over EmbedPDF's pages, where the fields would
 * go: each can be chosen, dragged to where it belongs, resized from its
 * corner, nudged with the arrow keys and removed with Delete. Nothing is in
 * the file until the panel creates the fields.
 */
export function ProposalOverlay({
  registry,
  proposals,
  selected,
  onSelect,
  onChange,
  onRemove,
}: {
  registry: PluginRegistry;
  proposals: readonly Proposal[];
  selected: string | null;
  onSelect: (id: string) => void;
  onChange: (id: string, rect: PageRect) => void;
  onRemove: (id: string) => void;
}) {
  const t = useT();
  const [, setTick] = useState(0);
  useEffect(() => watchView(registry, () => setTick((n) => n + 1)), [registry]);
  const drag = useRef<Drag | null>(null);

  const host = document.querySelector<HTMLElement>('.shell-main');
  const view = viewportBox();
  if (!host || !view) return null;
  const origin = host.getBoundingClientRect();
  const pages = pagesOnScreen(registry);

  const start = (event: PointerEvent<HTMLElement>, p: Proposal, mode: Drag['mode']) => {
    const page = pages.get(p.page);
    if (!page || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(p.id);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = {
      id: p.id,
      mode,
      x: event.clientX,
      y: event.clientY,
      rect: p.rect,
      scale: page.box.width / page.width,
      page: { width: page.width, height: page.height },
    };
  };
  const follow = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = (event.clientX - d.x) / d.scale;
    const dy = (event.clientY - d.y) / d.scale;
    onChange(
      d.id,
      d.mode === 'move' ? moved(d.rect, dx, dy, d.page) : resized(d.rect, dx, dy, d.page),
    );
  };
  const stop = () => {
    drag.current = null;
  };
  const keys = (event: KeyboardEvent<HTMLElement>, p: Proposal) => {
    const page = pages.get(p.page);
    const step = event.shiftKey ? 10 : 1;
    const by: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      onRemove(p.id);
    } else if (by[event.key] && page) {
      event.preventDefault();
      const [dx, dy] = by[event.key] ?? [0, 0];
      onChange(p.id, moved(p.rect, dx, dy, page));
    }
  };

  return createPortal(
    <div
      className="proposal-layer"
      style={{
        left: view.left - origin.left,
        top: view.top - origin.top,
        width: view.width,
        height: view.height,
      }}
    >
      {proposals.map((p) => {
        const page = pages.get(p.page);
        if (!page) return null;
        const s = page.box.width / page.width;
        const [x0, top, x1, bottom] = p.rect;
        return (
          <div
            key={p.id}
            role="button"
            tabIndex={0}
            className={`proposal proposal-${p.kind}${p.id === selected ? ' is-selected' : ''}`}
            aria-label={`${p.name} — ${t(KIND_LABELS[p.kind])}`}
            aria-pressed={p.id === selected}
            data-proposal={p.name}
            data-top={p.rect[1].toFixed(1)}
            style={{
              left: page.box.left - view.left + x0 * s,
              top: page.box.top - view.top + top * s,
              width: (x1 - x0) * s,
              height: (bottom - top) * s,
            }}
            onPointerDown={(event) => start(event, p, 'move')}
            onPointerMove={follow}
            onPointerUp={stop}
            onPointerCancel={stop}
            onKeyDown={(event) => keys(event, p)}
            onFocus={() => onSelect(p.id)}
          >
            <span className="proposal-name" dir="auto">
              {p.name}
            </span>
            <span
              className="proposal-handle"
              aria-hidden="true"
              onPointerDown={(event) => start(event, p, 'resize')}
              onPointerMove={follow}
              onPointerUp={stop}
              onPointerCancel={stop}
            />
          </div>
        );
      })}
    </div>,
    host,
  );
}
