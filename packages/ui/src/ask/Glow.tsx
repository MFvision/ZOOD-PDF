import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import './glow.css';
import { useReducedMotion } from '../components/useReducedMotion';
import { announceReady, isTauriHost, onHostEvent } from '../core/host-tauri';
import { applyAppearance } from '../settings/SettingsEffects';

/** True in the window that glows round the screen while Ask ZOOD listens. */
export function isAskGlowWindow(): boolean {
  if (!isTauriHost()) return false;
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').has('askglow');
  } catch {
    return false;
  }
}

/**
 * The glow itself: a band of ZOOD's bronze and gold that runs round the
 * edges, and a haze inside it that swells with the voice (`level`, 0..1).
 * Fills its nearest positioned parent: the whole screen in the glow
 * window, a pretend screen in the welcome tour. With Reduce Motion the
 * band stays still and only the haze answers the voice.
 */
export function GlowEdges({ level, on = true }: { level: number; on?: boolean }) {
  const reduced = useReducedMotion();
  return (
    <div
      className={['ask-glow', on ? 'is-on' : '', reduced ? 'is-still' : '']
        .filter(Boolean)
        .join(' ')}
      style={{ '--level': Math.max(0, Math.min(1, level)).toFixed(3) } as CSSProperties}
      aria-hidden="true"
    >
      <div className="ask-glow-haze" />
      <div className="ask-glow-band">
        <div className="ask-glow-spin" />
      </div>
    </div>
  );
}

/**
 * The glow window: it covers the screen the person is on, lets every click
 * through, and is shown and hidden by the host (`src-tauri/src/ask/mod.rs`,
 * `show_glow`), which sends it how loud the person is.
 */
export function AskGlowApp() {
  // The host makes this window the first time it shows it, before the page
  // can hear that it is on.
  const [on, setOn] = useState(true);
  const [level, setLevel] = useState(0);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('ask-glow-page');
    applyAppearance(root);
    const stops = [
      onHostEvent<boolean>('ask://listen', (listening) => {
        setLevel(0);
        setOn(listening);
      }),
      onHostEvent<number>('ask://level', (value) =>
        setLevel((before) => before * 0.5 + value * 0.5),
      ),
      announceReady(),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);

  return <GlowEdges level={level} on={on} />;
}
