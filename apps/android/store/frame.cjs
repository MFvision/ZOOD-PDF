const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const site = '/home/user/ZOOD-PDF/website/assets';
const b64 = (p) => fs.readFileSync(p).toString('base64');
const font = b64(path.join(site, 'fonts/vazirmatn.woff2'));
const svg = (f) => fs.readFileSync(path.join(site, 'brand', f), 'utf8').replace(/<\?xml[^>]*>/, '').replace(/<!--[\s\S]*?-->/g, '');
const logo = { ar: svg('logo-ar.svg'), en: svg('logo-en.svg') };
const caps = {
  '01-home': { ar: ['ملفاتك كلها', 'في مكان واحد'], en: ['All your files', 'in one place'] },
  '02-read': { ar: ['عربي يبقى', 'عربياً'], en: ['Arabic that', 'stays Arabic'] },
  '03-tools': { ar: ['مساعد ZOOD', 'يعمل على هاتفك'], en: ['Ask ZOOD,', 'right on your phone'] },
  '05-dark': { ar: ['مريح للعين', 'ليلاً'], en: ['Easy on the eyes', 'at night'] },
};
const page = (shot, lang, lines, dark) => `<!doctype html><html dir="${lang==='ar'?'rtl':'ltr'}"><head><meta charset="utf-8"><style>
@font-face{font-family:V;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:100 900}
*{margin:0;box-sizing:border-box}
body{width:1080px;height:1920px;overflow:hidden;font-family:V,sans-serif;position:relative;
background:${dark?'radial-gradient(120% 80% at 50% 0%,#11294b 0%,#041e42 45%,#021631 100%)':'radial-gradient(120% 80% at 50% 0%,#ffffff 0%,#f5f1ed 55%,#e9e2d8 100%)'};color:${dark?'#f5f1ed':'#041e42'}}
.logo{position:absolute;top:70px;left:0;right:0;display:flex;justify-content:center;height:78px}
.logo svg{height:100%;width:auto}.logo svg *{fill:${dark?'#f5f1ed':'#041e42'}}
h1{position:absolute;top:180px;left:60px;right:60px;text-align:center;font-weight:800;font-size:84px;line-height:1.18}
h1 span{display:block}h1 span+span{color:#ae8b66}
.dev{position:absolute;left:50%;transform:translateX(-50%);top:450px;width:760px;border-radius:70px;padding:20px;background:#0b0f17;
box-shadow:0 50px 100px rgba(4,30,66,.35),0 0 0 3px ${dark?'rgba(174,139,102,.55)':'rgba(4,30,66,.12)'}}
.dev img{display:block;width:100%;border-radius:52px}
</style></head><body><div class="logo">${logo[lang]}</div><h1>${lines.map(l=>`<span>${l}</span>`).join('')}</h1>
<div class="dev"><img src="data:image/png;base64,${b64(shot)}"></div></body></html>`;
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
  fs.mkdirSync('play/out', { recursive: true });
  for (const f of fs.readdirSync('play/raw').filter(f => f.endsWith('.png'))) {
    const [lang, ...rest] = f.replace('.png','').split('-'); const key = rest.join('-');
    await p.setContent(page('play/raw/'+f, lang, caps[key][lang], key==='05-dark'));
    await p.waitForTimeout(300);
    await p.screenshot({ path: `play/out/${lang}-${key}.png` });
  }
  // feature graphic 1024x500 and icon 512
  for (const lang of ['ar','en']) {
    await p.setViewportSize({ width: 1024, height: 500 });
    await p.setContent(`<!doctype html><html dir="${lang==='ar'?'rtl':'ltr'}"><head><meta charset="utf-8"><style>
@font-face{font-family:V;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:100 900}
*{margin:0}body{width:1024px;height:500px;overflow:hidden;font-family:V,sans-serif;background:radial-gradient(120% 120% at 20% 0%,#11294b 0%,#041e42 55%,#021631 100%);color:#f5f1ed;display:flex;align-items:center;justify-content:center;gap:56px}
.logo{height:120px}.logo svg{height:100%;width:auto}.logo svg *{fill:#f5f1ed}
.t{font-weight:800;font-size:58px;line-height:1.2}.t span{display:block}.t span+span{color:#ae8b66;font-size:40px;font-weight:600}
</style></head><body><div class="logo">${logo[lang]}</div><div class="t"><span>${lang==='ar'?'محرر PDF عربي':'Arabic PDF editor'}</span><span>${lang==='ar'?'اقرأ، وقّع، عدّل. على هاتفك.':'Read, sign, edit. On your phone.'}</span></div></body></html>`);
    await p.waitForTimeout(300); await p.screenshot({ path: `play/out/feature-${lang}.png` });
  }
  await b.close();
})();
