import { comboOf, normalizeKeys } from '../shell/shortcutEcho';
import type { KeyLike } from '../shell/shortcutEcho';
import type { TapKey } from './settings';

/**
 * Ask ZOOD's keys as the page sees them, for the welcome tour's practice:
 * the same taps the host watches for (`src-tauri/src/ask/tap.rs`), read
 * from the page's own key events while the host is paused, and the keys to
 * hold, matched as the settings write them.
 */

/** The longest press that is still a tap, as the host has it. */
export const LONGEST_PRESS_MS = 350;
/** A second press this soon after the first one ended makes a double tap. */
export const BETWEEN_MS = 380;

/** The tap key's `KeyboardEvent.code`: right Ctrl, or right Command on a Mac. */
export function tapKeyCode(key: TapKey, mac: boolean): string {
  switch (key) {
    case 'right-alt':
      return 'AltRight';
    case 'right-shift':
      return 'ShiftRight';
    default:
      return mac ? 'MetaRight' : 'ControlRight';
  }
}

/** Codes that are not "something else pressed" while the tap key is down: AltGr sends left Ctrl with right Alt. */
export function ignoredWith(key: TapKey, mac: boolean): readonly string[] {
  return key === 'right-alt' && !mac ? ['ControlLeft'] : [];
}

export type Tap = 'once' | 'twice';

export interface Tapper {
  down: number | null;
  spoiled: boolean;
  first: number | null;
  swallow: boolean;
}

export const freshTapper = (): Tapper => ({ down: null, spoiled: false, first: null, swallow: false });

/**
 * One reading of the keys at `now` (ms): is the tap key down, is anything
 * else down. The host's `Tapper::step`, line for line, so practising here
 * behaves as the real thing does.
 */
export function stepTap(state: Tapper, now: number, key: boolean, other: boolean): Tap | null {
  if (state.down === null && key) {
    state.down = now;
    state.spoiled = other;
    if (!other && state.first !== null && now - state.first <= BETWEEN_MS) {
      state.first = null;
      state.swallow = true;
      return 'twice';
    }
    if (other) state.first = null;
    return null;
  }
  if (state.down !== null && key) {
    if (other) {
      state.spoiled = true;
      state.first = null;
    }
    return null;
  }
  if (state.down !== null && !key) {
    const tapped = !state.spoiled && !other && now - state.down <= LONGEST_PRESS_MS;
    state.down = null;
    const swallowed = state.swallow;
    state.swallow = false;
    state.first = swallowed || !tapped ? null : now;
    return null;
  }
  if (other) {
    state.first = null;
    return null;
  }
  if (state.first !== null && now - state.first > BETWEEN_MS) {
    state.first = null;
    return 'once';
  }
  return null;
}

/** Whether a keydown is the keys to hold (`Mod+Shift+Space`), on this platform. */
export function isHoldKeys(event: KeyLike, shortcut: string, apple: boolean): boolean {
  return comboOf(event, apple) === normalizeKeys(shortcut);
}
