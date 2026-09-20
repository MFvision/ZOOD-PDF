import { describe, expect, it } from 'vitest';
import { settledNumber, typedNumber } from './stepperValue';

/** The values a field from `min` to `max` passes on as `keys` are typed one by one. */
function typing(keys: string, min: number, max: number): (number | null)[] {
  return [...keys].map((_, k) => typedNumber(keys.slice(0, k + 1), min, max));
}

describe('a number field as it is typed', () => {
  it('lets 12 be typed into a field that starts at 5', () => {
    // "1" is not yet a size: nothing goes on, and "12" does.
    expect(typing('12', 5, 72)).toEqual([null, 12]);
    expect(typing('20', 5, 100)).toEqual([null, 20]);
  });

  it('lets a negative angle be typed', () => {
    expect(typing('-45', -180, 180)).toEqual([null, -4, -45]);
  });

  it('passes nothing on for an empty field, and settles back when it is left so', () => {
    expect(typedNumber('', 0, 10)).toBeNull();
    expect(settledNumber('', 7, 0, 10)).toBe(7);
    expect(settledNumber('-', 7, 0, 10)).toBe(7);
  });

  it('settles a number out of range to the nearest end', () => {
    expect(typedNumber('3', 5, 72)).toBeNull();
    expect(settledNumber('3', 12, 5, 72)).toBe(5);
    expect(settledNumber('900', 12, 5, 72)).toBe(72);
    expect(settledNumber('40', 12, 5, 72)).toBe(40);
  });
});
