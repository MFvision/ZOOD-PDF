import { describe, expect, it } from 'vitest';
import ar from './ar.json';
import en from './en.json';
import { detectLanguage, interpolate } from './messages';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n dictionaries', () => {
  it('have identical key sets', () => {
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
  });

  it('have no empty values', () => {
    for (const [key, value] of Object.entries({ ...en, ...ar })) {
      expect(typeof value, key).toBe('string');
      expect(value.trim().length, `empty value for ${key}`).toBeGreaterThan(0);
    }
  });

  it('use the same placeholders in both languages', () => {
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(placeholders(ar[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it('never mention the competitor brand', () => {
    for (const value of [...Object.values(en), ...Object.values(ar)]) {
      expect(value.toLowerCase()).not.toMatch(/acrobat|adobe/);
    }
  });
});

describe('language helpers', () => {
  it('defaults to Arabic for ar-* browsers and English otherwise', () => {
    expect(detectLanguage('ar-SA', null)).toBe('ar');
    expect(detectLanguage('AR', null)).toBe('ar');
    expect(detectLanguage('en-US', null)).toBe('en');
    expect(detectLanguage(undefined, null)).toBe('en');
    expect(detectLanguage('en-US', 'ar')).toBe('ar');
  });

  it('interpolates placeholders', () => {
    expect(interpolate('Page {current} of {total}', { current: 2, total: 9 })).toBe('Page 2 of 9');
    expect(interpolate('{missing}', {})).toBe('{missing}');
  });
});
