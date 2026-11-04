// Frames the raw App Store screenshots (from the "App Store screenshots"
// workflow) with ZOOD's ground, logo and a caption, at the exact sizes App
// Store Connect takes: iPhone 6.9" 1320x2868, iPad 13" 2064x2752.
//   node scripts/ios/store-frames/frame.mjs <shots-dir> <out-dir>
// <shots-dir>/<device>/<lang>/<name>.png  ->  <out-dir>/<device>/<lang>/<name>.png
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(require('node:child_process').execSync('npm root -g').toString().trim() + '/playwright')); }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, '../../../website/assets');
const [shotsDir, outDir] = process.argv.slice(2);
const captions = JSON.parse(fs.readFileSync(path.join(here, 'captions.json'), 'utf8'));
const b64 = (p) => fs.readFileSync(p).toString('base64');
const font = b64(path.join(site, 'fonts/vazirmatn.woff2'));
const svg = (f) => fs.readFileSync(path.join(site, 'brand', f), 'utf8').replace(/<\?xml[^>]*>/, '').replace(/<!--[\s\S]*?-->/g, '');
const logo = { ar: svg('logo-ar.svg'), en: svg('logo-en.svg') };

function html({ w, h, pad, shot, lang, lines, dark }) {
  const rtl = lang === 'ar';
  const shotW = pad ? Math.round(w * 0.84) : Math.round(w * 0.80);
  return `<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>
  @font-face{font-family:V;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:100 900}
  *{margin:0;box-sizing:border-box}
  body{width:${w}px;height:${h}px;overflow:hidden;font-family:V,sans-serif;
    background:${dark ? 'radial-gradient(120% 80% at 50% 0%,#11294b 0%,#041e42 45%,#021631 100%)' : 'radial-gradient(120% 80% at 50% 0%,#ffffff 0%,#f5f1ed 55%,#e9e2d8 100%)'};
    color:${dark ? '#f5f1ed' : '#041e42'};position:relative}
  .logo{position:absolute;top:${pad ? 100 : 140}px;left:0;right:0;display:flex;justify-content:center;height:${pad ? 110 : 130}px}
  .logo svg{height:100%;width:auto}
  .logo svg *{fill:${dark ? '#f5f1ed' : '#041e42'}}
  h1{position:absolute;top:${pad ? 250 : 320}px;left:80px;right:80px;text-align:center;font-weight:800;
    font-size:${pad ? 112 : 118}px;line-height:1.18;letter-spacing:${rtl ? 0 : -2}px}
  h1 span{display:block}
  h1 span+span{color:#ae8b66}
  .dev{position:absolute;left:50%;transform:translateX(-50%);top:${pad ? 580 : 690}px;width:${shotW}px;
    border-radius:${pad ? 54 : 96}px;padding:${pad ? 22 : 26}px;background:#0b0f17;
    box-shadow:0 60px 120px rgba(4,30,66,.35),0 0 0 3px ${dark ? 'rgba(174,139,102,.55)' : 'rgba(4,30,66,.12)'}}
  .dev img{display:block;width:100%;border-radius:${pad ? 34 : 72}px}
  </style></head><body>
  <div class="logo">${logo[lang]}</div>
  <h1>${lines.map((l) => `<span>${l}</span>`).join('')}</h1>
  <div class="dev"><img src="data:image/png;base64,${b64(shot)}"></div>
  </body></html>`;
}

const browser = await chromium.launch();
for (const device of fs.readdirSync(shotsDir)) {
  // The iPhone Duo's inner screen shows the iPad layout (regular width), so
  // its pictures are the iPad's, framed at the Duo's size.
  const duo = /duo/i.test(device);
  const pad = duo || /ipad/i.test(device);
  const [w, h] = duo ? [1878, 2670] : pad ? [2064, 2752] : [1320, 2868];
  for (const lang of fs.readdirSync(path.join(shotsDir, device))) {
    const dir = path.join(shotsDir, device, lang);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort()) {
      const name = file.replace(/\.png$/, '');
      const cap = captions[name];
      if (!cap) { console.log('no caption for', name); continue; }
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      await page.setContent(html({ w, h, pad, shot: path.join(dir, file), lang, lines: cap[lang], dark: name.includes('dark') }));
      await page.waitForTimeout(150);
      const out = path.join(outDir, device, lang);
      fs.mkdirSync(out, { recursive: true });
      await page.screenshot({ path: path.join(out, file) });
      await page.close();
      console.log('framed', device, lang, name);
    }
  }
}
await browser.close();
