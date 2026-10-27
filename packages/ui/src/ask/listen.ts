/**
 * When Ask ZOOD stops listening by itself after a tap: the person spoke and
 * then went quiet, or never spoke at all. Read from the loudness the host
 * sends about every 60 ms (`src-tauri/src/ask/ear.rs`, 0..1, speech near
 * 0.3); a second tap or Done stops it sooner.
 *
 * A pause to think is not the end: quiet must last `QUIET_AFTER_MS` — and
 * longer while only a few words have been said, when people stop to find
 * the next. "Speaking" is measured against the room: a quiet microphone or
 * a soft voice counts once it is clearly above the room's own level.
 */

/** Louder than this is always the person speaking, not the room. */
export const SPEAKING = 0.14;
/** Never taken for speaking, however quiet the room. */
export const FLOOR = 0.03;
/** Quiet this long after speaking: they are done. */
export const QUIET_AFTER_MS = 2400;
/** Quiet this long after only a short start: still thinking what to ask. */
export const QUIET_AFTER_START_MS = 3500;
/** Speaking for less than this is a short start. */
export const SHORT_START_MS = 1500;
/** Nothing said this long after the tap: they changed their mind. */
export const NOTHING_SAID_MS = 8000;

export interface QuietWatch {
  started: number;
  /** When the voice was last loud, or null before it ever was. */
  lastLoud: number | null;
  /** How long the voice has been loud, in all. */
  spokenMs: number;
  /** The room's level, slowly followed while nobody speaks. */
  room: number;
  last: number;
}

export const watchQuiet = (now: number): QuietWatch => ({ started: now, lastLoud: null, spokenMs: 0, room: FLOOR / 3, last: now });

/** One reading at `now` (ms); true when listening should end. */
export function quietEnough(watch: QuietWatch, now: number, level: number): boolean {
  const speaking = level >= SPEAKING || (level >= FLOOR && level >= watch.room * 3);
  const step = Math.min(200, Math.max(0, now - watch.last));
  watch.last = now;
  if (speaking) {
    watch.lastLoud = now;
    watch.spokenMs += step;
  } else {
    watch.room = watch.room * 0.9 + level * 0.1;
  }
  if (watch.lastLoud === null) return now - watch.started >= NOTHING_SAID_MS;
  const patience = watch.spokenMs < SHORT_START_MS ? QUIET_AFTER_START_MS : QUIET_AFTER_MS;
  return now - watch.lastLoud >= patience;
}

/** How many bars the island's listening line has. */
export const BARS = 24;

/** The line's heights: the newest loudness on the right, eased so it moves like a voice, not a meter. */
export function pushLevel(bars: readonly number[], level: number): number[] {
  const shaped = Math.min(1, Math.sqrt(Math.max(0, level)) * 1.15);
  const next = [...bars, shaped];
  return next.length > BARS ? next.slice(next.length - BARS) : next;
}
