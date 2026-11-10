import { describe, expect, it } from 'vitest';
import { AUTO_SIDE_FROM, AUTO_SIDE_MIN_WIDTH, tabPlace } from './tabPlace';

describe('where the tabs are', () => {
  it('keeps a chosen place whatever the count', () => {
    expect(tabPlace('side', 1, 400)).toBe('side');
    expect(tabPlace('toolbar', 12, 2000)).toBe('toolbar');
  });

  it('with Auto, goes down the side only once there are many and the window has room', () => {
    expect(tabPlace('auto', AUTO_SIDE_FROM - 1, 2000)).toBe('top');
    expect(tabPlace('auto', AUTO_SIDE_FROM, AUTO_SIDE_MIN_WIDTH)).toBe('side');
    expect(tabPlace('auto', 12, AUTO_SIDE_MIN_WIDTH - 1)).toBe('top');
  });
});
