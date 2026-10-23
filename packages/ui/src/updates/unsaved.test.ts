import { describe, expect, it } from 'vitest';
import type { DocTab } from '../state/tabs';
import { unsavedHere } from './unsaved';

const tab = (key: number, edited: boolean): DocTab => ({ key, name: `${key}.pdf`, size: 1, parked: null, page: 1, edited, save: null });

describe('unsavedHere', () => {
  it('counts edited parked tabs and the live one by its own edits', () => {
    const tabs = [tab(1, true), tab(2, false), tab(3, false)];
    expect(unsavedHere(tabs, 3, true)).toBe(2);
    expect(unsavedHere(tabs, 3, false)).toBe(1);
    expect(unsavedHere(tabs, 1, false)).toBe(1);
    expect(unsavedHere([], null, false)).toBe(0);
  });
});
