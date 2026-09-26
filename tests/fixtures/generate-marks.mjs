// Fixture for the Page marks spec, made by Chromium (like many real files):
//   marks-3.pdf  three A4 pages of Arabic text (right to left), one heading per page
// Run: node tests/fixtures/generate-marks.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const font = path.resolve(here, '../../packages/core/assets/fonts/amiri/Amiri-Regular.ttf');
const browser = await chromium.launch();
const page = await browser.newPage();
const body = [1, 2, 3]
  .map(
    (n) => `<section><h1>الفصل ${['الأول', 'الثاني', 'الثالث'][n - 1]}</h1>
<p>هذه صفحة اختبار لأداة علامات الصفحات في زود PDF. يضاف إليها ترويسة وتذييل وعلامة مائية ثم تُحفظ وتُفتح من جديد.</p></section>`,
  )
  .join('');
await page.setContent(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>
@font-face { font-family: Amiri; src: url(data:font/ttf;base64,${fs.readFileSync(font).toString('base64')}); }
@page { size: A4; margin: 30mm 25mm; }
body { font-family: Amiri; font-size: 16pt; }
section { break-after: page; }
section:last-child { break-after: auto; }
</style></head><body>${body}</body></html>`);
await page.evaluate(() => document.fonts.ready);
const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
fs.writeFileSync(path.join(here, 'marks-3.pdf'), pdf);
await browser.close();
console.log('marks-3.pdf', pdf.length);
