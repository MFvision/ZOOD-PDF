// Generates the Edit tool fixture with Chromium's PDF printer (a Chrome-made PDF): Arabic paragraphs
// in Noto Naskh Arabic (OFL, from @embedpdf/fonts-arabic), one picture (a PNG made here) and an
// English line. Run: node tests/fixtures/generate-edit.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fontDir = fs.realpathSync(path.join(root, 'packages/ui/node_modules/@embedpdf/fonts-arabic/fonts'));
const naskh = pathToFileURL(path.join(fontDir, 'NotoNaskhArabic-Regular.ttf')).href;

/** A tiny RGB PNG (w×h) with two colour bands, encoded by hand. */
export function png(w, h) {
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
  @page { size: A4; margin: 22mm; }
  body { font: 14pt/1.7 Naskh, serif; color: #111; }
  h1 { font-size: 22pt; margin: 0 0 6mm; }
  p { margin: 0 0 5mm; }
  img { display: block; width: 60mm; height: 40mm; margin: 4mm 0 8mm; }
  .en { font-family: Helvetica, Arial, sans-serif; direction: ltr; text-align: left; }
`;

const body = `
  <div lang="ar" dir="rtl"><h1>تقرير التحرير</h1>
    <p>هذه الجملة الأولى سيتم تعديلها في اختبار التحرير.</p>
    <img src="${picture}" alt="">
    <p>الفقرة الثانية تبقى كما هي دون أي تغيير.</p>
    <p class="en">Visit the ZOOD PDF site for more.</p>
  </div>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`);
await page.evaluate(() => document.fonts.ready);
const pdf = await page.pdf({ format: 'A4', printBackground: true, tagged: true });
fs.writeFileSync(path.join(here, 'edit-ar.pdf'), pdf);
fs.writeFileSync(path.join(here, 'edit-picture.png'), png(40, 60));
console.log('wrote edit-ar.pdf', pdf.byteLength, 'bytes, edit-picture.png');
await browser.close();
