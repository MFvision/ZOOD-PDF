// Generates the Accessibility fixture with Chromium's PDF printer, UNTAGGED (`tagged: false`, like
// many real files): two A4 pages in Noto Naskh Arabic (OFL, from @embedpdf/fonts-arabic) with a big
// heading, a sub-heading, Arabic paragraphs (one with an English word), an English paragraph, a list
// numbered with Arabic-Indic digits, a bulleted list, a ruled table with a header row, a picture, a
// link and a footer repeated on both pages (a pagination artifact).
// Run: node tests/fixtures/generate-a11y.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fontDir = fs.realpathSync(path.join(root, 'packages/ui/node_modules/@embedpdf/fonts-arabic/fonts'));
const naskh = pathToFileURL(path.join(fontDir, 'NotoNaskhArabic-Regular.ttf')).href;
const naskhBold = pathToFileURL(path.join(fontDir, 'NotoNaskhArabic-Bold.ttf')).href;

/** A tiny RGB PNG (w×h) with two colour bands, encoded by hand. */
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const top = y < h / 2;
      row[1 + x * 3] = top ? 0x1d : 0xf5;
      row[2 + x * 3] = top ? 0x5f : 0xa6;
      row[3 + x * 3] = top ? 0xd6 : 0x23;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const picture = `data:image/png;base64,${png(120, 80).toString('base64')}`;
const css = `
  @font-face { font-family: Naskh; src: url(${naskh}); }
  @font-face { font-family: Naskh; font-weight: bold; src: url(${naskhBold}); }
  @page { size: A4; margin: 20mm 22mm 24mm; }
  body { font: 13pt/1.6 Naskh, serif; color: #111; margin: 0; }
  h1 { font-size: 26pt; margin: 0 0 4mm; }
  h2 { font-size: 18pt; margin: 4mm 0 3mm; }
  p { margin: 0 0 4mm; }
  ol, ul { margin: 0 0 4mm; padding-inline-start: 10mm; }
  ol { list-style-type: arabic-indic; }
  ul { list-style-type: none; }
  table { border-collapse: collapse; margin: 2mm 0 5mm; }
  th, td { border: 1px solid #333; padding: 1.5mm 4mm; }
  th { font-weight: bold; }
  img { display: block; width: 50mm; height: 33mm; margin: 2mm 0 5mm; }
  .en { font-family: Helvetica, Arial, sans-serif; direction: ltr; text-align: left; font-size: 12pt; }
  .page { break-after: page; }
  .foot { position: fixed; bottom: 0; inset-inline: 0; text-align: center; font-size: 10pt; color: #555; }
`;

const body = `
  <div lang="ar" dir="rtl">
    <div class="foot">تقرير الوصول — زود PDF</div>
    <section class="page">
      <h1>تقرير إمكانية الوصول</h1>
      <h2>مقدمة</h2>
      <p>يشرح هذا المستند كيف يقرأ قارئ الشاشة ملف PDF بترتيب صحيح.</p>
      <p class="en">This paragraph is written in English for the language test.</p>
      <ol><li>البند الأول في القائمة</li><li>البند الثاني في القائمة</li><li>البند الثالث في القائمة</li></ol>
      <table>
        <tr><th>المدينة</th><th>السكان</th></tr>
        <tr><td>الرياض</td><td>٧٠٠٠</td></tr>
        <tr><td>جدة</td><td>٤٠٠٠</td></tr>
      </table>
      <img src="${picture}" alt="">
      <p>زوروا <a href="https://example.com/">موقع المثال</a> لمعرفة المزيد.</p>
    </section>
    <section>
      <h2>الخلاصة</h2>
      <p>الفقرة الأخيرة في الصفحة الثانية تختم التقرير.</p>
      <ul><li>• نقطة أولى</li><li>• نقطة ثانية</li></ul>
    </section>
  </div>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`);
await page.evaluate(() => document.fonts.ready);
const pdf = await page.pdf({ format: 'A4', printBackground: true, tagged: false, preferCSSPageSize: true });
fs.writeFileSync(path.join(here, 'a11y-ar.pdf'), pdf);
console.log('wrote a11y-ar.pdf', pdf.byteLength, 'bytes');
await browser.close();
