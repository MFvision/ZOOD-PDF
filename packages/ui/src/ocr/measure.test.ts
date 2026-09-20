import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { encodePng } from '../export/png';
import { NO_CLEANUP, cleanUp, greyOf, writeGrey } from './cleanup';
import type { CleanupOptions, Grey } from './cleanup';
import { skewAngle } from './deskew';

/**
 * How much of a corpus scan Tesseract reads, with and without each cleanup:
 * the numbers in `docs/STATUS.md`. Opt-in, and slow (Tesseract in Node, a
 * page at a time):
 *
 *   WARRAQ_OCR_MEASURE=1 pnpm --filter @warraq/ui exec vitest run src/ocr/measure.test.ts
 *
 * Each page goes the way Scan & OCR takes it — drawn at 300 dpi by Warraq's
 * core (WASM), cleaned, straightened, read — and is scored as `e2e/ocr.spec.ts`
 * scores the text layer: the share of the truth's Arabic words, three letters
 * or longer, that were read — here page by page, since the corpus's two-page
 * scans repeat their paragraphs, and a word lost in the shadow on one page
 * but read on the other would otherwise count as read. Each result is also
 * added to `.tools/logs/ocr-measure.tsv`.
 */

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(import.meta.url);

const SCANS = (process.env.WARRAQ_OCR_SCANS ?? 'scan-notonaskh-300dpi-shadowed-stained-jpeg,scan-notonaskh-300dpi-skewed-jpeg,scan-notonaskh-300dpi-crooked-8deg-jpeg,scan-arial-200dpi-bilevel').split(',');

const ALL: CleanupOptions = { background: true, contrast: true, binarize: true, despeckle: true, borders: true };
const SETTINGS: Record<string, CleanupOptions> = {
  none: NO_CLEANUP,
  background: { ...NO_CLEANUP, background: true },
  'background+contrast': { ...NO_CLEANUP, background: true, contrast: true },
  binarize: { ...NO_CLEANUP, binarize: true },
  all: ALL,
};

function share(text: string, name: string): { found: number; of: number } {
  const truth = readFileSync(`${root}tests/corpus/arabic/truth/${name}.txt`, 'utf8');
  const words = [...new Set(truth.split(/[\s|:،.()—؟]+/).filter((w) => /[؀-ۿ]/.test(w) && w.length >= 3))];
  return { found: words.filter((w) => text.includes(w)).length, of: words.length };
}

/** `grey` turned `degrees` clockwise about its centre, on white, in a frame that holds it (as `straighten`). */
function turned(grey: Grey, degrees: number): Grey {
  const t = (degrees * Math.PI) / 180;
  const [c, s] = [Math.cos(t), Math.sin(t)];
  const width = Math.ceil(grey.width * Math.abs(c) + grey.height * Math.abs(s));
  const height = Math.ceil(grey.width * Math.abs(s) + grey.height * Math.abs(c));
  const data = new Uint8Array(width * height).fill(255);
  const [cx, cy, ox, oy] = [grey.width / 2, grey.height / 2, width / 2, height / 2];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Back from the turned frame to the source, bilinear.
      const dx = x + 0.5 - ox;
      const dy = y + 0.5 - oy;
      const sx = c * dx + s * dy + cx - 0.5;
      const sy = -s * dx + c * dy + cy - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= grey.width || y0 + 1 >= grey.height) continue;
      const fx = sx - x0;
      const fy = sy - y0;
      const at = (xx: number, yy: number) => grey.data[yy * grey.width + xx]!;
      data[y * width + x] =
        (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
    }
  }
  return { width, height, data };
}

function png(grey: Grey): Uint8Array {
  const rgba = new Uint8ClampedArray(grey.width * grey.height * 4);
  writeGrey(grey, { width: grey.width, height: grey.height, rgba });
  return encodePng(grey.width, grey.height, rgba);
}

describe.runIf(process.env.WARRAQ_OCR_MEASURE)('OCR word accuracy on the corpus scans, by cleanup', () => {
  it('measures', { timeout: 3_600_000 }, async () => {
    const tessdata = `${root}.tools/scratch/tessdata`;
    mkdirSync(tessdata, { recursive: true });
    for (const code of ['ara', 'eng']) {
      const link = `${tessdata}/${code}.traineddata.gz`;
      if (!existsSync(link)) symlinkSync(require.resolve(`@tesseract.js-data/${code}/4.0.0_best_int/${code}.traineddata.gz`), link);
    }
    const wasmDir = new URL('../core-wasm/', import.meta.url);
    const core = await import(/* @vite-ignore */ new URL('warraq_core.js', wasmDir).href);
    await core.default({ module_or_path: readFileSync(new URL('warraq_core_bg.wasm', wasmDir)) });
    const { createWorker, OEM } = await import('tesseract.js');
    const worker = await createWorker(['ara', 'eng'], OEM.LSTM_ONLY, { langPath: tessdata, gzip: true, cacheMethod: 'none' });
    const only = process.env.WARRAQ_OCR_SETTINGS?.split(',');
    const lines: string[] = [];
    try {
      for (const name of SCANS) {
        const doc = core.Document.open(new Uint8Array(readFileSync(`${root}tests/corpus/arabic/generated/${name}.pdf`)));
        for (const [label, options] of Object.entries(SETTINGS)) {
          if (only && !only.includes(label)) continue;
          let found = 0;
          let of = 0;
          const started = Date.now();
          for (let index = 0; index < doc.page_count(); index += 1) {
            const size = doc.page_size(index) as Float32Array;
            const scale = Math.min(300 / 72, 4200 / Math.max(size[0]!, size[1]!));
            const render = doc.render_page(index, scale);
            const page = { width: render.width as number, height: render.height as number, rgba: new Uint8ClampedArray(render.rgba as Uint8Array) };
            render.free();
            cleanUp(page, options, scale * 72);
            const angle = skewAngle(page);
            const grey = greyOf(page);
            const image = png(angle === 0 ? grey : turned(grey, angle));
            // WARRAQ_OCR_DUMP=1 keeps each page as it was read, to look at.
            if (process.env.WARRAQ_OCR_DUMP) writeFileSync(`${root}.tools/scratch/${name}-${label}-${index + 1}.png`, image);
            const { data } = await worker.recognize(Buffer.from(image));
            const score = share(data.text, name);
            if (process.env.WARRAQ_OCR_DUMP) appendFileSync(`${root}.tools/logs/ocr-measure.tsv`, `  page ${index + 1}: ${score.found}/${score.of}\n`);
            found += score.found;
            of += score.of;
          }
          lines.push(`${name}\t${label}\t${found}/${of}\t${Math.round((100 * found) / of)}%\t${Math.round((Date.now() - started) / 1000)} s`);
          appendFileSync(`${root}.tools/logs/ocr-measure.tsv`, `${lines[lines.length - 1]}\n`);
        }
        doc.free();
      }
    } finally {
      await worker.terminate();
    }
    process.stdout.write(`\n${lines.join('\n')}\n`);
  });
});
