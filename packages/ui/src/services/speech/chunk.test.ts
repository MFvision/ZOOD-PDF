import { describe, expect, it } from 'vitest';
import { chunkText, MAX_CHUNK } from './chunk';

describe('sentence chunking', () => {
  it('splits at sentence ends in Arabic and English, keeping the punctuation', () => {
    expect(chunkText('First one. Second one! Third?')).toEqual(['First one.', 'Second one!', 'Third?']);
    expect(chunkText('هل قرأت العقد؟ نعم، قرأته. شكرًا')).toEqual(['هل قرأت العقد؟', 'نعم، قرأته.', 'شكرًا']);
  });

  it('does not split decimals, versions or dotted numbers', () => {
    expect(chunkText('The rate is 3.5 percent and v2.1 ships.')).toEqual(['The rate is 3.5 percent and v2.1 ships.']);
  });

  it('breaks a long sentence at clause marks, then at spaces, never above the limit', () => {
    const clause = 'كلمة '.repeat(30).trim();
    const long = `${clause}، ${clause}، ${clause}`;
    const parts = chunkText(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(MAX_CHUNK);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long);

    const words = 'word '.repeat(120).trim();
    const w = chunkText(words);
    for (const p of w) expect(p.length).toBeLessThanOrEqual(MAX_CHUNK);
    expect(w.join(' ')).toBe(words);
  });

  it('hard-cuts a single enormous token and drops empty input', () => {
    const blob = 'x'.repeat(450);
    const parts = chunkText(blob);
    expect(parts.join('')).toBe(blob);
    expect(Math.max(...parts.map((p) => p.length))).toBeLessThanOrEqual(MAX_CHUNK);
    expect(chunkText('   ')).toEqual([]);
  });
});
