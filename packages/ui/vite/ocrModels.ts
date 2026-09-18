import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

/**
 * Scan & OCR's language models, served from the app's own origin under fixed
 * names: `ocr/<code>.traineddata.gz`.
 *
 * tesseract.js looks a model up by language code in a directory
 * (`langPath/<code>.traineddata.gz`). Handing it the bytes instead is broken
 * in 7.0.0 — it then initializes with the model's bytes as the language name
 * (`src/worker-script/index.js`, `l.data` for `l.code`) — so the models keep
 * their names here, in every host that uses the shared UI: the web build (and
 * with it the desktop app) and the extension.
 */
export const OCR_LANGUAGES = ['ara', 'eng', 'fas', 'urd'] as const;

const require = createRequire(import.meta.url);
const modelPath = (code: string) =>
  require.resolve(`@tesseract.js-data/${code}/4.0.0_best_int/${code}.traineddata.gz`);

export function ocrModels(): Plugin {
  return {
    name: 'warraq:ocr-models',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const match = /\/ocr\/([a-z]{3})\.traineddata\.gz$/.exec(request.url ?? '');
        const code = match?.[1];
        if (!code || !(OCR_LANGUAGES as readonly string[]).includes(code)) return next();
        response.setHeader('Content-Type', 'application/octet-stream');
        response.end(readFileSync(modelPath(code)));
      });
    },
    generateBundle() {
      for (const code of OCR_LANGUAGES) {
        this.emitFile({ type: 'asset', fileName: `ocr/${code}.traineddata.gz`, source: readFileSync(modelPath(code)) });
      }
    },
  };
}
