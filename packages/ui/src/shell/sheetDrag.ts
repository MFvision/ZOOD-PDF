import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * The phone's inspector sheet follows its grabber, as a system sheet does: it
 * moves with the finger from where it was taken, resists being pulled up past
 * its top, and on release it goes where the finger was sending it — carried
 * on by its speed, closed if that passes half its height, else back to rest —
 * on a spring that starts at the finger's speed and can be taken hold of
 * again mid-flight. A review had found the grabber drawn but not draggable.
 *
 * With reduced motion it still follows the finger, but lands without
 * travelling: closed, or back at rest, at once.
 */

/** Below this width the inspector is a sheet from the bottom edge (panes.css). */
export const SHEET_QUERY = '(width <= 700px)';

export interface Sample {
  /** Milliseconds (the event's timeStamp). */
  t: number;
  /** The sheet's offset from rest, in pixels, down positive. */
  y: number;
}

/**
 * How far a release at `velocity` (px/s) carries on, as scrolling slows down
 * (`deceleration` per millisecond; 0.998 is the system's normal rate).
 */
export function project(velocity: number, deceleration = 0.998): number {
  return ((velocity / 1000) * deceleration) / (1 - deceleration);
}

/** How far the sheet moves when pulled `overshoot` pixels past its top: less and less the further it goes. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** Samples older than this before the last one say nothing about the release. */
const VELOCITY_WINDOW_MS = 100;
/** A finger held this long before lifting has no speed. */
const STILL_MS = 60;

/** The finger's speed at release, in px/s, from its last moments of movement. */
export function releaseVelocity(samples: readonly Sample[], now: number): number {
  const last = samples.at(-1);
  if (!last || now - last.t > STILL_MS) return 0;
  const first = samples.find((sample) => sample.t >= last.t - VELOCITY_WINDOW_MS);
  if (!first || last.t - first.t <= 0) return 0;
  return ((last.y - first.y) / (last.t - first.t)) * 1000;
}

/** Moving back up faster than this, the person means to keep the sheet. */
const UPWARD = -100;

/** Where a release at `offset` (px from rest) and `velocity` (px/s) sends the sheet. */
export function sheetOutcome(offset: number, velocity: number, height: number): 'dismiss' | 'stay' {
  if (velocity < UPWARD) return 'stay';
  return offset + project(velocity) > height / 2 ? 'dismiss' : 'stay';
}

export interface Spring {
  /** 1 settles without overshoot; below it, passes its rest and comes back. */
  dampingRatio: number;
  /** Roughly how long it takes to get there, in seconds (not a duration). */
  response: number;
}

/** One step of a spring towards `target`: position and velocity after `dt` seconds. */
export function springStep(
  state: { x: number; v: number },
  target: number,
  dt: number,
  { dampingRatio, response }: Spring,
): { x: number; v: number } {
  const stiffness = (2 * Math.PI / response) ** 2;
  const damping = (4 * Math.PI * dampingRatio) / response;
  let { x, v } = state;
  // Small substeps keep a stiff spring stable at any frame rate.
  const steps = Math.max(1, Math.ceil(dt / 0.004));
  const h = dt / steps;
  for (let i = 0; i < steps; i += 1) {
    v += (-stiffness * (x - target) - damping * v) * h;
    x += v * h;
  }
  return { x, v };
}

/** A sheet thrown back to rest overshoots a little; one closing, or set down, does not. */
const THROWN: Spring = { dampingRatio: 0.8, response: 0.3 };
const SET_DOWN: Spring = { dampingRatio: 1, response: 0.3 };
/** Moving faster than this at release is a throw. */
const THROW = 300;
/** Movement before a press on the header becomes a drag, so a tap stays a tap. */
const SLOP = 6;

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

interface Drag {
  pointer: number;
  startY: number;
  base: number;
  moved: boolean;
  samples: Sample[];
}

/**
 * Drag handlers for the sheet's grabber and header. `sheet` is the element
 * that moves; `onDismiss` closes it once it has gone.
 */
export function useSheetDrag(onDismiss: () => void) {
  const sheet = useRef<HTMLElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const offset = useRef(0);
  const frame = useRef(0);
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const place = useCallback((y: number) => {
    offset.current = y;
    const element = sheet.current;
    if (element) element.style.transform = Math.abs(y) < 0.01 ? '' : `translateY(${y}px)`;
  }, []);

  const settle = useCallback((target: number, velocity: number, spring: Spring, then?: () => void) => {
    let state = { x: offset.current, v: velocity };
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.064, Math.max(0, (now - last) / 1000));
      last = now;
      state = springStep(state, target, dt, spring);
      if (Math.abs(state.x - target) < 0.5 && Math.abs(state.v) < 20) {
        place(target);
        then?.();
        return;
      }
      place(state.x);
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, [place]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!globalThis.matchMedia?.(SHEET_QUERY).matches || event.button !== 0) return;
    // The header's buttons stay buttons.
    if ((event.target as Element).closest('button, a, input, select, textarea')) return;
    // Taken hold of mid-flight: it stops where it is, and follows from there.
    cancelAnimationFrame(frame.current);
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointer: event.pointerId,
      startY: event.clientY,
      base: offset.current,
      moved: false,
      samples: [{ t: event.timeStamp, y: offset.current }],
    };
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const travel = event.clientY - current.startY;
    if (!current.moved && Math.abs(travel) < SLOP) return;
    current.moved = true;
    const height = sheet.current?.getBoundingClientRect().height ?? 1;
    const wanted = current.base + travel;
    place(wanted < 0 ? -rubberband(-wanted, height) : wanted);
    current.samples.push({ t: event.timeStamp, y: offset.current });
    if (current.samples.length > 12) current.samples.shift();
  }, [place]);

  const onPointerEnd = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    if (!current.moved && offset.current === 0) return;
    const height = sheet.current?.getBoundingClientRect().height ?? 1;
    const velocity = event.type === 'pointercancel' ? 0 : releaseVelocity(current.samples, event.timeStamp);
    const outcome = sheetOutcome(offset.current, velocity, height);
    if (reducedMotion()) {
      if (outcome === 'dismiss') dismissRef.current();
      place(0);
      return;
    }
    if (outcome === 'dismiss') {
      // Out the way it came in, at the finger's speed, then closed.
      settle(height, Math.max(velocity, 0), SET_DOWN, () => dismissRef.current());
      return;
    }
    settle(0, velocity, Math.abs(velocity) > THROW ? THROWN : SET_DOWN);
  }, [place, settle]);

  return {
    sheet,
    handlers: { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd },
  };
}
