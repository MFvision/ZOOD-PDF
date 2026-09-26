// Fixtures for the Organize / Combine / Compress specs, made by Chromium (like many real files):
//   organize-6.pdf  six pages whose widths differ (400, 420 … 500 pt; order is checkable from the
//                   page sizes), big page numbers, three top-level bookmarks (Chapter One/Two/Three)
//   photo.jpg       a 2000×1500 photo-like JPEG
//   logo.png        a 240×160 PNG with transparency
//   photo-heavy.pdf one page showing photo.jpg at 3×2 inches (≈ 667 dpi) plus text
// Run: node tests/fixtures/generate-organize.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage();

// Pictures drawn on a canvas, encoded by Chromium.
await page.setContent('<!doctype html><canvas id=c></canvas>');
const pictures = await page.evaluate(async () => {
  const c = document.getElementById('c');
  const g = c.getContext('2d');
  c.width = 2000;
  c.height = 1500;
  const grad = g.createLinearGradient(0, 0, 2000, 1500);
  grad.addColorStop(0, '#f4a261');
  grad.addColorStop(0.5, '#2a9d8f');
  grad.addColorStop(1, '#264653');
  g.fillStyle = grad;
  g.fillRect(0, 0, 2000, 1500);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 1800; i++) {
    g.fillStyle = `hsla(${Math.floor(rnd() * 360)}, 70%, ${40 + Math.floor(rnd() * 40)}%, 0.35)`;
    g.beginPath();
    g.arc(rnd() * 2000, rnd() * 1500, 4 + rnd() * 60, 0, Math.PI * 2);
    g.fill();
  }
  const jpeg = c.toDataURL('image/jpeg', 0.92);
  c.width = 240;
  c.height = 160;
  g.clearRect(0, 0, 240, 160);
  g.fillStyle = '#6d28d9';
  g.beginPath();
  g.arc(80, 80, 70, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(255, 149, 0, 0.8)';
  g.fillRect(120, 30, 100, 100);
  const png = c.toDataURL('image/png');
  return { jpeg, png };
});
const b64 = (url) => Buffer.from(url.split(',')[1], 'base64');
fs.writeFileSync(path.join(here, 'photo.jpg'), b64(pictures.jpeg));
fs.writeFileSync(path.join(here, 'logo.png'), b64(pictures.png));

const widths = [400, 420, 440, 460, 480, 500];
const chapters = ['Chapter One', '', 'Chapter Two', '', 'Chapter Three', ''];
const css = `
  ${widths.map((w, i) => `@page p${i + 1} { size: ${w}pt 600pt; margin: 36pt; }`).join('\n')}
  body { font: 14pt Helvetica, Arial, sans-serif; margin: 0; }
  section { break-after: page; }
  section:last-child { break-after: auto; }
  ${widths.map((_, i) => `.p${i + 1} { page: p${i + 1}; }`).join('\n')}
  .num { font-size: 160pt; font-weight: 700; color: #1d4ed8; margin: 40pt 0 0; }
  h1 { font-size: 18pt; margin: 0; }
`;
const body = widths
  .map((_, i) => `<section class="p${i + 1}">${chapters[i] ? `<h1>${chapters[i]}</h1>` : '<p>continued</p>'}<p class="num">${i + 1}</p></section>`)
  .join('');
await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`);
fs.writeFileSync(path.join(here, 'organize-6.pdf'), await page.pdf({ preferCSSPageSize: true, outline: true, tagged: true }));

await page.setContent(
  `<!doctype html><html><head><meta charset="utf-8"><style>@page { size: A4; margin: 20mm; } body { font: 13pt Helvetica, Arial, sans-serif; }</style></head>` +
    `<body><h1>Site photo</h1><img src="${pictures.jpeg}" style="width: 3in; height: 2in"><p>The picture above is far sharper than it needs to be.</p></body></html>`,
);
await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
fs.writeFileSync(path.join(here, 'photo-heavy.pdf'), await page.pdf({ format: 'A4', printBackground: true }));

await browser.close();
for (const f of ['photo.jpg', 'logo.png', 'organize-6.pdf', 'photo-heavy.pdf']) console.log('wrote', f, fs.statSync(path.join(here, f)).size, 'bytes');
