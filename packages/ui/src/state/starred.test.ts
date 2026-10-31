import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearStarred, isStarred, readStarred, starId, toggleStarred, unstar } from './starred';

/** A `localStorage` for the node test environment. */
function installStorage(): Map<string, string> {
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (name: string) => items.get(name) ?? null,
      setItem: (name: string, value: string) => void items.set(name, value),
      removeItem: (name: string) => void items.delete(name),
    },
  });
  return items;
}

describe('starred documents', () => {
  let items: Map<string, string>;
  beforeEach(() => {
    items = installStorage();
    clearStarred();
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('stars and unstars by id, newest first, and remembers on this device', () => {
    const a = { id: starId('recent', 'a.pdf'), name: 'a.pdf', source: 'recent' as const };
    const b = { id: starId('library', 'dir1/b.pdf'), name: 'b.pdf', source: 'library' as const };
    expect(toggleStarred(a)).toBe(true);
    expect(toggleStarred(b)).toBe(true);
    expect(readStarred().map((item) => item.id)).toEqual([b.id, a.id]);
    expect(isStarred(a.id)).toBe(true);
    expect(JSON.parse(items.get('warraq.starred') ?? '[]')).toHaveLength(2);
    expect(toggleStarred(a)).toBe(false);
    expect(isStarred(a.id)).toBe(false);
    unstar(b.id);
    expect(readStarred()).toEqual([]);
  });

  it('ignores anything in storage that is not a star', () => {
    items.set(
      'warraq.starred',
      JSON.stringify([
        { id: 'recent:x.pdf', name: 'x.pdf', source: 'recent' },
        { id: 'evil', source: 'recent' },
        'nope',
        { id: 'library:k', name: 'k', source: 'other' },
      ]),
    );
    expect(readStarred()).toEqual([{ id: 'recent:x.pdf', name: 'x.pdf', source: 'recent' }]);
  });
  it('keeps a star made in another tab of the app when this one stars too', () => {
    const a = { id: starId('recent', 'a.pdf'), name: 'a.pdf', source: 'recent' as const };
    const b = { id: starId('recent', 'b.pdf'), name: 'b.pdf', source: 'recent' as const };
    expect(readStarred()).toEqual([]);
    // The other tab stars a.pdf: it writes the same key, this tab's memory is not told.
    items.set('warraq.starred', JSON.stringify([a]));
    toggleStarred(b);
    expect(readStarred().map((one) => one.id)).toEqual([b.id, a.id]);
    expect(JSON.parse(items.get('warraq.starred') ?? '[]')).toHaveLength(2);
  });

  it('keeps stars in memory when storage refuses the write', () => {
    const a = { id: starId('recent', 'a.pdf'), name: 'a.pdf', source: 'recent' as const };
    const storage = globalThis.localStorage as unknown as { setItem: () => void };
    storage.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    expect(toggleStarred(a)).toBe(true);
    expect(isStarred(a.id)).toBe(true);
  });
});
