import { describe, expect, it } from 'vitest';
import { describeDate } from './dates';

const words = (key: string, params: { time: string }) => `${key.split('.').pop()} ${params.time}`;

describe('a recent file’s date', () => {
  // 2026-09-25 09:41 local time.
  const now = new Date(2026, 8, 25, 9, 41).getTime();

  it('says today and yesterday with the time, then the date', () => {
    expect(describeDate(now - 5 * 60_000, 'en', words, now)).toMatch(/^today 9:36/);
    expect(describeDate(new Date(2026, 8, 24, 16, 2).getTime(), 'en', words, now)).toMatch(/^yesterday 4:02/);
    expect(describeDate(new Date(2026, 8, 1).getTime(), 'en', words, now)).toBe('Sep 1');
    expect(describeDate(new Date(2025, 11, 31).getTime(), 'en', words, now)).toBe('Dec 31, 2025');
  });

  it('writes Arabic-Indic digits in Arabic', () => {
    expect(describeDate(now, 'ar', words, now)).toMatch(/^today [٠-٩]/);
    expect(describeDate(new Date(2026, 8, 1).getTime(), 'ar', words, now)).toMatch(/[٠-٩]/);
  });
});
