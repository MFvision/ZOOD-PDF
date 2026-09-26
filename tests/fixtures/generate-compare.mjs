// Generates the Compare fixtures (two Chrome-made versions of an Arabic contract that differ in
// exactly one word on page 1: ثلاثين → عشرين). Same printer and font as generate.mjs.
// Run: node tests/fixtures/generate-compare.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fontDir = fs.realpathSync(path.join(root, 'packages/ui/node_modules/@embedpdf/fonts-arabic/fonts'));
const naskh = pathToFileURL(path.join(fontDir, 'NotoNaskhArabic-Regular.ttf')).href;
const naskhBold = pathToFileURL(path.join(fontDir, 'NotoNaskhArabic-Bold.ttf')).href;

const css = `
  @font-face { font-family: Naskh; src: url(${naskh}); font-weight: 400; }
  @font-face { font-family: Naskh; src: url(${naskhBold}); font-weight: 700; }
  @page { size: A4; margin: 22mm; }
  body { font: 14pt/1.7 Naskh, serif; color: #111; }
  h1 { font-size: 22pt; margin: 0 0 8mm; }
  .page { break-after: page; }
  .page:last-child { break-after: auto; }
`;

const contract = (days) => `
  <div class="page" lang="ar" dir="rtl"><h1>عقد توريد أجهزة</h1>
    <p>يلتزم المورد بتسليم الأجهزة خلال ${days} يومًا من تاريخ التوقيع.</p>
    <p>قيمة العقد ١٥٠٠ ريال سعودي تُدفع على دفعتين متساويتين.</p></div>
  <div class="page" lang="ar" dir="rtl"><h1>أحكام عامة</h1>
    <p>تُطبق أحكام النظام السعودي على هذا العقد.</p></div>`;

const docs = {
  'compare-v1.pdf': contract('ثلاثين'),
  'compare-v2.pdf': contract('عشرين'),
};

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, body] of Object.entries(docs)) {
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  const pdf = await page.pdf({ format: 'A4', printBackground: true, tagged: true });
  fs.writeFileSync(path.join(here, name), pdf);
  console.log('wrote', name, pdf.byteLength, 'bytes');
}
await browser.close();
