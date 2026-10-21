/**
 * When Ask ZOOD stops listening by itself after a tap: the person spoke and
 * then went quiet, or never spoke at all. Read from the loudness the host
 * sends about every 60 ms (`src-tauri/src/ask/ear.rs`, 0..1, speech near
 * 0.3); a second tap or Done stops it sooner.
 */

/** Louder than this is the person speaking, not the room. */
export const SPEAKING = 0.14;
/** Quiet this long after speaking: they are done. */
export const QUIET_AFTER_MS = 1600;
/** Nothing said this long after the tap: they changed their mind. */
export const NOTHING_SAID_MS = 8000;

export interface QuietWatch {
  started: number;
  /** When the voice was last loud, or null before it ever was. */
  lastLoud: number | null;
}

export const watchQuiet = (now: number): QuietWatch => ({ started: now, lastLoud: null });

/** One reading at `now` (ms); true when listening should end. */
export function quietEnough(watch: QuietWatch, now: number, level: number): boolean {
  if (level >= SPEAKING) watch.lastLoud = now;
  if (watch.lastLoud === null) return now - watch.started >= NOTHING_SAID_MS;
  return now - watch.lastLoud >= QUIET_AFTER_MS;
}

/** How many bars the island's listening line has. */
export const BARS = 24;

/** The line's heights: the newest loudness on the right, eased so it moves like a voice, not a meter. */
export function pushLevel(bars: readonly number[], level: number): number[] {
  const shaped = Math.min(1, Math.sqrt(Math.max(0, level)) * 1.15);
  const next = [...bars, shaped];
  return next.length > BARS ? next.slice(next.length - BARS) : next;
}
