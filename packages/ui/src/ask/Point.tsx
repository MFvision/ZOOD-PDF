import { useEffect, useState } from 'react';
import './ask.css';
import { invokeHost, isTauriHost, onHostEvent } from '../core/host-tauri';

/** The point the host sends (`src-tauri/src/ask/mod.rs`, `ask_point`): 0..1 across and down the screen. */
interface Point {
  x: number;
  y: number;
  label: string;
}

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
