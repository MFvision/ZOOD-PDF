import { describe, expect, it } from 'vitest';
import { tesseractLangs, wordsFromPage } from './recognizer';

describe('recognizer helpers', () => {
  it('maps interface languages to tesseract codes in a stable order', () => {
    expect(tesseractLangs(['en', 'ar'])).toBe('ara+eng');
    expect(tesseractLangs(['ur', 'fa'])).toBe('fas+urd');
    expect(tesseractLangs([])).toBe('eng');
  });

  it('flattens blocks into words with line numbers and drops empty or degenerate boxes', () => {
    const word = (text: string, x0: number, x1: number, confidence = 90) => ({ text, confidence, bbox: { x0, y0: 10, x1, y1: 40 } });
    const page = {
      blocks: [
        {
          paragraphs: [
            { lines: [{ words: [word('التحول', 300, 400), word('  ', 200, 290), word('الرقمي', 150, 280)] }, { words: [word('Report', 10, 90), word('bad', 50, 50)] }] },
          ],
        },
      ],
    } as unknown as Parameters<typeof wordsFromPage>[0];
    expect(wordsFromPage(page)).toEqual([
      { text: 'التحول', bbox: [300, 10, 400, 40], conf: 90, line: 0 },
      { text: 'الرقمي', bbox: [150, 10, 280, 40], conf: 90, line: 0 },
      { text: 'Report', bbox: [10, 10, 90, 40], conf: 90, line: 1 },
    ]);
  });
});
