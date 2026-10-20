import { useEffect, useState } from 'react';
import { File as FileIcon, FileText, ImageIcon } from 'lucide-react';
import { invokeHost, isTauriHost, onHostEvent } from '../core/host-tauri';
import './arrival.css';

/** What the host sends as a flicked file lands (`src-tauri/src/arrival.rs`). */
interface Arrived {
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
 * A file flicked from the phone, arriving: a soft light sweeps up the
 * screen and the file flies in from below to settle at the Desktop's
 * corner (where Windows and macOS put new files), with its name. The window
 * is transparent and lets clicks through; the host hides it after.
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
  const mac = /Mac/i.test(navigator.platform || navigator.userAgent);
  const Icon = arrived.kind === 'pdf' ? FileText : arrived.kind === 'picture' ? ImageIcon : FileIcon;
  return (
    <div key={arrived.key} className={`arrival arrival-${mac ? 'end' : 'start'}`} aria-hidden="true">
      <div className="arrival-sweep" />
      <div className="arrival-file">
        <div className="arrival-face">{arrived.picture ? <img src={arrived.picture} alt="" /> : <Icon />}</div>
        <span className="arrival-name" dir="auto">
          {arrived.name}
        </span>
      </div>
    </div>
  );
}
