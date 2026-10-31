import { createWorker, OEM, PSM } from 'tesseract.js';
import workerUrl from 'tesseract.js/dist/worker.min.js?url';
import coreUrl from 'tesseract.js-core/tesseract-core-lstm.wasm.js?url';
import coreSimdUrl from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url';
import { uiLog } from '../core/host-tauri';
import { PAGE_MAX_LINES, buildSheet, detectSize, doubtful, mergeEnglish, readingOrder, scaleBoxes, sheetChunks, sheetLine, toPage, toPgm } from './lines';
import type { Box, GreyLine, LineWord, Placement } from './lines';
import type { DetectAnswer, DetectJob } from './detect.worker';

/**
 * Tesseract (Apache-2.0) in a worker, with everything it needs served from
 * Warraq's own origin: the worker script and the WebAssembly core are bundled
 * assets, and the language models (Google's tessdata "best int", Apache-2.0)
 * are emitted as `ocr/<code>.traineddata.gz` by `vite/ocrModels.ts`. Out of
 * the box tesseract.js fetches all three from jsDelivr; here nothing leaves
 * the device.
 */

export type OcrLanguage = 'ara' | 'eng' | 'fas' | 'urd';

export const OCR_LANGUAGES: readonly OcrLanguage[] = ['ara', 'eng', 'fas', 'urd'];


/** A word as read: its text and its box in the image's pixels. */
export interface ReadWord {
  text: string;
  /** `[x0, y0, x1, y1]`, pixels from the image's top-left corner. */
  bbox: [number, number, number, number];
  confidence: number;
}

/** WebAssembly SIMD, which the faster core needs (Chrome, Safari 16.4 and later). */
export function hasWasmSimd(): boolean {
  try {
    // The smallest module using a SIMD instruction (as wasm-feature-detect checks).
    return WebAssembly.validate(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
    );
  } catch {
    return false;
  }
}

const absolute = (url: string) => new URL(url, globalThis.location?.href ?? '/').href;

export interface Recognizer {
  read(image: HTMLCanvasElement): Promise<ReadWord[]>;
  stop(): Promise<void>;
}

/** Tesseract's page as `read` hands it back: blocks of paragraphs of lines of words. */
interface TessPage {
  blocks?: { paragraphs: { lines: { words: { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[] }[] }[] }[] | null;
}

/** The words of a Tesseract page, line by line, a space after every word but a line's last. */
function wordsOf(data: TessPage, place: (bbox: Box) => Box | null): ReadWord[] {
  const words: ReadWord[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const read = line.words.filter((word) => word.text.trim().length > 0);
        read.forEach((word, k) => {
          const { x0, y0, x1, y1 } = word.bbox;
          const box = place([x0, y0, x1, y1]);
          if (!box) return;
          // Readers find word breaks by the spaces in the text, not the gaps on the page.
          const text = k < read.length - 1 ? `${word.text.trim()} ` : word.text.trim();
          words.push({ text, bbox: box, confidence: word.confidence });
        });
      }
    }
  }
  return words;
}

/**
 * The line finder (`detect.worker.ts`), started once and shared: a worker of
 * its own, the model loaded on first use. `null` where it cannot run (no
 * WebAssembly SIMD, no workers): Tesseract then finds the lines itself.
 */
let finder: { worker: Worker; next: number; waiting: Map<number, (answer: DetectAnswer) => void> } | null = null;
let finderBroken = false;

function lineFinder(): typeof finder {
  if (finder || finderBroken) return finder;
  if (typeof Worker === 'undefined' || !hasWasmSimd()) {
    finderBroken = true;
    return null;
  }
  try {
    const worker = new Worker(new URL('./detect.worker.ts', import.meta.url), { type: 'module', name: 'zood-ocr-lines' });
    const waiting = new Map<number, (answer: DetectAnswer) => void>();
    worker.onmessage = (event: MessageEvent<DetectAnswer>) => {
      waiting.get(event.data.id)?.(event.data);
      waiting.delete(event.data.id);
    };
    worker.onerror = () => {
      for (const done of waiting.values()) done({ id: -1, ok: false, message: 'E_OCR_LINES: the line finder stopped' });
      waiting.clear();
      finder = null;
    };
    finder = { worker, next: 1, waiting };
  } catch {
    finderBroken = true;
  }
  return finder;
}

/** How long a page's line finding may take before the page is read the old way. */
const FIND_TIMEOUT_MS = 60_000;

