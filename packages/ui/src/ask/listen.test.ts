import { describe, expect, it } from 'vitest';
import { BARS, NOTHING_SAID_MS, pushLevel, QUIET_AFTER_MS, quietEnough, watchQuiet } from './listen';

describe('listening after a tap', () => {
  it('keeps listening while the person speaks, with pauses between words', () => {
    const watch = watchQuiet(0);
    expect(quietEnough(watch, 300, 0.4)).toBe(false);
    expect(quietEnough(watch, 900, 0.02)).toBe(false);
    expect(quietEnough(watch, 1200, 0.3)).toBe(false);
    expect(quietEnough(watch, 1200 + QUIET_AFTER_MS - 60, 0.01)).toBe(false);
  });

  it('stops once they have been quiet a moment after speaking', () => {
    const watch = watchQuiet(0);
    quietEnough(watch, 500, 0.5);
    expect(quietEnough(watch, 500 + QUIET_AFTER_MS, 0.03)).toBe(true);
  });

  it('waits longer for someone who has not started yet, then stops', () => {
    const watch = watchQuiet(1000);
    expect(quietEnough(watch, 1000 + QUIET_AFTER_MS * 2, 0.02)).toBe(false);
    expect(quietEnough(watch, 1000 + NOTHING_SAID_MS, 0.02)).toBe(true);
  });

  it('keeps the line to its length, newest last', () => {
    let bars: number[] = [];
    for (let i = 0; i < BARS + 5; i += 1) bars = pushLevel(bars, i === BARS + 4 ? 1 : 0);
    expect(bars).toHaveLength(BARS);
    expect(bars.at(-1)).toBe(1);
    expect(bars[0]).toBe(0);
  });
});
