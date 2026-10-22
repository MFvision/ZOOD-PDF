import { useEffect, useState } from 'react';
import './ask.css';
import { prefersReducedMotion } from '../components/useReducedMotion';
import { invokeHost, isTauriHost, onHostEvent } from '../core/host-tauri';

/** The point the host sends (`src-tauri/src/ask/mod.rs`, `ask_point`): 0..1 across and down the screen. */
interface Point {
  x: number;
  y: number;
  label: string;
  /** ZOOD's pointer, guiding step by step, rather than a ring. */
  guide?: boolean;
}

/** Where the pointer starts its first flight: the island, at the top middle. */
const FROM_ISLAND = { x: 0.5, y: 0 };

/** True in Ask ZOOD's pointer window. */
export function isAskPointWindow(): boolean {
  if (!isTauriHost()) return false;
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').has('askpoint');
  } catch {
    return false;
  }
}

/**
 * Where to click next: a ring that pulses over the place on the screen the
 * model chose, with what to do there. The window covers the screen the
 * question was asked on and lets every click through; the host hides it.
 */
export function AskPointApp() {
  const [point, setPoint] = useState<(Point & { key: number }) | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('ask-point-page');
    let key = 0;
    const take = (next: Point | null) => {
      if (next) setPoint({ ...next, key: (key += 1) });
    };
    const stop = onHostEvent<Point>('ask://point', take);
    void invokeHost('ask_point_last').then((next) => take(next as Point | null), () => undefined);
    return stop;
  }, []);

  if (!point) return null;
  if (point.guide) return <GuidePointer point={point} />;
  // The label sits below the ring, or above it near the bottom of the screen.
  const below = point.y < 0.8;
  return (
    <div key={point.key} className="ask-point" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }} aria-hidden="true">
      <span className="ask-point-ring" />
      <span className="ask-point-ring ask-point-ring-late" />
      <span className="ask-point-dot" />
      {point.label && (
        <span className={`ask-point-label ${below ? 'ask-point-below' : 'ask-point-above'}`} dir="auto">
          {point.label}
        </span>
      )}
    </div>
  );
}

/**
 * ZOOD's own pointer: a bronze arrow that flies out of the island to each
 * step — from the last one after that — lands with a ripple, and shows what
 * to do there. Its tip is the place. With Reduce Motion it moves at once.
 */
function GuidePointer({ point }: { point: Point & { key: number } }) {
  const [at, setAt] = useState(FROM_ISLAND);
  useEffect(() => {
    // One frame at the start place first, so the move is seen.
    const frame = requestAnimationFrame(() => setAt({ x: point.x, y: point.y }));
    return () => cancelAnimationFrame(frame);
  }, [point.x, point.y, point.key]);
  const still = prefersReducedMotion();
  const here = still ? { x: point.x, y: point.y } : at;
  const below = point.y < 0.78;
  // The words go to the side with room.
  const side = point.x > 0.7 ? 'ask-guide-left' : 'ask-guide-right';
  return (
    <div
      className={still ? 'ask-pointer is-still' : 'ask-pointer'}
      style={{ left: `${here.x * 100}%`, top: `${here.y * 100}%` }}
      aria-hidden="true"
    >
      <span key={point.key} className="ask-guide-ripple" />
      <svg className="ask-guide-arrow" viewBox="0 0 28 34" width="28" height="34">
        <path d="M2 2 L2 27 L8.6 21.2 L13 31.5 L18 29.3 L13.6 19.2 L22.5 19.2 Z" />
      </svg>
      {point.label && (
        <span key={`label-${point.key}`} className={`ask-guide-label ${side} ${below ? 'is-below' : 'is-above'}`} dir="auto">
          {point.label}
        </span>
      )}
    </div>
  );
}
