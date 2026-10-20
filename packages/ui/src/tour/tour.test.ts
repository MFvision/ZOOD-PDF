import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import ar from '../i18n/ar.json';
import { tourScreens } from './Tour';

describe('welcome tour', () => {
  it('shows the quick tools only in the desktop app, in the platform’s words', () => {
    expect(tourScreens(false, false).map((s) => s.id)).toEqual(['welcome', 'tools', 'tabs', 'looks', 'ai', 'across']);
    expect(tourScreens(true, false).at(-1)?.points[0]).toBe('tour.quick.p1Windows');
    expect(tourScreens(true, true).at(-1)?.points[0]).toBe('tour.quick.p1Mac');
    expect(tourScreens(false, true).find((s) => s.id === 'looks')?.points[0]).toBe('tour.looks.p1Mac');
  });

  it('has every line in both languages', () => {
    const keys = [...tourScreens(true, false), ...tourScreens(true, true)].flatMap((s) => [s.title, s.body, ...s.points]);
    for (const key of keys) {
      expect((en as Record<string, string>)[key], key).toBeTruthy();
      expect((ar as Record<string, string>)[key], key).toBeTruthy();
    }
  });
});
