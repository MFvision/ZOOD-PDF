import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import ar from '../i18n/ar.json';
import { newSince, tourChapters } from './chapters';

describe('welcome tour', () => {
  it('shows the quick tools and the phone remote only in the desktop app', () => {
    expect(tourChapters(false).map((c) => c.id)).toEqual(['welcome', 'look', 'film', 'basics', 'ai', 'support', 'done']);
    expect(tourChapters(true).map((c) => c.id)).toEqual(['welcome', 'look', 'film', 'basics', 'quick', 'reach', 'remote', 'ai', 'support', 'done']);
  });

  it('teaches Ask ZOOD only where it is in the build', () => {
    expect(tourChapters(true, true).map((c) => c.id)).toEqual(['welcome', 'look', 'film', 'basics', 'quick', 'ask', 'quickask', 'reach', 'remote', 'ai', 'support', 'done']);
    expect(tourChapters(false, true).map((c) => c.id)).not.toContain('ask');
  });

  it('opens a tour seen before at what is new', () => {
    expect(newSince(0, true)).toBe('welcome');
    expect(newSince(2, true)).toBe('ask');
    expect(newSince(3, true)).toBe('ask');
    expect(newSince(4, true)).toBe('ask');
    expect(newSince(5, true)).toBe('quickask');
    expect(newSince(2, false)).toBe('welcome');
    // Version 7 brought Help & Support, and version 8 the AI's chat and its commands, which comes first.
    expect(newSince(6, true)).toBe('ai');
    expect(newSince(7, true)).toBe('ai');
    expect(newSince(7, false)).toBe('ai');
    // Version 9 brought Always ready: the tray, the bubble and Do it for me by ZOOD's own commands (the desktop's).
    expect(newSince(8, true)).toBe('reach');
    expect(newSince(8, true, false)).toBe('welcome');
  });

  it('has every chapter in both languages', () => {
    const keys = tourChapters(true, true).flatMap((c) => [c.label, c.title, c.body]);
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
