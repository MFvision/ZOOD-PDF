import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { ZoodMark } from '../components/ZoodMark';
import { useReducedMotion } from '../components/useReducedMotion';
import { useI18n } from '../i18n/useT';
import { Row, Toggle } from './controls';

/**
 * A setting that arranges things, shown as the thing itself: a little
 * picture of the drop panel, the ring, the right-click menu, Home or the AI
 * chat, with every item as its icon in the place it has now. Take one with
 * the pointer and drag it anywhere: into another row it takes that row's
 * size as it lands (a small chip dropped in the big row grows into a big
 * tile), onto a full row it swaps places with the one it lands on, and
 * into the tray under the picture it is no longer shown. A tap picks one
 * up and a second tap puts it in place (or swaps the two); the arrow keys
 * move it, Delete puts it in the tray. The owner asked for this in place
 * of lists with arrows: "like doing it from real life".
 *
 * The pointer is followed with pointer events on the board, not the
 * system's drag and drop, which the desktop app keeps for files.
 */

/** How an item looks in a place: a big tile, a small chip, a bottom pill, a slot on the ring, a menu line, a Home section, a chat chip. */
export type BoardSize = 'big' | 'small' | 'pill' | 'ring' | 'row' | 'card' | 'chip';

export interface BoardZone {
  id: string;
  label: string;
  size: BoardSize;
  /** At most this many: one more swaps with the one it lands on. */
  max?: number;
}

export interface BoardLook {
  icon: LucideIcon;
  word: string;
  /** What it does, shown as its tooltip. */
  note?: string;
}

export type BoardFrame = 'island' | 'ring' | 'menu' | 'home' | 'chat';

type Places<T> = Record<string, T[]>;

const TRAY = 'tray';

/** Where one item goes: the place, its index there (counted without it), and the one under the pointer. */
interface Spot<T> {
  zone: string;
  index: number;
  over: T | null;
}

/** `item` taken out of where it is and put at `spot`; a full place swaps it with the one it lands on. */
export function placeItem<T>(places: Places<T>, item: T, spot: Spot<T>, maxOf: (zone: string) => number | undefined): Places<T> {
  const next: Places<T> = {};
  for (const [zone, items] of Object.entries(places)) next[zone] = [...items];
  const from = Object.keys(next).find((zone) => next[zone]!.includes(item));
  if (!from || !next[spot.zone]) return places;
  const fromAt = next[from]!.indexOf(item);
  next[from]!.splice(fromAt, 1);
  const into = next[spot.zone]!;
  const max = maxOf(spot.zone);
  if (from !== spot.zone && max !== undefined && into.length >= max) {
    const at = spot.over !== null && into.includes(spot.over) ? into.indexOf(spot.over) : into.length - 1;
    const [out] = into.splice(at, 1, item);
    if (out !== undefined) next[from]!.splice(fromAt, 0, out);
    return next;
  }
  into.splice(Math.max(0, Math.min(spot.index, into.length)), 0, item);
  return next;
}

/** Two items change places, wherever they are. */
export function swapItems<T>(places: Places<T>, a: T, b: T): Places<T> {
  const next: Places<T> = {};
  for (const [zone, items] of Object.entries(places)) next[zone] = items.map((one) => (one === a ? b : one === b ? a : one));
  return next;
}

const same = <T,>(a: Places<T>, b: Places<T>) => Object.keys(a).every((zone) => a[zone]!.length === b[zone]?.length && a[zone]!.every((one, at) => one === b[zone]![at]));

function ItemFace({ look, size }: { look: BoardLook; size: BoardSize }) {
  const Icon = look.icon;
  const big = size === 'big' || size === 'card';
  return (
    <>
      <span className="board-item-icon" aria-hidden="true">
        <Icon size={big ? 20 : size === 'ring' ? 18 : 14} strokeWidth={1.8} />
      </span>
      {size === 'ring' ? null : <span className="board-item-word">{look.word}</span>}
    </>
  );
}

