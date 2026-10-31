import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { buildSheet, detectSize, detectorInput, doubtful, mergeEnglish, readingOrder, regionsOf, scaleBoxes, sheetLine, toPage, toPgm } from './lines';
import type { Box, GreyLine, LineWord, Placement } from './lines';

/**
 * The line-by-line reading (`lines.ts`, as `engine.ts` runs it) measured in
 * Node on a folder of pages with their true text — opt-in and slow:
 *
 *   WARRAQ_OCR_BENCH=/path/to/bench pnpm --filter @warraq/ui exec vitest run src/ocr/lines.measure.test.ts
 *
 * The folder holds `bench/<name>/*.pgm` (grey pages, about 300 dpi) and
 * `truth/<name>.txt`. Each page is read twice, the way the app reads it now
 * and the way it read before (Tesseract on the whole page, Arabic and
 * English together), and scored as the share of the truth's words read
 * (letters normalized: alef forms, yaa, taa marbuta, no diacritics). The
 * scores are written to `<folder>/lines-measure.tsv`.
 */

const BENCH = process.env.WARRAQ_OCR_BENCH;
const root = fileURLToPath(new URL('../../', import.meta.url));

function readPgm(path: string): GreyLine {
  const bytes = readFileSync(path);
  // "P5\nW H\n255\n"
  let at = 0;
  const fields: string[] = [];
  while (fields.length < 4) {
    while (/\s/.test(String.fromCharCode(bytes[at]!))) at += 1;
    let field = '';
    while (!/\s/.test(String.fromCharCode(bytes[at]!))) field += String.fromCharCode(bytes[at++]!);
    fields.push(field);
  }
  at += 1;
  const width = Number(fields[1]);
  const height = Number(fields[2]);
  return { width, height, data: new Uint8Array(bytes.subarray(at, at + width * height)) };
}

function norm(text: string): string[] {
  return text
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function recall(truth: string, read: string): number {
  const want = new Map<string, number>();
  for (const w of norm(truth)) want.set(w, (want.get(w) ?? 0) + 1);
  let total = 0;
  for (const n of want.values()) total += n;
  let hit = 0;
  for (const w of norm(read)) {
    const n = want.get(w) ?? 0;
    if (n > 0) {
      hit += 1;
      want.set(w, n - 1);
    }
  }
  return hit / Math.max(1, total);
}

/** The page scaled to the detector's size (box filter), as RGBA. */
function shrink(page: GreyLine, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor((y * page.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * page.height) / height));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor((x * page.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * page.width) / width));
      let sum = 0;
      for (let yy = y0; yy < y1; yy += 1) for (let xx = x0; xx < x1; xx += 1) sum += page.data[yy * page.width + xx]!;
      const v = sum / ((y1 - y0) * (x1 - x0));
      out.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  return out;
}

interface TessWord { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }
interface TessData { blocks?: { paragraphs: { lines: { words: TessWord[] }[] }[] }[] | null; text: string }

function wordsOf(data: TessData, placements: readonly Placement[], lines: readonly number[]): LineWord[] {
  const out: LineWord[] = [];
  for (const block of data.blocks ?? [])
    for (const paragraph of block.paragraphs)
      for (const line of paragraph.lines)
        for (const word of line.words) {
          const bbox: Box = [word.bbox.x0, word.bbox.y0, word.bbox.x1, word.bbox.y1];
          const box = toPage(bbox, placements);
          const k = sheetLine(bbox);
          if (!box || lines[k] === undefined || !word.text.trim()) continue;
          out.push({ text: word.text.trim(), box, confidence: word.confidence, line: lines[k]! });
        }
  return out;
}

describe.skipIf(!BENCH)('reading line by line, measured', () => {
  it('reads every page of the bench both ways', { timeout: 3_600_000 }, async () => {
    const ort = await import('onnxruntime-web');
    const { createWorker, OEM, PSM } = await import('tesseract.js');
    const net = await ort.InferenceSession.create(readFileSync(`${root}models/ppocrv5-mobile-det.onnx`));
    const langPath = `${BENCH}/tessdata`;
    // `tessdata/` holds the models the app ships now, `tessdata_before/` the ones it shipped (gzipped, as served).
    const arabic = await createWorker(['ara'], OEM.LSTM_ONLY, { langPath, gzip: true, cacheMethod: 'none' });
    const english = await createWorker(['eng'], OEM.LSTM_ONLY, { langPath, gzip: true, cacheMethod: 'none' });
    const before = await createWorker(['ara', 'eng'], OEM.LSTM_ONLY, { langPath: `${BENCH}/tessdata_before`, gzip: true, cacheMethod: 'none' });
    const rows: string[] = ['name\tbefore\tafter\tms'];
    for (const name of readdirSync(`${BENCH}/bench`).sort()) {
      const truth = readFileSync(`${BENCH}/truth/${name}.txt`, 'utf8');
      let readNow = '';
      let readThen = '';
      const started = Date.now();
      for (const file of readdirSync(`${BENCH}/bench/${name}`).filter((f) => f.endsWith('.pgm')).sort()) {
        const page = readPgm(`${BENCH}/bench/${name}/${file}`);
        const size = detectSize(page.width, page.height);
        const input = new ort.Tensor('float32', detectorInput(shrink(page, size.width, size.height), size.width, size.height), [1, 3, size.height, size.width]);
        const output = await net.run({ [net.inputNames[0]!]: input });
        const map = output[net.outputNames[0]!]!;
        const boxes = readingOrder(scaleBoxes(regionsOf(map.data as Float32Array, size.width, size.height), page.width / size.width, page.height / size.height));
        const { sheet, placements } = buildSheet(page, boxes);
        await arabic.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_COLUMN });
        const all = placements.map((_, k) => k);
        const first = await arabic.recognize(Buffer.from(toPgm(sheet)), {}, { blocks: true });
        let words = wordsOf(first.data as unknown as TessData, placements, all);
        const doubted = [...new Set(words.filter(doubtful).map((w) => w.line))].sort((a, b) => a - b);
        if (doubted.length > 0) {
          const again = buildSheet(page, doubted.map((k) => placements[k]!.box));
          await english.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_COLUMN });
          const second = await english.recognize(Buffer.from(toPgm(again.sheet)), {}, { blocks: true });
          words = mergeEnglish(words, wordsOf(second.data as unknown as TessData, again.placements, doubted));
        }
        const old = await before.recognize(Buffer.from(toPgm(page)), {}, { blocks: true });
        readThen += old.data.text + '\n';
        // As `engine.ts`: a page read with little confidence line by line is read whole too, the better kept.
        const mean = words.length ? words.reduce((s, w) => s + w.confidence, 0) / words.length : 0;
        const weight = (list: { confidence: number }[]) => list.reduce((s, w) => s + Math.max(0, w.confidence), 0);
        const oldWords = (old.data as unknown as TessData).blocks?.flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words))) ?? [];
        const whole = mean < 60 && weight(oldWords) > weight(words);
        console.log(`${name}/${file}: line-by-line ${Math.round(mean)} % sure${whole ? ', read whole' : ''}`);
        readNow += (whole ? old.data.text : words.map((w) => w.text).join(' ')) + '\n';
      }
      rows.push(`${name}\t${recall(truth, readThen).toFixed(3)}\t${recall(truth, readNow).toFixed(3)}\t${Date.now() - started}`);
      console.log(rows[rows.length - 1]);
    }
    writeFileSync(`${BENCH}/lines-measure.tsv`, rows.join('\n') + '\n');
    await Promise.all([arabic.terminate(), english.terminate(), before.terminate()]);
  });
});
