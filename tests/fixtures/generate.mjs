// Generates the small fixture PDFs used by the e2e specs with Chromium's PDF printer (a "Chrome-made
// PDF", like many real-world files). The Arabic fixture embeds Noto Naskh Arabic (OFL) from
// @embedpdf/fonts-arabic so it renders the same everywhere. Run: node tests/fixtures/generate.mjs
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
  body { font: 13pt/1.6 Helvetica, Arial, sans-serif; color: #111; }
  h1 { font-size: 24pt; margin: 0 0 8mm; }
  .page { break-after: page; }
  .page:last-child { break-after: auto; }
  [lang=ar] { font-family: Naskh, serif; }
`;

const docs = {
  'sample-en.pdf': `
    <div class="page"><h1>Quarterly report</h1>
      <p>This is a small two-page fixture for ZOOD PDF end-to-end tests.</p>
      <p>Highlight this sentence to test comments and saving.</p></div>
    <div class="page"><h1>Page two</h1><p>The second page exists so navigation can be tested.</p></div>`,
  'sample-ar.pdf': `
    <div class="page" lang="ar" dir="rtl"><h1>تقرير الربع الأول</h1>
      <p>هذا ملف اختبار صغير لتطبيق زود PDF، مكتوب باللغة العربية.</p>
      <p>العقد رقم ٢٠٢٦ بين الطرفين، والمبلغ ١٥٠٠ ريال سعودي.</p></div>
    <div class="page" lang="ar" dir="rtl"><h1>الصفحة الثانية</h1><p>تُستخدم هذه الصفحة لاختبار التنقل بين الصفحات.</p></div>`,
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