interface Drag<T> {
  item: T;
  pointer: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  moved: boolean;
  base: Places<T>;
  shown: Places<T>;
}

export function LayoutBoard<T extends string>({
  label,
  hint,
  frame,
  zones,
  layout,
  hidden,
  look,
  onChange,
  auto,
  trayLabel,
}: {
  label: string;
  hint?: ReactNode;
  frame: BoardFrame;
  zones: readonly BoardZone[];
  /** What is in each place now, by zone id, in order. */
  layout: Readonly<Record<string, readonly T[]>>;
  /** What is not shown (the tray); leave out where nothing can be taken off. */
  hidden?: readonly T[];
  look: (item: T) => BoardLook;
  onChange: (layout: Places<T>, hidden: T[]) => void;
  /** ZOOD arranges it (by most used); any move made by hand turns it off. */
  auto?: { on: boolean; label: string; hint: string; onChange: (on: boolean) => void };
  trayLabel?: string;
}) {
  const { t, dir } = useI18n();
  const id = useId();
  const reduced = useReducedMotion();
  const board = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag<T> | null>(null);
  const [held, setHeld] = useState<T | null>(null);
  const [said, setSaid] = useState('');
  const skipClick = useRef(false);

  const all: Places<T> = {};
  for (const zone of zones) all[zone.id] = [...(layout[zone.id] ?? [])];
  if (hidden) all[TRAY] = [...hidden];
  const shown = drag?.moved ? drag.shown : all;
  const sizeOf = (zone: string): BoardSize => zones.find((one) => one.id === zone)?.size ?? 'chip';
  const labelOf = (zone: string) => (zone === TRAY ? (trayLabel ?? t('board.tray')) : (zones.find((one) => one.id === zone)?.label ?? ''));
  const maxOf = (zone: string) => zones.find((one) => one.id === zone)?.max;
  const zoneOf = (places: Places<T>, item: T) => Object.keys(places).find((zone) => places[zone]!.includes(item)) ?? TRAY;

  const commit = (next: Places<T>, moved: T) => {
    if (same(next, all)) return;
    const { [TRAY]: tray = [], ...rest } = next;
    if (auto?.on) auto.onChange(false);
    onChange(rest, tray);
    const zone = zoneOf(next, moved);
    setSaid(t('board.moved', { name: look(moved).word, place: labelOf(zone) }));
  };

  // Every item glides from where it was to where it is now, and grows or shrinks to its new size.
  const boxes = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const root = board.current;
    if (!root) return;
    const origin = root.getBoundingClientRect();
    const next = new Map<string, DOMRect>();
    root.querySelectorAll<HTMLElement>('[data-board-item]').forEach((element) => {
      const key = element.dataset.boardItem!;
      const box = element.getBoundingClientRect();
      const here = new DOMRect(box.left - origin.left, box.top - origin.top, box.width, box.height);
      next.set(key, here);
      const was = boxes.current.get(key);
      if (!was || reduced || typeof element.animate !== 'function' || !here.width || !here.height) return;
      const dx = was.left - here.left;
      const dy = was.top - here.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(was.width - here.width) < 1 && Math.abs(was.height - here.height) < 1) return;
      element.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${was.width / here.width}, ${was.height / here.height})`, transformOrigin: '0 0' },
          { transform: 'none', transformOrigin: '0 0' },
        ],
        { duration: 300, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.12)' },
      );
    });
    boxes.current = next;
  });

  /** The place and spot under the pointer, on this board. */
  const spotAt = (x: number, y: number, item: T): Spot<T> | null => {
    const root = board.current;
    if (!root || typeof document.elementsFromPoint !== 'function') return null;
    const zoneElement = document
      .elementsFromPoint(x, y)
      .map((element) => element.closest<HTMLElement>('[data-board-zone]'))
      .find((element): element is HTMLElement => !!element && root.contains(element));
    if (!zoneElement) return null;
    const zone = zoneElement.dataset.boardZone!;
    const items = [...zoneElement.querySelectorAll<HTMLElement>('[data-board-item]')].filter((element) => element.dataset.boardItem !== item);
    if (items.length === 0) return { zone, index: 0, over: null };
    const centre = (element: HTMLElement) => {
      const box = element.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    };
    let nearest = items[0]!;
    let best = Infinity;
    for (const element of items) {
      const c = centre(element);
      const far = (c.x - x) ** 2 + (c.y - y) ** 2;
      if (far < best) {
        best = far;
        nearest = element;
      }
    }
    const c = centre(nearest);
    const size = sizeOf(zone);
    let after: boolean;
    if (size === 'ring') {
      // Clockwise past it.
      const ring = zoneElement.getBoundingClientRect();
      const cx = ring.left + ring.width / 2;
      const cy = ring.top + ring.height / 2;
      const turn = Math.atan2(y - cy, x - cx) - Math.atan2(c.y - cy, c.x - cx);
      after = Math.sin(turn) > 0;
    } else if (size === 'row' || size === 'card') {
      after = y > c.y;
    } else {
      after = dir === 'rtl' ? x < c.x : x > c.x;
    }
    return { zone, index: items.indexOf(nearest) + (after ? 1 : 0), over: nearest.dataset.boardItem as T };
  };

  const grab = (event: ReactPointerEvent<HTMLElement>, item: T) => {
    if (event.button !== 0 || !board.current) return;
    board.current.setPointerCapture(event.pointerId);
    setDrag({ item, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false, base: all, shown: all });
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const moved = drag.moved || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 5;
    if (!moved) return;
    const spot = spotAt(event.clientX, event.clientY, drag.item);
    const next = spot ? placeItem(drag.base, drag.item, spot, maxOf) : drag.shown;
    setDrag({ ...drag, x: event.clientX, y: event.clientY, moved, shown: drag.moved && same(next, drag.shown) ? drag.shown : next });
    if (!drag.moved) setHeld(null);
  };
  const drop = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    if (board.current?.hasPointerCapture(event.pointerId)) board.current.releasePointerCapture(event.pointerId);
    setDrag(null);
    if (!drag.moved) return;
    // A drag ends with no click.
    skipClick.current = true;
    window.setTimeout(() => (skipClick.current = false), 0);
    if (event.type !== 'pointercancel') commit(drag.shown, drag.item);
  };

  /** A tap: pick it up; on another, the two change places; on itself, put it down. */
  const tap = (item: T) => {
    if (skipClick.current) return;
    if (held === null) return setHeld(item);
    if (held !== item) commit(swapItems(all, held, item), held);
    setHeld(null);
  };
  /** A tap on a place's free room with one picked up: it goes to the end there. */
  const tapZone = (zone: string) => {
    if (held === null || zoneOf(all, held) === zone) return;
    commit(placeItem(all, held, { zone, index: Infinity, over: null }, maxOf), held);
    setHeld(null);
  };
  const keys = (event: ReactKeyboardEvent, item: T) => {
    const zone = zoneOf(all, item);
    const at = all[zone]!.indexOf(item);
    const earlier = dir === 'rtl' ? ['ArrowUp', 'ArrowRight'] : ['ArrowUp', 'ArrowLeft'];
    const later = dir === 'rtl' ? ['ArrowDown', 'ArrowLeft'] : ['ArrowDown', 'ArrowRight'];
    if (earlier.includes(event.key) && at > 0) {
      event.preventDefault();
      commit(placeItem(all, item, { zone, index: at - 1, over: null }, maxOf), item);
    } else if (later.includes(event.key) && at < all[zone]!.length - 1) {
      event.preventDefault();
      commit(placeItem(all, item, { zone, index: at + 1, over: null }, maxOf), item);
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && hidden && zone !== TRAY) {
      event.preventDefault();
      commit(placeItem(all, item, { zone: TRAY, index: Infinity, over: null }, maxOf), item);
    } else if (event.key === 'Escape') {
      setHeld(null);
    }
  };

  const item = (one: T, zone: string, at: number, of: number) => {
    const face = look(one);
    const size = sizeOf(zone);
    const classes = ['board-item', `board-item-${size}`, drag?.moved && drag.item === one ? 'is-dragged' : '', held === one ? 'is-held' : ''].filter(Boolean).join(' ');
    const style = size === 'ring' ? ringPlace(at, of) : undefined;
    return (
      <button
        key={one}
        type="button"
        className={classes}
        style={style}
        data-board-item={one}
        title={face.note ?? face.word}
        aria-pressed={held === one}
        aria-label={t('board.item', { name: face.word, place: labelOf(zone), at: at + 1, of })}
        onPointerDown={(event) => grab(event, one)}
        onClick={(event) => {
          event.stopPropagation();
          tap(one);
        }}
        onKeyDown={(event) => keys(event, one)}
      >
        <ItemFace look={face} size={size} />
      </button>
    );
  };

  const zone = (z: BoardZone | { id: string; label: string; size: BoardSize; max?: number }, caption = true) => {
    const items = shown[z.id] ?? [];
    const over = drag?.moved && zoneOf(drag.shown, drag.item) === z.id;
    return (
      <div key={z.id} className={['board-place', `board-place-${z.size}`, over ? 'is-over' : '', held !== null && zoneOf(all, held) !== z.id ? 'is-open' : ''].filter(Boolean).join(' ')}>
        {caption ? (
          <span className="board-place-label">
            {z.label}
            {z.max !== undefined ? <span className="board-place-count">{`${items.length}/${z.max}`}</span> : null}
          </span>
        ) : null}
        <div className={`board-zone board-zone-${z.size}`} data-board-zone={z.id} onClick={() => tapZone(z.id)}>
          {items.map((one, at) => item(one, z.id, at, items.length))}
          {items.length === 0 ? <span className="board-zone-empty">{t('board.empty')}</span> : null}
          {z.size === 'ring' ? <ZoodMark size={34} className="board-ring-mark" /> : null}
        </div>
      </div>
    );
  };

  const ghost = drag?.moved ? (
    <div className={`board-ghost board-item board-item-${sizeOf(zoneOf(drag.shown, drag.item))}`} style={{ left: drag.x, top: drag.y }} dir={dir} aria-hidden="true">
      <ItemFace look={look(drag.item)} size={sizeOf(zoneOf(drag.shown, drag.item))} />
    </div>
  ) : null;

  return (
    <>
      {auto ? <Toggle label={auto.label} hint={auto.hint} checked={auto.on} onChange={auto.onChange} /> : null}
      <Row label={label} hint={hint} labelId={id} stacked>
        <div
          ref={board}
          className={['board', `board-${frame}`, drag?.moved ? 'is-dragging' : '', auto?.on ? 'is-auto' : ''].filter(Boolean).join(' ')}
          role="group"
          aria-labelledby={id}
          onPointerMove={move}
          onPointerUp={drop}
          onPointerCancel={drop}
        >
          <div className={`board-frame board-frame-${frame}`}>
            {frame === 'island' ? <ZoodMark size={16} className="board-island-mark" /> : null}
            {frame === 'menu' ? <span className="board-menu-title">ZOOD PDF</span> : null}
            {zones.map((z) => zone(z, zones.length > 1 || frame === 'island'))}
            {frame === 'chat' ? <span className="board-chat-input">{t('board.chatInput')}</span> : null}
          </div>
          {hidden ? zone({ id: TRAY, label: labelOf(TRAY), size: 'chip' }) : null}
          <span className="board-said" role="status" aria-live="polite">
            {said}
          </span>
        </div>
      </Row>
      {ghost && typeof document !== 'undefined' ? createPortal(ghost, document.body) : null}
    </>
  );
}

/** A slot's place on the ring, clockwise from the top. */
function ringPlace(at: number, of: number) {
  const turn = (at / Math.max(1, of)) * 2 * Math.PI - Math.PI / 2;
  return { left: `${50 + 38 * Math.cos(turn)}%`, top: `${50 + 38 * Math.sin(turn)}%` };
}
