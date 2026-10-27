import { describe, expect, it } from 'vitest';
import {
  BARS,
  NOTHING_SAID_MS,
  pushLevel,
  QUIET_AFTER_MS,
  QUIET_AFTER_START_MS,
  quietEnough,
  watchQuiet,
} from './listen';
import type { QuietWatch } from './listen';

/** The person speaks at `level` from `from` to `to` (ms), read every 60 ms. */
function speak(watch: QuietWatch, from: number, to: number, level = 0.4): void {
  for (let now = from; now <= to; now += 60) quietEnough(watch, now, level);
}

describe('listening after a tap', () => {
  it('keeps listening while the person speaks, with pauses between words', () => {
    const watch = watchQuiet(0);
    expect(quietEnough(watch, 300, 0.4)).toBe(false);
    expect(quietEnough(watch, 900, 0.01)).toBe(false);
    expect(quietEnough(watch, 1200, 0.3)).toBe(false);
    expect(quietEnough(watch, 1200 + QUIET_AFTER_MS - 60, 0.01)).toBe(false);
  });

  it('stops once they have been quiet a moment after speaking', () => {
    const watch = watchQuiet(0);
    speak(watch, 0, 3000);
    expect(quietEnough(watch, 3000 + QUIET_AFTER_MS - 60, 0.01)).toBe(false);
    expect(quietEnough(watch, 3000 + QUIET_AFTER_MS, 0.01)).toBe(true);
  });

  it('waits longer to think after only a few words', () => {
    const watch = watchQuiet(0);
    speak(watch, 0, 600);
    expect(quietEnough(watch, 600 + QUIET_AFTER_MS, 0.01)).toBe(false);
    expect(quietEnough(watch, 600 + QUIET_AFTER_START_MS, 0.01)).toBe(true);
  });

  it("hears a soft voice in a quiet room, and not the room's steady hum", () => {
    const soft = watchQuiet(0);
    for (let now = 0; now < 2000; now += 60) quietEnough(soft, now, 0.005);
    speak(soft, 2000, 4000, 0.05);
    expect(soft.lastLoud).toBe(3980);
    const hum = watchQuiet(0);
    for (let now = 0; now < 4000; now += 60) quietEnough(hum, now, 0.025);
    expect(hum.lastLoud).toBeNull();
  });

  it('waits longer for someone who has not started yet, then stops', () => {
    const watch = watchQuiet(1000);
    expect(quietEnough(watch, 1000 + QUIET_AFTER_MS * 2, 0.01)).toBe(false);
    expect(quietEnough(watch, 1000 + NOTHING_SAID_MS, 0.01)).toBe(true);
  });

  it('keeps the line to its length, newest last', () => {
    let bars: number[] = [];
    for (let i = 0; i < BARS + 5; i += 1) bars = pushLevel(bars, i === BARS + 4 ? 1 : 0);
    expect(bars).toHaveLength(BARS);
    expect(bars.at(-1)).toBe(1);
    expect(bars[0]).toBe(0);
  });
});
