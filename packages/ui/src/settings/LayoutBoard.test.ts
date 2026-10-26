import { describe, expect, it } from 'vitest';
import { placeItem, swapItems } from './LayoutBoard';

describe('arranging by dragging', () => {
  const places = { big: ['web', 'send', 'print'], small: ['jpg', 'pdf'], tray: ['txt'] };
  const max = (zone: string) => (zone === 'big' ? 3 : undefined);

  it('moves within a place', () => {
    expect(placeItem(places, 'print', { zone: 'big', index: 0, over: 'web' }, max).big).toEqual(['print', 'web', 'send']);
  });
  it('moves into another place at the spot', () => {
    expect(placeItem(places, 'txt', { zone: 'small', index: 1, over: 'pdf' }, max)).toEqual({ big: ['web', 'send', 'print'], small: ['jpg', 'txt', 'pdf'], tray: [] });
  });
  it('swaps with the one it lands on when the place is full', () => {
    expect(placeItem(places, 'pdf', { zone: 'big', index: 1, over: 'send' }, max)).toEqual({ big: ['web', 'pdf', 'print'], small: ['jpg', 'send'], tray: ['txt'] });
  });
  it('swaps two wherever they are', () => {
    expect(swapItems(places, 'web', 'txt')).toEqual({ big: ['txt', 'send', 'print'], small: ['jpg', 'pdf'], tray: ['web'] });
  });
  it('leaves everything as it was for one it does not know', () => {
    expect(placeItem(places, 'docx', { zone: 'big', index: 0, over: null }, max)).toBe(places);
  });
});
