// Draws the social preview pictures (assets/og/og-ar.png, og-en.png) from the
// site's own fonts, mark and pattern.  node website/tools/make-og.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CHAPTERS, SITE } from '../js/story.js';

const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))(
  '@playwright/test',
);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const hero = CHAPTERS[0];
// Masks need same-origin images, which file: pages do not get, so the SVGs go in as data URLs.
const svg = (name) =>
  `data:image/svg+xml;base64,${readFileSync(`${ROOT}assets/brand/${name}.svg`).toString('base64')}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
for (const lang of ['ar', 'en']) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  const title = hero.title[lang].replace(/\[\[(.*?)\]\]/, '<span class="hl">$1</span>');
  const html = `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><style>
    @font-face{font-family:V;src:url(file://${ROOT}assets/fonts/vazirmatn.woff2)}
    @font-face{font-family:I;src:url(file://${ROOT}assets/fonts/inter.woff2)}
    body{margin:0;width:1200px;height:630px;background:linear-gradient(170deg,#11294b,#041e42 60%,#021631);color:#f5f1ed;font-family:${lang === 'ar' ? 'V' : 'I, V'};position:relative;overflow:hidden}
    .p{position:absolute;inset:0 auto 0 0;width:46%;background:#a7c6ed;opacity:.13;-webkit-mask:url(${svg('pattern')}) 0 0/150px auto repeat}
    [dir=ltr] .p{inset:0 0 0 auto}
    .in{position:absolute;inset:90px 80px;display:flex;flex-direction:column;justify-content:space-between;width:640px}
    [dir=rtl] .in{right:80px;left:auto}
    .b{display:flex;align-items:center;gap:16px;font-size:34px;font-weight:600}
    .m{width:58px;height:47px;background:#c9a27c;-webkit-mask:url(${svg('mark')}) center/contain no-repeat}
    h1{font-size:${lang === 'ar' ? 76 : 80}px;line-height:1.3;margin:0;font-weight:600}
    .hl{background:linear-gradient(transparent 58%,rgb(151 119 86/.6) 58%,rgb(151 119 86/.6) 94%,transparent 94%)}
    p{font-size:28px;color:#b5aea8;margin:18px 0 0}
  </style></head><body><div class="p"></div><div class="in"><div class="b"><span class="m"></span>${SITE.name[lang]}</div><div><h1>${title}</h1><p>${hero.lead[lang]}</p></div></div></body></html>`;
  // Loaded from a file so the fonts and masks (file: URLs) are allowed.
  mkdirSync(`${ROOT}tools/samples/out`, { recursive: true });
  writeFileSync(`${ROOT}tools/samples/out/og-${lang}.html`, html);
  await page.goto(`file://${ROOT}tools/samples/out/og-${lang}.html`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${ROOT}assets/og/og-${lang}.png` });
  await page.close();
}
await browser.close();
