import { describe, expect, it } from 'vitest';
import { formatRanges, normalizeDigits, parseRanges } from './ranges';

describe('page ranges', () => {
  it('parses Latin ranges into 0-based inclusive pairs', () => {
    expect(parseRanges('1-3, 5', 9)).toEqual({ ok: true, ranges: [[0, 2], [4, 4]] });
    expect(parseRanges(' 7 ', 9)).toEqual({ ok: true, ranges: [[6, 6]] });
    expect(parseRanges('2–4;6—9', 9)).toEqual({ ok: true, ranges: [[1, 3], [5, 8]] });
  });

  it('accepts Arabic-Indic and Persian digits with the Arabic comma', () => {
    expect(normalizeDigits('١-٣، ٥')).toBe('1-3, 5');
    expect(parseRanges('١-٣، ٥', 9)).toEqual({ ok: true, ranges: [[0, 2], [4, 4]] });
    expect(parseRanges('۲-۴', 9)).toEqual({ ok: true, ranges: [[1, 3]] });
    expect(parseRanges('٨-', 9)).toEqual({ ok: true, ranges: [[7, 8]] });
  });

  it('open-ended ranges run to the end or from the start', () => {
    expect(parseRanges('4-', 6)).toEqual({ ok: true, ranges: [[3, 5]] });
    expect(parseRanges('-2', 6)).toEqual({ ok: true, ranges: [[0, 1]] });
  });

  it('rejects empty, reversed, zero and out-of-range input with a reason', () => {
    expect(parseRanges('', 5)).toEqual({ ok: false, reason: 'empty' });
    expect(parseRanges('3-1', 5)).toEqual({ ok: false, reason: 'reversed', token: '3-1' });
    expect(parseRanges('0', 5)).toEqual({ ok: false, reason: 'outOfRange', token: '0' });
    expect(parseRanges('2, 6', 5)).toEqual({ ok: false, reason: 'outOfRange', token: '6' });
    expect(parseRanges('a-b', 5)).toEqual({ ok: false, reason: 'syntax', token: 'a-b' });
    expect(parseRanges('1-2-3', 5)).toEqual({ ok: false, reason: 'syntax', token: '1-2-3' });
  });

  it('bounds hostile input', () => {
    const many = Array.from({ length: 5000 }, (_, i) => String((i % 5) + 1)).join(',');
    expect(parseRanges(many, 5)).toEqual({ ok: false, reason: 'tooMany' });
    expect(parseRanges('9'.repeat(400), 5)).toEqual({ ok: false, reason: 'outOfRange', token: '9'.repeat(400) });
  });

  it('formats selections compactly (for suggested names and labels)', () => {
    expect(formatRanges([0, 1, 2, 4, 6, 7])).toBe('1-3,5,7-8');
    expect(formatRanges([])).toBe('');
  });
});
