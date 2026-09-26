/**
 * tesseract.js 7 (Apache-2.0) with everything served from the app's own origin: its worker script,
 * the WebAssembly core and the language models (`ocr/` in every build, see `vite/ocr.ts`). Nothing is
 * fetched from a CDN. The worker is started from its file (no blob: URL) so the MV3 extension CSP
 * allows it; the core needs only `'wasm-unsafe-eval'`.
 */
import { createWorker, OEM, PSM, type Worker as TessWorker, type Page } from 'tesseract.js';

export type OcrLang = 'ar' | 'en' | 'fa' | 'ur';
export const OCR_LANGS: readonly OcrLang[] = ['ar', 'en', 'fa', 'ur'];
const TESS_CODE: Record<OcrLang, string> = { ar: 'ara', en: 'eng', fa: 'fas', ur: 'urd' };

export interface RecognisedWord {
  text: string;
  /** [x0, y0, x1, y1] in pixels of the recognised image. */
  bbox: [number, number, number, number];
  conf: number;
  line: number;
}

export interface Recognition {
  words: RecognisedWord[];
  text: string;
  confidence: number;
}

export function tesseractLangs(langs: readonly OcrLang[]): string {
  const list = OCR_LANGS.filter((l) => langs.includes(l));
  return (list.length ? list : ['en' as OcrLang]).map((l) => TESS_CODE[l]).join('+');
}

/** Base URL of the bundled OCR assets. */
export function ocrAssetBase(): URL {
  return new URL('ocr/', typeof document !== 'undefined' ? document.baseURI : self.location.href);
}

/** Flattens tesseract's block → paragraph → line → word tree into words with line numbers. */
export function wordsFromPage(page: Pick<Page, 'blocks'>): RecognisedWord[] {
  const out: RecognisedWord[] = [];
  let line = 0;
  for (const block of page.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const l of para.lines ?? []) {
        for (const w of l.words ?? []) {
          const text = (w.text ?? '').trim();
          const b = w.bbox;
          if (!text || !b || !(b.x1 > b.x0) || !(b.y1 > b.y0)) continue;
          out.push({ text, bbox: [b.x0, b.y0, b.x1, b.y1], conf: Number.isFinite(w.confidence) ? w.confidence : 0, line });
        }
        line++;
      }
    }
  }
  return out;
}

export type ProgressFn = (fraction: number, status: string) => void;

export class Recognizer {
  private worker: TessWorker | null = null;
  private langs = '';
  private progress: ProgressFn | null = null;

  /** Starts (or re-initialises) the engine for `langs`. */
  async ensure(langs: readonly OcrLang[]): Promise<void> {
    const code = tesseractLangs(langs);
    if (this.worker && this.langs === code) return;
    const base = ocrAssetBase();
    if (!this.worker) {
      this.worker = await createWorker(code, OEM.LSTM_ONLY, {
        workerPath: new URL('worker.min.js', base).href,
        corePath: new URL('core/', base).href,
        langPath: new URL('lang', base).href,
        gzip: false,
        cacheMethod: 'none',
        workerBlobURL: false,
        logger: (m) => {
          if (m.status === 'recognizing text') this.progress?.(m.progress, m.status);
        },
      });
    } else {
      await this.worker.reinitialize(code, OEM.LSTM_ONLY);
    }
    await this.worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1' });
    this.langs = code;
  }

  async recognize(image: Uint8Array, dpi: number, onProgress?: ProgressFn): Promise<Recognition> {
    if (!this.worker) throw new Error('recogniser not started');
    this.progress = onProgress ?? null;
    try {
      await this.worker.setParameters({ user_defined_dpi: String(Math.round(dpi)) });
      const { data } = await this.worker.recognize(image, {}, { text: true, blocks: true });
      return { words: wordsFromPage(data), text: data.text ?? '', confidence: data.confidence ?? 0 };
    } finally {
      this.progress = null;
    }
  }

  /** Stops the engine at once (cancel). */
  async terminate(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    this.langs = '';
    if (w) await w.terminate();
  }
}
