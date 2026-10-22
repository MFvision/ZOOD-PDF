import { describe, expect, it } from 'vitest';
import { wordsToText } from './read';

describe("the window's words", () => {
  it('breaks lines where a word starts lower down', () => {
    const word = (text: string, x: number, y: number, confidence = 90) => ({
      text,
      bbox: [x, y, x + 40, y + 12] as [number, number, number, number],
      confidence,
    });
    expect(
      wordsToText([
        word('Hi ', 0, 0),
        word('Sara', 50, 1),
        word('Can ', 0, 20),
        word('you', 50, 20),
        word('~', 90, 20, 10),
      ]),
    ).toBe('Hi Sara\nCan you');
  });
});
