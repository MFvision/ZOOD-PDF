import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/**
 * The licences of what a build ships that is not an imported JavaScript
 * module, written under `licenses/` in the build: the fonts, EmbedPDF's
 * stamps, PDFium and Tesseract (both loaded by URL, not imported) and the OCR
 * models. Vite's `build.license` lists the bundled JavaScript packages beside
 * them (`licenses/THIRD-PARTY-LICENSES.md`), and `THIRD-PARTY-NOTICES.md`
 * says what each one is for.
 */

const require = createRequire(import.meta.url);
const ui = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

/** The directory of an installed package, found from its entry point — resolved from `from`'s own dependencies when given. */
function packageRoot(name: string, from?: string): string {
  const resolve = from ? createRequire(join(from, 'package.json')).resolve : require.resolve;
  let dir = dirname(resolve(name));
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (
      existsSync(manifest) &&
      (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === name
    ) {
      return dir;
    }
    const up = dirname(dir);
    if (up === dir) throw new Error(`no package root for ${name}`);
    dir = up;
  }
}

/** EmbedPDF's viewer, a dependency of its React wrapper rather than of this package. */
const snippet = () => packageRoot('@embedpdf/snippet', packageRoot('@embedpdf/react-pdf-viewer'));

interface Notice {
  fileName: string;
  path: () => string;
  /** Said first, when the licence file alone does not say what it covers. */
  header?: string;
}

export const NOTICES: Notice[] = [
  { fileName: 'THIRD-PARTY-NOTICES.md', path: () => ui('../../THIRD-PARTY-NOTICES.md') },
  { fileName: 'fonts/Amiri-OFL.txt', path: () => ui('public/fonts/Amiri-OFL.txt') },
  { fileName: 'fonts/Cairo-OFL.txt', path: () => ui('public/fonts/Cairo-OFL.txt') },
  { fileName: 'fonts/Inter-OFL.txt', path: () => ui('public/fonts/Inter-OFL.txt') },
  {
    fileName: 'fonts/NotoNaskhArabic-OFL.txt',
    path: () => ui('public/fonts/NotoNaskhArabic-OFL.txt'),
  },
  {
    fileName: 'icc/Compact-ICC-Profiles-CC0.txt',
    path: () => ui('../core/warraq-pdf/assets/icc/LICENSE-CC0.txt'),
    header:
      "The sRGB and CMYK (CGATS TR 001) colour profiles compiled into Warraq's core for PDF/A and PDF/X, from Clinton Ingram's Compact-ICC-Profiles:",
  },
  {
    fileName: 'embedpdf-stamps-LICENSE.txt',
    path: () => ui('public/stamps/en/LICENSE'),
    header: "EmbedPDF's standard stamps (stamps.pdf), from the embed-pdf-viewer repository:",
  },
  {
    fileName: 'embedpdf-pdfium-LICENSE.txt',
    path: () => join(packageRoot('@embedpdf/pdfium'), 'LICENSE'),
  },
  {
    fileName: 'pdfium-LICENSE.txt',
    path: () => join(packageRoot('@embedpdf/pdfium'), 'LICENSE.pdfium'),
    header: 'PDFium, compiled to WebAssembly in @embedpdf/pdfium:',
  },
  // Compiled into EmbedPDF's viewer rather than imported, so the list of
  // bundled packages does not name them.
  { fileName: 'preact-LICENSE.txt', path: () => join(packageRoot('preact', snippet()), 'LICENSE') },
  {
    fileName: 'tailwind-merge-LICENSE.md',
    path: () => join(packageRoot('tailwind-merge', snippet()), 'LICENSE.md'),
  },
  {
    fileName: 'tesseract.js-LICENSE.md',
    path: () => join(packageRoot('tesseract.js'), 'LICENSE.md'),
  },
  {
    fileName: 'tesseract.js-core-LICENSE.txt',
    path: () => join(packageRoot('tesseract.js-core'), 'LICENSE'),
  },
  {
    fileName: 'tessdata-LICENSE.txt',
    path: () => join(packageRoot('tesseract.js-core'), 'LICENSE'),
    header:
      "Tesseract's trained models for Arabic, English, Persian and Urdu (ocr/*.traineddata.gz, 4.0.0_best_int, from tesseract-ocr/tessdata_best) are under the Apache License 2.0:",
  },
];

export function notices(): Plugin {
  return {
    name: 'warraq:notices',
    apply: 'build',
    generateBundle() {
      for (const notice of NOTICES) {
        const text = readFileSync(notice.path(), 'utf8');
        this.emitFile({
          type: 'asset',
          fileName: `licenses/${notice.fileName}`,
          source: notice.header ? `${notice.header}\n\n${text}` : text,
        });
      }
    },
  };
}
