import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import ar from '../i18n/ar.json';
import { newChapters, newSince, tourChapters } from './chapters';

describe('welcome tour', () => {
  it('shows the quick tools and the phone remote only in the desktop app', () => {
    expect(tourChapters(false).map((c) => c.id)).toEqual(['welcome', 'look', 'film', 'basics', 'folders', 'ai', 'support', 'done']);
    expect(tourChapters(true).map((c) => c.id)).toEqual(['welcome', 'look', 'film', 'basics', 'folders', 'quick', 'reach', 'remote', 'ai', 'support', 'done']);
  });

  it('teaches Ask ZOOD only where it is in the build', () => {
    expect(tourChapters(true, true).map((c) => c.id)).toEqual(['welcome', 'look', 'film', 'basics', 'folders', 'quick', 'ask', 'quickask', 'reach', 'remote', 'ai', 'support', 'done']);
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
    // Versions 9 to 11 brought Always ready, the phone app's code and Folders; Folders comes first, everywhere.
    expect(newSince(8, true)).toBe('folders');
    expect(newSince(9, true)).toBe('folders');
    expect(newSince(10, false)).toBe('folders');
    expect(newSince(10, true, false)).toBe('folders');
  });

  it('after an update shows only the chapters that are new here', () => {
    // Never seen, or seen before Ask ZOOD: the whole tour.
    expect(newChapters(0, true, true)).toBeNull();
    expect(newChapters(1, false, false)).toBeNull();
    expect(newChapters(10, true, true)).toEqual(['folders']);
    expect(newChapters(9, true, true)).toEqual(['folders', 'remote']);
    expect(newChapters(8, true, true)).toEqual(['folders', 'reach', 'remote']);
    expect(newChapters(6, true, true)).toEqual(['folders', 'reach', 'remote', 'ai', 'support']);
    expect(newChapters(4, true, true)).toEqual(['folders', 'ask', 'quickask', 'reach', 'remote', 'ai', 'support']);
    expect(newChapters(6, false, false)).toEqual(['folders', 'ai', 'support']);
    // On the web a tour seen at 11 has nothing new: it does not open.
    expect(newChapters(11, false, false)).toEqual([]);
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
