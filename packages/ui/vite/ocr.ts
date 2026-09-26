/**
 * Scan & OCR assets, served from the app's own origin (never a CDN):
 *   ocr/worker.min.js                     tesseract.js 7 worker (dist build)
 *   ocr/core/tesseract-core-*-lstm.wasm.js the WebAssembly core (LSTM-only builds, wasm embedded)
 *   ocr/lang/{ara,eng,fas,urd}.traineddata  models (tessdata 4.1.0 "best-int"), fetched and checksum-
 *                                           verified by scripts/fetch-ocr-models.sh into .cache/ocr-models
 * A missing model FAILS the build (no silent OCR-less build). `ZOOD_OCR_MODELS` overrides the folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { findPackage } from './licenses.ts';

export const OCR_LANG_FILES = ['ara', 'eng', 'fas', 'urd'] as const;
export const OCR_CORE_FILES = ['tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'] as const;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function modelsDir(): string {
  return process.env.ZOOD_OCR_MODELS ?? path.join(REPO, '.cache/ocr-models');
}

/** Published path → source file. */
export function ocrAssets(): Map<string, string> {
  const map = new Map<string, string>();
  const tjs = findPackage('tesseract.js');
  const core = findPackage('tesseract.js-core');
  map.set('ocr/worker.min.js', path.join(tjs, 'dist/worker.min.js'));
  for (const f of OCR_CORE_FILES) map.set(`ocr/core/${f}`, path.join(core, f));
  for (const l of OCR_LANG_FILES) map.set(`ocr/lang/${l}.traineddata`, path.join(modelsDir(), `${l}.traineddata`));
  return map;
}

export function missingOcrAssets(): string[] {
  return [...ocrAssets().values()].filter((f) => !fs.existsSync(f));
}

const TYPES: Record<string, string> = { '.js': 'text/javascript', '.traineddata': 'application/octet-stream' };

export function zoodOcrAssets(): Plugin {
  return {
    name: 'zood:ocr-assets',
    buildStart() {
      const missing = missingOcrAssets();
      if (missing.length) {
        this.error(
          `OCR assets are missing:\n  ${missing.map((m) => path.relative(REPO, m)).join('\n  ')}\n` +
            'Fetch the language models first: bash scripts/fetch-ocr-models.sh',
        );
      }
    },
    configureServer(server) {
      const assets = ocrAssets();
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]!.replace(/^\/+/, '');
        const file = assets.get(url);
        if (!file) return next();
        res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const [fileName, file] of ocrAssets()) {
        this.emitFile({ type: 'asset', fileName, source: fs.readFileSync(file) });
      }
      // tessdata is Apache-2.0: ship the licence next to the models.
      const core = findPackage('tesseract.js-core');
      this.emitFile({ type: 'asset', fileName: 'ocr/lang/LICENSE.txt', source: fs.readFileSync(path.join(core, 'LICENSE')) });
      this.emitFile({
        type: 'asset',
        fileName: 'ocr/lang/README.txt',
        source:
          'Tesseract language models from https://github.com/tesseract-ocr/tessdata (tag 4.1.0, "best-int":\n' +
          'tessdata_best LSTM models converted to integer). Copyright Google / Tesseract contributors,\n' +
          'Apache License 2.0 (LICENSE.txt). Checksums: scripts/fetch-ocr-models.sh.\n',
      });
    },
  };
}
