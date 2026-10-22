import { describe, expect, it } from 'vitest';
import { freshTapper, isHoldKeys, stepTap, tapKeyCode } from './keys';
import type { Tap } from './keys';

/** Plays `[ms, key down, other down]` readings, as the host's tests do. */
function play(readings: [number, boolean, boolean][]): [number, Tap][] {
  const state = freshTapper();
  const taps: [number, Tap][] = [];
  for (const [ms, key, other] of readings) {
    const tap = stepTap(state, ms, key, other);
    if (tap) taps.push([ms, tap]);
  }
  return taps;
}

describe('the practice taps match the host', () => {
  it('two quick taps are a double tap at the second press', () => {
    expect(
      play([
        [0, true, false],
        [90, false, false],
        [200, true, false],
        [280, false, false],
        [900, false, false],
      ]),
    ).toEqual([[200, 'twice']]);
  });

  it('one tap is known once the wait for a second has passed', () => {
    expect(
      play([
        [0, true, false],
        [90, false, false],
        [300, false, false],
        [480, false, false],
      ]),
    ).toEqual([[480, 'once']]);
  });

  it('a shortcut with the key is not a tap', () => {
    expect(
      play([
        [0, true, false],
        [40, true, true],
        [80, true, false],
        [120, false, false],
        [900, false, false],
      ]),
    ).toEqual([]);
  });

  it('a long press is not a tap', () => {
    expect(
      play([
        [0, true, false],
        [600, false, false],
        [1400, false, false],
      ]),
    ).toEqual([]);
  });

  it('three taps are one double tap and one tap', () => {
    expect(
      play([
        [0, true, false],
        [80, false, false],
        [160, true, false],
        [240, false, false],
        [320, true, false],
        [400, false, false],
        [1000, false, false],
      ]),
    ).toEqual([
      [160, 'twice'],
      [1000, 'once'],
    ]);
  });
});

describe('the keys', () => {
  it('names the right-hand key for each computer', () => {
    expect(tapKeyCode('right-main', false)).toBe('ControlRight');
    expect(tapKeyCode('right-main', true)).toBe('MetaRight');
    expect(tapKeyCode('right-shift', true)).toBe('ShiftRight');
  });

  it('matches the keys to hold', () => {
    const space = { key: ' ', code: 'Space', shiftKey: true, altKey: false };
    expect(isHoldKeys({ ...space, ctrlKey: true, metaKey: false }, 'Mod+Shift+Space', false)).toBe(true);
    expect(isHoldKeys({ ...space, ctrlKey: false, metaKey: true }, 'Mod+Shift+Space', true)).toBe(true);
    expect(isHoldKeys({ ...space, shiftKey: false, ctrlKey: true, metaKey: false }, 'Mod+Shift+Space', false)).toBe(false);
  });
});
