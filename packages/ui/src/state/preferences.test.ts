import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJson, readPreferences, writeJson, writePreferences } from './preferences';

/** A page's `localStorage`, in memory. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

describe('values kept on the device survive anything stored under their key', () => {
  let had: PropertyDescriptor | undefined;
  beforeEach(() => {
    had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: fakeStorage() });
  });
  afterEach(() => {
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('gives the fallback for a stored null, so reading a field of it cannot throw', () => {
    // `"null"` in warraq.fontLibrary once left the whole web app a white page:
    // `readJson(KEY, {}).allowed` read a field of null while the app loaded.
    localStorage.setItem('k', 'null');
    expect(readJson<{ allowed?: boolean }>('k', {})).toEqual({});
    expect(() => readJson<{ allowed?: boolean }>('k', {}).allowed).not.toThrow();
    expect(readJson<unknown[]>('k', [])).toEqual([]);
  });

  it('gives the fallback for a value of another shape', () => {
    localStorage.setItem('list', '[1,2]');
    localStorage.setItem('object', '{"a":1}');
    localStorage.setItem('number', '42');
    localStorage.setItem('text', '"hi"');
    expect(readJson('list', {})).toEqual({});
    expect(readJson('object', [])).toEqual([]);
    expect(readJson('number', {})).toEqual({});
    expect(readJson('text', false)).toBe(false);
    expect(readJson('object', '')).toBe('');
  });

  it('keeps a value of the same shape, and any value when the fallback is null', () => {
    writeJson('object', { a: 1 });
    writeJson('list', ['x']);
    writeJson('text', 'pages');
    expect(readJson('object', {})).toEqual({ a: 1 });
    expect(readJson('list', [])).toEqual(['x']);
    expect(readJson('text', '')).toBe('pages');
    expect(readJson('text', null)).toBe('pages');
    expect(readJson('list', null)).toEqual(['x']);
  });

  it('gives the fallback for broken JSON and missing keys', () => {
    localStorage.setItem('bad', '{not json');
    expect(readJson('bad', { ok: true })).toEqual({ ok: true });
    expect(readJson('missing', 7)).toBe(7);
  });

  it('keeps preferences sane over a stored null or list, and writes over them', () => {
    localStorage.setItem('warraq.preferences', 'null');
    expect(readPreferences().lang).toBeUndefined();
    writePreferences({ lang: 'en' });
    expect(readPreferences().lang).toBe('en');
    localStorage.setItem('warraq.preferences', '["ar"]');
    expect(readPreferences().lang).toBeUndefined();
  });
});

describe('when the browser blocks site data', () => {
  let had: PropertyDescriptor | undefined;
  beforeEach(() => {
    had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
  });
  afterEach(() => {
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('reads fallbacks and writes nothing, without throwing', () => {
    expect(readJson('k', { a: 1 })).toEqual({ a: 1 });
    expect(() => writeJson('k', 1)).not.toThrow();
    expect(readPreferences()).toEqual(expect.any(Object));
  });
});
