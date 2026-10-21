import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import ar from '../i18n/ar.json';
import { tourChapters } from './chapters';

describe('welcome tour', () => {
  it('shows the quick tools and the phone remote only in the desktop app', () => {
    expect(tourChapters(false).map((c) => c.id)).toEqual(['welcome', 'look', 'film', 'basics', 'ai', 'done']);
    expect(tourChapters(true).map((c) => c.id)).toEqual(['welcome', 'look', 'film', 'basics', 'quick', 'remote', 'ai', 'done']);
  });

  it('has every chapter in both languages', () => {
    const keys = tourChapters(true).flatMap((c) => [c.label, c.title, c.body]);
    for (const key of keys) {
      expect((en as Record<string, string>)[key], key).toBeTruthy();
      expect((ar as Record<string, string>)[key], key).toBeTruthy();
    }
  });

  it('opens at the quick tools from Settings', () => {
    // Settings › Quick tools › Show me how opens the tour at this id.
    expect(tourChapters(true).some((c) => c.id === 'quick')).toBe(true);
  });
});
