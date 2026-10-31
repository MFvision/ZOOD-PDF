import { describe, expect, it } from 'vitest';
import {
  SHEET_GAP,
  SHEET_LINE,
  SHEET_MARGIN,
  buildSheet,
  detectSize,
  detectorInput,
  doubtful,
  flattenLine,
  mergeEnglish,
  readingOrder,
  regionsOf,
  scaleBoxes,
  sheetLine,
  toPage,
  toPgm,
} from './lines';
import type { Box, GreyLine, LineWord } from './lines';

describe('the detector input', () => {
  it('is the page scaled to at most 1600 on its longest side, in multiples of 32', () => {
    expect(detectSize(2480, 3508)).toEqual({ width: 1120, height: 1600 });
    expect(detectSize(100, 50)).toEqual({ width: 96, height: 64 });
  });

  it('is channels first and normalized as PaddleOCR trained it', () => {
    const input = detectorInput(new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]), 2, 1);
    expect(input.length).toBe(6);
    expect(input[0]).toBeCloseTo((1 - 0.485) / 0.229);
    expect(input[1]).toBeCloseTo((0 - 0.485) / 0.229);
    expect(input[3]).toBeCloseTo((1 - 0.456) / 0.224);
  });
});

describe('regions of the probability map', () => {
  it('finds each line once, grown back to its full height', () => {
    const width = 100;
    const height = 40;
    const prob = new Float32Array(width * height);
    // Two lines' shrunk cores: rows 5..8 and 25..28, columns 10..89.
    for (const top of [5, 25]) for (let y = top; y < top + 4; y += 1) for (let x = 10; x < 90; x += 1) prob[y * width + x] = 0.9;
    const boxes = regionsOf(prob, width, height);
    expect(boxes).toHaveLength(2);
    const [a] = readingOrder(boxes);
    // Grown by area × 1.6 / perimeter: 320 × 1.6 / 168 ≈ 3 px each way.
    expect(a![1]).toBeCloseTo(5 - 3.05, 1);
    expect(a![3]).toBeCloseTo(9 + 3.05, 1);
  });

  it('leaves out specks and faint regions', () => {
    const prob = new Float32Array(50 * 50);
    prob[0] = 0.9;
    for (let y = 10; y < 20; y += 1) for (let x = 10; x < 40; x += 1) prob[y * 50 + x] = 0.35;
    expect(regionsOf(prob, 50, 50)).toEqual([]);
  });

  it('scales boxes back to the page', () => {
    expect(scaleBoxes([[1, 2, 3, 4]], 2, 3)).toEqual([[2, 6, 6, 12]]);
  });
});

describe('reading order', () => {
  it('goes down the page, and right to left along a line for Arabic', () => {
    const right: Box = [60, 10, 90, 30];
    const left: Box = [10, 12, 40, 31];
    const below: Box = [10, 50, 90, 70];
    expect(readingOrder([below, left, right])).toEqual([right, left, below]);
    expect(readingOrder([below, left, right], false)).toEqual([left, right, below]);
  });
});

describe('evening out a line', () => {
  it('turns shaded paper white and keeps the ink dark', () => {
    const width = 60;
    const height = 10;
    const data = new Uint8Array(width * height);
    // Paper going from 120 (in shadow) to 150, a stroke of ink at half the paper's brightness.
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const paper = 120 + 0.5 * x;
        data[y * width + x] = y >= 4 && y < 6 ? paper / 2 : paper;
      }
    const line: GreyLine = { width, height, data };
    flattenLine(line);
    for (let x = 0; x < width; x += 1) {
      expect(data[x]).toBeGreaterThan(225);
      expect(data[5 * width + x]).toBeLessThan(140);
    }
  });
});

describe('the sheet', () => {
  const page: GreyLine = { width: 200, height: 100, data: new Uint8Array(200 * 100).fill(200) };
  const boxes: Box[] = [
    [20, 10, 180, 30],
    [50, 60, 150, 90],
  ];

  it('stacks the lines at one height, right-aligned, with white between them', () => {
    const { sheet, placements } = buildSheet(page, boxes);
    expect(placements).toHaveLength(2);
    expect(sheet.height).toBe(2 * SHEET_MARGIN + 2 * (SHEET_LINE + SHEET_GAP));
    expect(placements[0]!.scale).toBeCloseTo(SHEET_LINE / 20);
    // Right-aligned: both lines end at the same place.
    expect(placements[0]!.x + placements[0]!.width).toBe(placements[1]!.x + placements[1]!.width);
    // The gap is white; the evened-out page is white too.
    expect(sheet.data[0]).toBe(255);
  });

  it('puts a word read off the sheet back where it was on the page', () => {
    const { placements } = buildSheet(page, boxes);
    const second = placements[1]!;
    const word: Box = [second.x + 10 * second.scale, second.y + 5, second.x + 40 * second.scale, second.y + 30];
    expect(sheetLine(word)).toBe(1);
    const back = toPage(word, placements)!;
    expect(back[0]).toBeCloseTo(60);
    expect(back[2]).toBeCloseTo(90);
    expect([back[1], back[3]]).toEqual([60, 90]);
  });

  it('is handed to Tesseract as a PGM', () => {
    const pgm = toPgm({ width: 2, height: 1, data: new Uint8Array([0, 255]) });
    expect(new TextDecoder().decode(pgm.subarray(0, 11))).toBe('P5\n2 1\n255\n');
    expect([...pgm.subarray(11)]).toEqual([0, 255]);
  });
});

describe('English where Arabic failed', () => {
  const w = (text: string, x0: number, x1: number, confidence: number, line = 0): LineWord => ({
    text,
    box: [x0, 0, x1, 10],
    confidence,
    line,
  });

  it('doubts the shape of English read as Arabic, not Arabic read well', () => {
    expect(doubtful(w('فاتورة', 0, 10, 92))).toBe(false);
    expect(doubtful(w('2026-0042-/ل/|', 0, 10, 12))).toBe(true);
    expect(doubtful(w('(500011', 0, 10, 15))).toBe(true);
    expect(doubtful(w('الماضذي', 0, 10, 40))).toBe(false);
  });

  it('puts confident English in place of the doubtful words it covers, and nowhere else', () => {
    const arabic = [w('رقم', 80, 100, 95), w('2026-0042-/ل/|', 10, 70, 12), w('شكرا', 80, 100, 92, 1)];
    const english = [w('INV-2026-0042', 12, 72, 92), w('gull', 80, 100, 95, 1), w('YoY', 0, 5, 21)];
    expect(mergeEnglish(arabic, english).map((x) => x.text)).toEqual(['رقم', 'INV-2026-0042', 'شكرا']);
  });
});
