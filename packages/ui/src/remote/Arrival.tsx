import { useEffect, useState } from 'react';
import { File as FileIcon, FileText, ImageIcon } from 'lucide-react';
import { invokeHost, isTauriHost, onHostEvent } from '../core/host-tauri';
import './arrival.css';

/** What the host sends as a file moves (`src-tauri/src/arrival.rs`). */
interface Arrived {
  /** `in`: from the phone; `out`: to it. */
  way?: 'in' | 'out';
  /** Where a file going out was, in the page's pixels; the middle without one. */
  from?: { x: number; y: number } | null;
  name: string;
  kind: 'picture' | 'pdf' | 'file';
  picture: string | null;
}

const ARRIVE_EVENT = 'arrival://file';

/** True in the arrival window. */
export function isArrivalWindow(): boolean {
  if (!isTauriHost()) return false;
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').has('arrival');
  } catch {
    return false;
  }
}

/**
 * Files moving between the phone and the PC, seen on the PC's screen. One
 * flicked from the phone: a soft light sweeps up the screen, the file rises
 * from below, is shown large in the middle for a moment, then settles at the
 * Desktop's corner (where Windows and macOS put new files) with its name.
 * One sent to the phone: it lifts where it was and flies off the bottom of
 * the screen, toward the phone, into a burst of light. The window is
 * transparent and lets clicks through; the host hides it after.
 */
export function ArrivalApp() {
  const [arrived, setArrived] = useState<(Arrived & { key: number }) | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('arrival-page');
    let key = 0;
    const take = (file: Arrived | null) => {
      if (file) setArrived({ ...file, key: (key += 1) });
    };
    const stop = onHostEvent<Arrived>(ARRIVE_EVENT, take);
    // The first file can come before this view has loaded.
    void invokeHost('arrival_last').then((file) => take(file as Arrived | null), () => undefined);
    return stop;
  }, []);

  if (!arrived) return null;
  const Icon = arrived.kind === 'pdf' ? FileText : arrived.kind === 'picture' ? ImageIcon : FileIcon;
  const face = <div className="arrival-face">{arrived.picture ? <img src={arrived.picture} alt="" /> : <Icon />}</div>;
  const name = (
    <span className="arrival-name" dir="auto">
      {arrived.name}
    </span>
  );

  if (arrived.way === 'out') {
    const width = globalThis.innerWidth || 1280;
    const height = globalThis.innerHeight || 800;
    const x = arrived.from?.x ?? width / 2;
    const y = arrived.from?.y ?? height / 2;
    // To the bottom edge's middle, and on past it.
    const style = { left: x, top: y, '--depart-x': `${width / 2 - x}px`, '--depart-y': `${height - y + 160}px` } as React.CSSProperties;
    return (
      <div key={arrived.key} className="arrival arrival-out" aria-hidden="true">
        <div className="arrival-flare" />
        <div className="arrival-file" style={style}>
          {face}
          {name}
        </div>
      </div>
    );
  }

  const mac = /Mac/i.test(navigator.platform || navigator.userAgent);
  return (
    <div key={arrived.key} className={`arrival arrival-${mac ? 'end' : 'start'}`} aria-hidden="true">
      <div className="arrival-sweep" />
      <div className="arrival-file">
        {face}
        {name}
      </div>
    </div>
  );
}
