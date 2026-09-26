import { describe, expect, it } from 'vitest';
import type { TextLineData } from '../core/types';
import { languageOf, pageText, sentenceBoxes, splitSentences } from './sentences';

const line = (text: string, y: number, direction: 'ltr' | 'rtl' = 'ltr'): TextLineData => ({ text, x: 100, y, width: 200, height: 12, direction });

describe('splitSentences', () => {
  it('cuts at full stops, Arabic question marks and blank lines, keeping offsets into the text', () => {
    const text = 'صباح الخير. كيف حالك؟\nبخير\n\nHello world. Fine!';
    const sentences = splitSentences(text);
    expect(sentences.map((s) => s.text)).toEqual(['صباح الخير.', 'كيف حالك؟', 'بخير', 'Hello world.', 'Fine!']);
    for (const s of sentences) expect(text.slice(s.start, s.end)).toBe(s.text);
    expect(sentences.map((s) => s.lang)).toEqual(['ar', 'ar', 'ar', 'en', 'en']);
  });

  it('keeps a decimal number and a closing quote with its sentence', () => {
    expect(splitSentences('It cost 3.5 million. "Really?" Yes.').map((s) => s.text)).toEqual(['It cost 3.5 million.', '"Really?"', 'Yes.']);
  });

  it('cuts a run-on page at spaces', () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const pieces = splitSentences(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.text.length).toBeLessThanOrEqual(400);
    expect(pieces.map((p) => p.text).join(' ')).toBe(text);
  });

  it('reads an empty page as nothing', () => {
    expect(splitSentences('  \n ')).toEqual([]);
  });
});

describe('languageOf', () => {
  it('follows the script with more letters', () => {
    expect(languageOf('فاتورة رقم 12 for Ahmad')).toBe('ar');
    expect(languageOf('Invoice no. ١٢ (نهائي)')).toBe('en');
    expect(languageOf('12 345')).toBe('other');
  });
});

describe('sentenceBoxes', () => {
  const lines = [line('Hello world. Fine', 10), line('again.', 30), line('مرحبا بكم. شكرا', 50, 'rtl')];
  const text = pageText(lines);

  it('covers the stretch of each line a sentence takes, by its characters', () => {
    const [first, second, third] = splitSentences(text);
    expect(sentenceBoxes(lines, first!)).toEqual([{ x: 100, y: 10, width: 200 * (12 / 17), height: 12 }]);
    // "Fine again." runs from the end of line one onto line two.
    const boxes = sentenceBoxes(lines, second!);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.x).toBeCloseTo(100 + 200 * (13 / 17));
    expect(boxes[1]).toEqual({ x: 100, y: 30, width: 200, height: 12 });
    // An Arabic line is covered from its right: the first sentence's box ends at the line's right edge.
    const arabic = sentenceBoxes(lines, third!)[0]!;
    expect(arabic.x + arabic.width).toBeCloseTo(300);
    expect(arabic.width).toBeCloseTo(200 * (10 / 15));
  });
});
