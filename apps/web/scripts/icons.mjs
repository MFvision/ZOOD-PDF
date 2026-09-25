// Renders the original ZOOD PDF app mark (packages/ui/src/app/app-mark.svg) to the PNG icons used by
// the PWA manifest and the Chrome extension. Run: node apps/web/scripts/icons.mjs (uses Playwright's
// Chromium; outputs are committed).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const svg = fs.readFileSync(path.join(root, 'packages/ui/src/app/app-mark.svg'), 'utf8').trim();
// The glyph alone (defs + page + stroke), without the rounded tile and its sheen.
const inner = svg
  .replace(/^<svg[^>]*>/, '')
  .replace(/<\/svg>$/, '')
  .replace(/<rect [^>]*\/>/g, '');
// Maskable: full-bleed background, artwork inside the 80% safe zone.
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><linearGradient id="mb" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#4f9dff"/><stop offset=".55" stop-color="#3a63f0"/><stop offset="1" stop-color="#7b4df2"/>
  </linearGradient></defs>
  <rect width="64" height="64" fill="url(#mb)"/>
  <g transform="translate(6.4 6.4) scale(0.8)">${inner}</g>
</svg>`;

const outputs = [
  { dir: 'apps/web/public/icons', files: [['icon-192.png', 192, svg], ['icon-512.png', 512, svg], ['icon-maskable-512.png', 512, maskable]] },
  { dir: 'apps/extension/public/icons', files: [['icon-16.png', 16, svg], ['icon-32.png', 32, svg], ['icon-48.png', 48, svg], ['icon-128.png', 128, svg]] },
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const { dir, files } of outputs) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const [name, size, markup] of files) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${markup.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
    );
    await page.screenshot({ path: path.join(root, dir, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log('wrote', path.join(dir, name));
  }
}
fs.writeFileSync(path.join(root, 'apps/web/public/icons/icon.svg'), `${svg}\n`);
await browser.close();
