import { createWorker, OEM } from 'tesseract.js';
import workerUrl from 'tesseract.js/dist/worker.min.js?url';
import coreUrl from 'tesseract.js-core/tesseract-core-lstm.wasm.js?url';
import coreSimdUrl from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url';
import { uiLog } from '../core/host-tauri';

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

/** Starts Tesseract with the models for `languages`. */
export async function startRecognizer(languages: readonly OcrLanguage[]): Promise<Recognizer> {
  const simd = hasWasmSimd();
  const started = Date.now();
  // Said in the desktop host's WARRAQ_DEBUG log (a no-op elsewhere): the
  // one way to see recognition start inside the macOS webview.
  uiLog(`ocr: starting Tesseract (${simd ? 'SIMD' : 'plain'} core) for ${languages.join('+')}`);
  let worker: Awaited<ReturnType<typeof createWorker>>;
  try {
    worker = await createWorker([...languages], OEM.LSTM_ONLY, {
      workerPath: absolute(workerUrl),
      corePath: absolute(simd ? coreSimdUrl : coreUrl),
      langPath: absolute('ocr'),
      gzip: true,
      // A worker made from its own URL, not a blob: copy, and no cache in the
      // browser's storage: nothing is kept after the run.
      workerBlobURL: false,
      cacheMethod: 'none',
    });
  } catch (error) {
    uiLog(`ocr: Tesseract did not start: ${String((error as Error)?.message ?? error)}`);
    throw error;
  }
  uiLog(`ocr: Tesseract ready in ${Date.now() - started} ms`);
  return {
    async read(image) {
      const { data } = await worker.recognize(image, {}, { blocks: true });
      const words: ReadWord[] = [];
      for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs) {
          for (const line of paragraph.lines) {
            const read = line.words.filter((word) => word.text.trim().length > 0);
            read.forEach((word, k) => {
              const { x0, y0, x1, y1 } = word.bbox;
              // A space after every word but a line's last: readers find word
              // breaks by the spaces in the text, not the gaps on the page.
              const text = k < read.length - 1 ? `${word.text.trim()} ` : word.text.trim();
              words.push({ text, bbox: [x0, y0, x1, y1], confidence: word.confidence });
            });
          }
        }
      }
      return words;
    },
    async stop() {
      await worker.terminate();
    },
  };
}
