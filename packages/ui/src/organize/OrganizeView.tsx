import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { RemoteDocument } from '../core/client';
import type { PageSize } from '../core/types';
import { useI18n } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { useRenderedCanvas } from '../viewer/useRenderedCanvas';
import { useSharedObserver } from '../viewer/useSharedObserver';
import type { SharedObserver } from '../viewer/useSharedObserver';
import { PageMenu } from './PageMenu';
import type { PageMenuState } from './PageMenu';
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
  onPress: (event: ReactPointerEvent, index: number) => void;
  onMenu: (event: MouseEvent, index: number) => void;
}

function PageTile({ document, index, size, selected, focused, revision, dropSide, observer, label, onPick, onPress, onMenu }: TileProps) {
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
      data-page={index + 1}
      data-index={index}
      className={['organize-tile', selected && 'is-selected', dropSide && `drop-${dropSide}`].filter(Boolean).join(' ')}
      onClick={(event) => onPick(event, index)}
      onContextMenu={(event) => onMenu(event, index)}
      onPointerDown={(event) => onPress(event, index)}
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

/** How far, in CSS pixels, a press moves before it is a drag. */
const DRAG_START = 6;

/**
 * Organize pages, the pages: a grid of every page, to select, drag into a new
 * order — or onto another document's tab, which copies them there
 * (`shell/TabBar.tsx`) — and act on from `OrganizePanel`. The drag follows
 * the pointer itself rather than the browser's drag and drop, which the
 * desktop's webview keeps for files from outside on Windows. Keyboard:
 * arrows move (mirrored right to left), Space toggles, Shift+arrow extends, Cmd/Ctrl+A selects
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
  const [menu, setMenu] = useState<PageMenuState | null>(null);
  // A page drag under way: where it began, and whether it has moved enough to be one.
  const press = useRef<{ pointer: number; x: number; y: number; index: number; moving: boolean } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; count: number } | null>(null);
  const overTab = useRef<HTMLElement | null>(null);
  const dropRef = useRef<{ index: number; side: 'before' | 'after' } | null>(null);
  const draggedRef = useRef(false);
  const actions = useRef<{ reorder: (target: number) => void; copy: (tab: number | null) => void; pick: () => void; pages: () => number }>({
    reorder: () => undefined,
    copy: () => undefined,
    pick: () => undefined,
    pages: () => 0,
  });
  const document = services.document;
  const info = state.document;
  const { selection, revision, busy } = state.organize;
  const count = info?.pageCount ?? 0;
  // A deletion can leave the focus past the last page.
  const focus = Math.max(0, Math.min(focusAt, count - 1));

  // Go to page: that page's tile, scrolled to and chosen — for requests made
  // here, not one left over from the view before.
  const request = state.scrollRequest;
  const seenRequest = useRef(request?.nonce ?? 0);
  useEffect(() => {
    if (!request || request.nonce <= seenRequest.current) return;
    seenRequest.current = request.nonce;
    gridRef.current?.querySelector<HTMLElement>(`[data-page="${request.page}"]`)?.scrollIntoView({ block: 'nearest' });
    setFocus(request.page - 1);
    dispatch({ type: 'ORGANIZE_SELECT', index: request.page - 1, how: 'only' });
  }, [request, dispatch]);

  // The drag itself, on the window: it goes on over the tabs, outside the grid.
  useEffect(() => {
    const markTab = (element: HTMLElement | null) => {
      if (overTab.current === element) return;
      overTab.current?.classList.remove('is-drop-target');
      element?.classList.add('is-drop-target');
      overTab.current = element;
    };
    const finish = () => {
      press.current = null;
      markTab(null);
      dropRef.current = null;
      setDrop(null);
      setGhost(null);
    };
    const onMove = (event: PointerEvent) => {
      const at = press.current;
      if (!at || event.pointerId !== at.pointer) return;
      if (!at.moving) {
        if (Math.hypot(event.clientX - at.x, event.clientY - at.y) < DRAG_START) return;
        at.moving = true;
        actions.current.pick();
      }
      event.preventDefault();
      setGhost({ x: event.clientX, y: event.clientY, count: actions.current.pages() });
      const under = window.document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      markTab(under?.closest<HTMLElement>('[data-tab-drop]') ?? null);
      const tile = under?.closest<HTMLElement>('.organize-tile');
      if (tile && gridRef.current?.contains(tile)) {
        const box = tile.getBoundingClientRect();
        const firstHalf = dir === 'rtl' ? event.clientX > box.left + box.width / 2 : event.clientX < box.left + box.width / 2;
        const next = { index: Number(tile.dataset.index), side: firstHalf ? ('before' as const) : ('after' as const) };
        dropRef.current = next;
        setDrop(next);
      } else {
        dropRef.current = null;
        setDrop(null);
      }
    };
    const onUp = (event: PointerEvent) => {
      const at = press.current;
      if (!at || event.pointerId !== at.pointer) return;
      if (at.moving) {
        draggedRef.current = true;
        const tab = overTab.current?.dataset.tabDrop;
        const target = dropRef.current;
        if (tab !== undefined) actions.current.copy(tab === 'new' ? null : Number(tab));
        else if (target) actions.current.reorder(target.side === 'before' ? target.index : target.index + 1);
      }
      finish();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', finish);
    };
  }, [dir]);

  if (!document || !info) return null;

  const pick = (index: number, how: SelectHow) => {
    setFocus(index);
    dispatch({ type: 'ORGANIZE_SELECT', index, how });
  };

  const onPick = (event: MouseEvent, index: number) => {
    // The click that ends a drag is not a choice.
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    pick(index, event.shiftKey ? 'range' : event.metaKey || event.ctrlKey ? 'toggle' : 'only');
  };

  // The page's context menu: a right-click, or the keyboard's menu key
  // (`contextmenu` without a point), on the page — which joins the
  // selection when it is not already in it.
  const onMenu = (event: MouseEvent, index: number) => {
    event.preventDefault();
    if (!selection.pages.includes(index)) pick(index, 'only');
    else setFocus(index);
    const tile = event.currentTarget as HTMLElement;
    const box = tile.getBoundingClientRect();
    const at = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    setMenu({ index, at, from: tile });
  };

  // Crop's controls are in the panel: choose the page, then bring them into view.
  const cropPage = (index: number) => {
    pick(index, 'only');
    const crop = window.document.querySelector<HTMLElement>('.pane-end .organize-crop');
    crop?.scrollIntoView({ block: 'nearest' });
    crop?.querySelector<HTMLElement>('button, input')?.focus({ preventScroll: true });
  };

  // A press on a page: a drag once it moves (mouse and pen; a finger scrolls
  // the grid). It carries the selection, or this page alone when the page is
  // not in it, and what to do with them at the end.
  const onPress = (event: ReactPointerEvent, index: number) => {
    if (event.button !== 0 || event.pointerType === 'touch' || busy) return;
    draggedRef.current = false;
    press.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, index, moving: false };
    const moving = selection.pages.includes(index) ? [...selection.pages].sort((a, b) => a - b) : [index];
    actions.current = {
      pick: () => {
        if (!selection.pages.includes(index)) pick(index, 'only');
      },
      pages: () => moving.length,
      reorder: (target) => {
        const order = orderMovingTo(count, moving, target);
        if (order) void services.organizePages('reorder', { order }, () => positionsAfter(order, moving));
      },
      copy: (tab) => void services.copyPagesToTab(tab, moving),
    };
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
          onPress={onPress}
          onMenu={onMenu}
        />
      ))}
      {ghost ? (
        <div className="organize-drag-ghost" style={{ insetInlineStart: 0, left: ghost.x + 14, top: ghost.y + 14 }} aria-hidden="true">
          {t('tabs.dragPages', { count: ghost.count })}
        </div>
      ) : null}
      <PageMenu menu={menu} onClose={() => setMenu(null)} onCrop={cropPage} />
    </div>
  );
}
