import { useEffect, useRef, useState } from 'react';
import './bubble.css';
import { ZoodMark } from '../components/ZoodMark';
import { invokeHost, isTauriHost, onHostEvent } from '../core/host-tauri';
import { applyAppearance } from '../settings/SettingsEffects';
import { I18nProvider } from '../i18n/I18nProvider';
import { useT } from '../i18n/useT';

/** True in the ZOOD bubble's own window (`src-tauri/src/presence.rs`). */
export function isAskBubbleWindow(): boolean {
  if (!isTauriHost()) return false;
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').has('askbubble');
  } catch {
    return false;
  }
}

/** How far the pointer moves before a press is a drag, not a click. */
const DRAG_FROM = 4;

/**
 * The ZOOD bubble: a round button with ZOOD's mark at the edge of the
 * screen, above every window. A click starts Ask ZOOD (as a tap of its
 * key); a drag moves it, and the host keeps where it was left. It glows
 * while Ask ZOOD listens. It never takes the keyboard, so the app in front
 * stays the one Ask ZOOD helps with.
 */
export function AskBubbleApp() {
  return (
    <I18nProvider>
      <AskBubble />
    </I18nProvider>
  );
}

function AskBubble() {
  const t = useT();
  const [listening, setListening] = useState(false);
  const pressed = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('ask-bubble-page');
    applyAppearance(root);
    const stops = [
      onHostEvent<unknown>('ask://listen', () => setListening(true)),
      onHostEvent<unknown>('ask://heard', () => setListening(false)),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, []);

  return (
    <button
      type="button"
      className={listening ? 'ask-bubble is-listening' : 'ask-bubble'}
      aria-label={t('ask.bubble')}
      title={t('ask.bubble')}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        pressed.current = { x: event.screenX, y: event.screenY };
      }}
      onPointerMove={(event) => {
        const from = pressed.current;
        if (!from) return;
        if (Math.hypot(event.screenX - from.x, event.screenY - from.y) < DRAG_FROM) return;
        pressed.current = null;
        void invokeHost('plugin:window|start_dragging', { label: 'ask-bubble' }).catch(() => undefined);
      }}
      onPointerUp={() => {
        if (!pressed.current) return;
        pressed.current = null;
        void invokeHost('presence_ask').catch(() => undefined);
      }}
    >
      <ZoodMark size={34} />
    </button>
  );
}