/** The boxes of the lines on `image`, in its pixels, in reading order; `null` when they could not be found. */
async function findLines(image: HTMLCanvasElement, rightToLeft: boolean): Promise<Box[] | null> {
  const lines = lineFinder();
  if (!lines) return null;
  const size = detectSize(image.width, image.height);
  const small = document.createElement('canvas');
  small.width = size.width;
  small.height = size.height;
  try {
    const context = small.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, size.width, size.height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, size.width, size.height);
    const rgba = context.getImageData(0, 0, size.width, size.height).data;
    const id = lines.next++;
    const job: DetectJob = { id, model: absolute('ocr/lines.onnx'), width: size.width, height: size.height, rgba };
    const answer = await new Promise<DetectAnswer>((resolve) => {
      const timer = setTimeout(() => {
        lines.waiting.delete(id);
        // A finder that hung once would cost every later page the same wait: it is off until the app restarts.
        finderBroken = true;
        finder = null;
        lines.worker.terminate();
        for (const done of lines.waiting.values()) done({ id: -1, ok: false, message: 'E_OCR_LINES: the line finder stopped' });
        lines.waiting.clear();
        resolve({ id, ok: false, message: 'E_OCR_LINES: timed out' });
      }, FIND_TIMEOUT_MS);
      lines.waiting.set(id, (done) => {
        clearTimeout(timer);
        resolve(done);
      });
      lines.worker.postMessage(job, [rgba.buffer]);
    });
    if (!answer.ok) {
      uiLog(`ocr: lines not found (${answer.message}); Tesseract finds them`);
      return null;
    }
    return readingOrder(scaleBoxes(answer.boxes, image.width / size.width, image.height / size.height), rightToLeft);
  } finally {
    small.width = 0;
    small.height = 0;
  }
}

/** The canvas as grey, 0 black to 255 white, transparent as white. */
function greyOfCanvas(image: HTMLCanvasElement): GreyLine | null {
  const context = image.getContext('2d');
  if (!context) return null;
  const { data } = context.getImageData(0, 0, image.width, image.height);
  const grey = new Uint8Array(image.width * image.height);
  for (let p = 0; p < grey.length; p += 1) {
    const a = data[p * 4 + 3]! / 255;
    const y = 0.299 * data[p * 4]! + 0.587 * data[p * 4 + 1]! + 0.114 * data[p * 4 + 2]!;
    grey[p] = Math.round(y * a + 255 * (1 - a));
  }
  return { width: image.width, height: image.height, data: grey };
}

/** A Tesseract worker for `languages`, its models from the app's own origin. */
async function tesseract(languages: readonly OcrLanguage[]) {
  const simd = hasWasmSimd();
  const started = Date.now();
  // Said in the desktop host's WARRAQ_DEBUG log (a no-op elsewhere): the
  // one way to see recognition start inside the macOS webview.
  uiLog(`ocr: starting Tesseract (${simd ? 'SIMD' : 'plain'} core) for ${languages.join('+')}`);
  try {
    const worker = await createWorker([...languages], OEM.LSTM_ONLY, {
      workerPath: absolute(workerUrl),
      corePath: absolute(simd ? coreSimdUrl : coreUrl),
      langPath: absolute('ocr'),
      gzip: true,
      // A worker made from its own URL, not a blob: copy, and no cache in the
      // browser's storage: nothing is kept after the run.
      workerBlobURL: false,
      cacheMethod: 'none',
    });
    uiLog(`ocr: Tesseract ready in ${Date.now() - started} ms`);
    let mode: PSM | null = null;
    return {
      async read(image: HTMLCanvasElement | Uint8Array, next: PSM): Promise<TessPage> {
        if (mode !== next) {
          await worker.setParameters({ tessedit_pageseg_mode: next });
          mode = next;
        }
        const { data } = await worker.recognize(image as unknown as Blob, {}, { blocks: true });
        return data as TessPage;
      },
      stop: () => worker.terminate(),
    };
  } catch (error) {
    uiLog(`ocr: Tesseract did not start: ${String((error as Error)?.message ?? error)}`);
    throw error;
  }
}

/** The words of a sheet Tesseract read, each with its line, boxes on the page. */
function sheetWords(data: TessPage, placements: readonly Placement[], lines: readonly number[]): LineWord[] {
  const out: LineWord[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          const text = word.text.trim();
          if (!text) continue;
          const bbox: Box = [word.bbox.x0, word.bbox.y0, word.bbox.x1, word.bbox.y1];
          const box = toPage(bbox, placements);
          const k = sheetLine(bbox);
          if (!box || lines[k] === undefined) continue;
          out.push({ text, box, confidence: word.confidence, line: lines[k]! });
        }
      }
    }
  }
  return out;
}

/** Below this mean confidence, a page read line by line is read whole too. */
const DOUBTFUL_PAGE = 60;

/** What a reading is worth: its words, each counted by how sure Tesseract was of it. */
function weight(words: readonly { confidence: number }[]): number {
  return words.reduce((sum, word) => sum + Math.max(0, word.confidence), 0);
}

/** Words with their spaces: one after every word but a line's last. */
function spaced(words: readonly LineWord[]): ReadWord[] {
  return words.map((word, k) => ({
    text: k < words.length - 1 && words[k + 1]!.line === word.line ? `${word.text} ` : word.text,
    bbox: word.box,
    confidence: word.confidence,
  }));
}

