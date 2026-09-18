import { useEffect, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react';
import type { RemoteDocument } from '../core/client';
import type { PageSize } from '../core/types';
import { useI18n } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { useRenderedCanvas } from '../viewer/useRenderedCanvas';
import { useSharedObserver } from '../viewer/useSharedObserver';
import type { SharedObserver } from '../viewer/useSharedObserver';
import { orderMovingTo, positionsAfter, selectionAfterDelete } from './selection';
import type { SelectHow } from './selection';
import './organize.css';

/** Longest side of a page tile, in CSS pixels. */
const TILE = 150;

interface TileProps {
  document: RemoteDocument;
  index: number;
  size: PageSize;
  selected: boolean;
  focused: boolean;
  revision: number;
  dropSide: 'before' | 'after' | null;
  observer: SharedObserver;
  label: string;
  onPick: (event: MouseEvent, index: number) => void;
  onDragStart: (event: DragEvent, index: number) => void;
  onDragOver: (event: DragEvent, index: number) => void;
}

function PageTile({ document, index, size, selected, focused, revision, dropSide, observer, label, onPick, onDragStart, onDragOver }: TileProps) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const fit = TILE / Math.max(size[0], size[1], 1);
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return observer.observe(element, (entry) => setNear(entry.isIntersecting));
  }, [observer]);

  useEffect(() => {
    if (focused) ref.current?.focus({ preventScroll: false });
  }, [focused]);

  // `revision` changes with every page change: this tile may show another page now.
  useRenderedCanvas(canvasRef, document, index, fit * dpr, near, false, revision);

  return (
    <div
      ref={ref}
      role="option"
      aria-selected={selected}
      aria-label={label}
      tabIndex={focused ? 0 : -1}
      draggable
      data-page={index + 1}
      className={['organize-tile', selected && 'is-selected', dropSide && `drop-${dropSide}`].filter(Boolean).join(' ')}
      onClick={(event) => onPick(event, index)}
      onDragStart={(event) => onDragStart(event, index)}
      onDragOver={(event) => onDragOver(event, index)}
    >
      <canvas
        ref={canvasRef}
        className="organize-canvas"
        style={{ inlineSize: size[0] * fit, blockSize: size[1] * fit }}
      />
      <span className="organize-number" aria-hidden="true">
        {index + 1}
      </span>
    </div>
  );
}

/**
 * Organize pages, the pages: a grid of every page, to select, drag into a new
 * order, and act on from `OrganizePanel`. Keyboard: arrows move (mirrored
 * right to left), Space toggles, Shift+arrow extends, Cmd/Ctrl+A selects
 * all, Delete deletes.
 */
export function OrganizeView() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const { t, dir } = useI18n();
  const gridRef = useRef<HTMLDivElement>(null);
  const observer = useSharedObserver(gridRef, '400px 0px', 0);
  const [focusAt, setFocus] = useState(0);
  const [drop, setDrop] = useState<{ index: number; side: 'before' | 'after' } | null>(null);
  const document = services.document;
  const info = state.document;
  const { selection, revision, busy } = state.organize;
  const count = info?.pageCount ?? 0;
  // A deletion can leave the focus past the last page.
  const focus = Math.max(0, Math.min(focusAt, count - 1));

  if (!document || !info) return null;

  const pick = (index: number, how: SelectHow) => {
    setFocus(index);
    dispatch({ type: 'ORGANIZE_SELECT', index, how });
  };

  const onPick = (event: MouseEvent, index: number) =>
    pick(index, event.shiftKey ? 'range' : event.metaKey || event.ctrlKey ? 'toggle' : 'only');

  const reorderTo = (target: number) => {
    const moving = selection.pages;
    const order = orderMovingTo(count, moving, target);
    if (order) void services.organizePages('reorder', { order }, () => positionsAfter(order, moving));
  };

  const onDragStart = (event: DragEvent, index: number) => {
    if (!selection.pages.includes(index)) pick(index, 'only');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index + 1));
  };

  const onDragOver = (event: DragEvent, index: number) => {
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    const firstHalf = dir === 'rtl' ? event.clientX > box.left + box.width / 2 : event.clientX < box.left + box.width / 2;
    setDrop({ index, side: firstHalf ? 'before' : 'after' });
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    if (drop && !busy) reorderTo(drop.side === 'before' ? drop.index : drop.index + 1);
    setDrop(null);
  };

  /** How many tiles sit in one row, for the up and down arrows. */
  const columns = () => {
    const tiles = gridRef.current?.querySelectorAll<HTMLElement>('.organize-tile');
    if (!tiles || tiles.length === 0) return 1;
    const top = tiles[0]!.offsetTop;
    let n = 0;
    while (n < tiles.length && tiles[n]!.offsetTop === top) n += 1;
    return Math.max(1, n);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const backward = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    const steps: Record<string, number> = { [forward]: 1, [backward]: -1, ArrowDown: columns(), ArrowUp: -columns() };
    if (event.key in steps) {
      event.preventDefault();
      const next = Math.min(count - 1, Math.max(0, focus + (steps[event.key] ?? 0)));
      if (event.shiftKey) pick(next, 'range');
      else setFocus(next);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setFocus(event.key === 'Home' ? 0 : count - 1);
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      pick(focus, event.key === ' ' ? 'toggle' : 'only');
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      dispatch({ type: 'ORGANIZE_SELECT_ALL' });
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && selection.pages.length > 0) {
      event.preventDefault();
      const pages = selection.pages;
      if (!busy && pages.length < count) {
        void services.organizePages('delete', { pages }, () => selectionAfterDelete(count, pages).pages);
      }
    }
  };

  return (
    <div
      ref={gridRef}
      className="organize-grid"
      role="listbox"
      aria-label={t('organize.grid')}
      aria-multiselectable="true"
      aria-busy={busy}
      onKeyDown={onKeyDown}
      onDrop={onDrop}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
      }}
    >
      {info.pageSizes.map((size, index) => (
        <PageTile
          key={index}
          document={document}
          index={index}
          size={size}
          selected={selection.pages.includes(index)}
          focused={index === focus}
          revision={revision}
          dropSide={drop?.index === index ? drop.side : null}
          observer={observer}
          label={t('viewer.page', { page: index + 1 })}
          onPick={onPick}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
        />
      ))}
    </div>
  );
}