/**
 * Starts Tesseract with the models for `languages`, and the line finder.
 *
 * A page is read in two steps: its lines are found by PaddleOCR's detector
 * (`findLines`), cut out, each one's light evened out, and stacked on one
 * sheet (`lines.ts`); Tesseract reads the sheet and each word is put back
 * where it was on the page. Measured on 30 pages (phone photos, office
 * copies, clean scans, old print; `models/README.md`): phone photos went
 * from 37 % of their words to 87 %, office copies from 80 % to 88 %.
 * Where the finder cannot run or finds nothing, Tesseract reads the page as
 * it always has.
 *
 * English with Arabic is not read by one model of both: that let English win
 * on Arabic words. The page is read with the other languages first, and only
 * the lines with words that reading doubted are read again in English
 * (`mergeEnglish`).
 */
export async function startRecognizer(languages: readonly OcrLanguage[]): Promise<Recognizer> {
  const others = languages.filter((code) => code !== 'eng');
  const withEnglish = languages.includes('eng') && others.length > 0;
  const primary = await tesseract(others.length > 0 ? others : ['eng']);
  let english: ReturnType<typeof tesseract> | null = null;
  let mixed: ReturnType<typeof tesseract> | null = null;
  const rightToLeft = others.length > 0;
  const readWhole = async (image: HTMLCanvasElement) => {
    // Without the line finder: the page as Tesseract always read it, with every language at once.
    const whole = withEnglish ? await (mixed ??= tesseract(languages)) : primary;
    return wordsOf(await whole.read(image, PSM.AUTO), (box) => box);
  };
  /**
   * `boxes` read off sheets of at most `SHEET_MAX_PIXELS` each: the words,
   * their `line` the index into the returned placements.
   */
  const readSheets = async (reader: Awaited<ReturnType<typeof tesseract>>, grey: GreyLine, boxes: readonly Box[]) => {
    const placed: Placement[] = [];
    const words: LineWord[] = [];
    for (const chunk of sheetChunks(boxes)) {
      const { sheet, placements } = buildSheet(grey, boxes.slice(chunk.start, chunk.start + chunk.count));
      if (placements.length === 0) continue;
      const ids = placements.map((_, k) => placed.length + k);
      // One column of lines, each its own: Tesseract's own page layout is not asked for.
      words.push(...sheetWords(await reader.read(toPgm(sheet), PSM.SINGLE_COLUMN), placements, ids));
      placed.push(...placements);
    }
    return { words, placed };
  };
  /** The page read line by line, English only where the first reading doubted; `null` when no line could be cut. */
  const readByLines = async (image: HTMLCanvasElement, boxes: readonly Box[]): Promise<LineWord[] | null> => {
    const grey = greyOfCanvas(image);
    if (!grey) return null;
    const first = await readSheets(primary, grey, boxes);
    if (first.placed.length === 0) return null;
    let words = first.words;
    if (withEnglish) {
      const doubted = [...new Set(words.filter(doubtful).map((word) => word.line))].sort((a, b) => a - b);
      if (doubted.length > 0) {
        const reader = await (english ??= tesseract(['eng']));
        const again = await readSheets(reader, grey, doubted.map((k) => first.placed[k]!.box));
        const read = again.words.flatMap((word) => (doubted[word.line] === undefined ? [] : [{ ...word, line: doubted[word.line]! }]));
        words = mergeEnglish(words, read);
      }
    }
    return words;
  };
  return {
    async read(image) {
      const boxes = await findLines(image, rightToLeft).catch(() => null);
      if (!boxes || boxes.length === 0) return readWhole(image);
      if (boxes.length > PAGE_MAX_LINES) {
        uiLog(`ocr: ${boxes.length} lines found, too many to be text; read whole`);
        return readWhole(image);
      }
      try {
        const words = await readByLines(image, boxes);
        if (!words) return readWhole(image);
        uiLog(`ocr: read line by line (${boxes.length} lines)`);
        // A page the lines did not suit (its lines turned, say, where the
        // straightening could not measure it) reads with little confidence:
        // it is read the old way too, and the better reading kept.
        const mean = words.length ? words.reduce((sum, word) => sum + word.confidence, 0) / words.length : 0;
        if (mean < DOUBTFUL_PAGE) {
          const whole = await readWhole(image);
          if (weight(whole) > weight(words)) {
            uiLog(`ocr: the page read better whole (${Math.round(mean)} % sure line by line)`);
            return whole;
          }
        }
        return spaced(words);
      } catch (error) {
        // Whatever went wrong line by line, the page is still read the old way.
        uiLog(`ocr: reading line by line failed (${error instanceof Error ? error.message : String(error)}); read whole`);
        return readWhole(image);
      }
    },
    async stop() {
      await primary.stop();
      if (english) await (await english).stop();
      if (mixed) await (await mixed).stop();
    },
  };
}
