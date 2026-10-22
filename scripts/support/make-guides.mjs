// Makes the help guides from the one source, packages/ui/src/support/articles.ts:
//   - a PDF guide per article and language, for the app (packages/ui/public/guides/)
//     and the website (website/help/guides/), drawn by Chromium so Arabic is shaped
//     the way a browser shapes it;
//   - the website's help pages, website/help/index.html and website/en/help/index.html.
// Run after changing an article:
//   node --experimental-strip-types scripts/support/make-guides.mjs
// Needs Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH, or CHROMIUM=/path/to/chrome).
import { mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Playwright lives with the web app's tests.
const playwright = await import(pathToFileURL(createRequire(join(root, 'apps/web/package.json')).resolve('@playwright/test')).href);
const chromium = playwright.chromium ?? playwright.default.chromium;
const { ARTICLES, CATEGORIES, FAQ, KNOWN_ISSUES } = await import(pathToFileURL(join(root, 'packages/ui/src/support/articles.ts')).href);

const appOut = join(root, 'packages/ui/public/guides');
const webOut = join(root, 'website/help/guides');
const webShots = join(root, 'website/help/shots');
// Last run's guides go; the pictures in public/guides/shots stay (make-shots.mjs makes those).
mkdirSync(appOut, { recursive: true });
for (const name of readdirSync(appOut)) if (name.endsWith('.pdf')) rmSync(join(appOut, name));
for (const dir of [webOut, webShots]) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// The website's own faces (SIL OFL), already cut down to the letters used: small guides.
const font = (name) => pathToFileURL(join(root, 'website/assets/fonts', name)).href;
const logo = (lang) => readFileSync(join(root, `website/assets/brand/logo-${lang}.svg`), 'utf8').replace(/<\?xml[^>]*>/, '').replace(/<!--[\s\S]*?-->/g, '');
// The step pictures, taken from the app by make-shots.mjs.
const shots = join(root, 'packages/ui/public/guides/shots');
const shot = (step, lang) => (step.pic && existsSync(join(shots, `${step.pic}-${lang}.jpg`)) ? join(shots, `${step.pic}-${lang}.jpg`) : null);
const moving = (step, lang) => join(shots, `${step.pic}-${lang}.webp`);

const WORDS = {
  ar: { guide: 'دليل', steps: 'الخطوات', tips: 'نصائح', inApp: 'في التطبيق: افتح مساعدة › المساعدة والدعم، وابحث عن هذا الدليل، ثم اضغط «أرني» أو «نفّذه عني».', name: 'محرر زود PDF', url: 'pdf.zood.sa/help', desktop: 'في تطبيق الكمبيوتر' },
  en: { guide: 'Guide', steps: 'Steps', tips: 'Tips', inApp: 'In the app: open Help › Help & Support, find this guide, then press Show me or Do it for me.', name: 'ZOOD PDF', url: 'pdf.zood.sa/en/help', desktop: 'In the desktop app' },
};

function guideHtml(article, lang) {
  const w = WORDS[lang];
  const category = CATEGORIES.find((one) => one.id === article.category);
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head><meta charset="utf-8"><style>
@font-face { font-family: Vazirmatn; src: url('${font('vazirmatn.woff2')}'); font-weight: 100 900; }
@font-face { font-family: Inter; src: url('${font('inter.woff2')}'); font-weight: 100 900; }
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; font-family: ${lang === 'ar' ? 'Vazirmatn, Inter' : 'Inter, Vazirmatn'}, sans-serif; color: #09203f; background: #fff; }
.page { position: relative; min-height: 297mm; padding: 22mm 20mm 26mm; }
.band { position: absolute; inset: 0 0 auto 0; height: 9mm; background: linear-gradient(90deg, #041e42, #1b3a66 60%, #ae8b66); }
header { display: flex; justify-content: space-between; align-items: center; margin-top: 4mm; }
header svg { height: 13mm; width: auto; }
.kind { font-size: 10pt; color: #ae8b66; font-weight: 700; letter-spacing: .04em; }
h1 { font-size: 26pt; line-height: 1.25; margin: 14mm 0 4mm; font-weight: 700; }
.summary { font-size: 13pt; line-height: 1.6; color: #3d4f69; margin: 0 0 10mm; }
h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: .06em; color: #ae8b66; margin: 0 0 4mm; }
ol { list-style: none; margin: 0; padding: 0; counter-reset: s; }
li.step { counter-increment: s; padding: 5mm 6mm; margin-bottom: 4mm; background: #f5f1ed; border-radius: 4mm; font-size: 13pt; line-height: 1.6; break-inside: avoid; }
li.step .say { display: flex; gap: 5mm; align-items: flex-start; }
li.step .say::before { content: counter(s); flex: none; display: grid; place-items: center; width: 9mm; height: 9mm; border-radius: 50%; background: #041e42; color: #fff; font-weight: 700; font-size: 12pt; }
li.step img { display: block; width: 100%; margin-top: 4mm; border-radius: 2.5mm; border: 0.3mm solid #e2d6c8; }
.tips { margin-top: 8mm; padding: 5mm 6mm; border: 0.4mm solid #e2d6c8; border-radius: 4mm; font-size: 11.5pt; line-height: 1.6; color: #3d4f69; }
.tips p { margin: 0 0 2mm; }
.tips p:last-child { margin: 0; }
.inapp { margin-top: 8mm; font-size: 10.5pt; color: #6b7a90; line-height: 1.6; }
.desktop { display: inline-block; margin-inline-start: 3mm; padding: .5mm 3mm; border-radius: 3mm; background: #e9eef6; font-size: 9pt; color: #1b3a66; vertical-align: middle; }
footer { position: absolute; bottom: 12mm; inset-inline: 20mm; display: flex; justify-content: space-between; font-size: 9pt; color: #8a97ab; border-top: 0.3mm solid #e6e9ef; padding-top: 3mm; }
</style></head>
<body><div class="page">
<div class="band"></div>
<header>${logo(lang)}<span class="kind">${escape(w.guide)} · ${escape(category.title[lang])}</span></header>
<h1>${escape(article.title[lang])}${article.desktopOnly ? `<span class="desktop">${escape(w.desktop)}</span>` : ''}</h1>
<p class="summary">${escape(article.summary[lang])}</p>
<h2>${escape(w.steps)}</h2>
<ol>${article.steps.map((step) => `<li class="step"><div class="say"><span>${escape(step[lang])}</span></div>${shot(step, lang) ? `<img src="${pathToFileURL(shot(step, lang)).href}" alt="">` : ''}</li>`).join('')}</ol>
${article.tips ? `<div class="tips"><h2>${escape(w.tips)}</h2>${article.tips.map((tip) => `<p>${escape(tip[lang])}</p>`).join('')}</div>` : ''}
${article.guide ? `<p class="inapp">${escape(w.inApp)}</p>` : ''}
<footer><span><bdi>${escape(w.name)}</bdi> · <bdi dir="ltr">${escape(w.url)}</bdi></span><span>${escape(article.id)}</span></footer>
</div></body></html>`;
}

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage();
let made = 0;
for (const article of ARTICLES) {
  for (const lang of ['ar', 'en']) {
    await page.setContent(guideHtml(article, lang), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, tagged: true });
    const name = `${article.id}-${lang}.pdf`;
    writeFileSync(join(appOut, name), pdf);
    copyFileSync(join(appOut, name), join(webOut, name));
    for (const step of article.steps) {
      if (!shot(step, lang)) continue;
      copyFileSync(shot(step, lang), join(webShots, `${step.pic}-${lang}.jpg`));
      if (existsSync(moving(step, lang))) copyFileSync(moving(step, lang), join(webShots, `${step.pic}-${lang}.webp`));
    }
    made += 1;
  }
}
await browser.close();

/* ------------------------------------------------------------ website pages */

const PAGE = {
  ar: {
    title: 'الأدلة · زود PDF',
    description: 'أدلة استخدام محرر زود PDF خطوة بخطوة، والأسئلة الشائعة.',
    heading: 'كيف نساعدك؟',
    lead: 'كل دليل هنا موجود في التطبيق أيضًا: افتح مساعدة › المساعدة والدعم (أو F1)، واسأل بكلماتك، ثم اضغط «أرني» ليريك الطريق أو «نفّذه عني» لينفّذه وأنت تشاهد.',
    pdf: 'الدليل PDF',
    faq: 'أسئلة شائعة',
    known: 'حدود معروفة',
    report: 'لم تجد ما تبحث عنه؟ من داخل التطبيق: مساعدة › الإبلاغ عن مشكلة، دون حساب، وتتابع حالة بلاغك حتى يُصلح.',
    other: { href: '/en/help/', label: 'English' },
    home: '/',
    support: { href: '/support/', label: 'الدعم' },
    desktop: 'على الكمبيوتر',
  },
  en: {
    title: 'Guides · ZOOD PDF',
    description: 'Step-by-step guides for ZOOD PDF, and common questions.',
    heading: 'How can we help?',
    lead: 'Every guide here is in the app too: open Help › Help & Support (or F1), ask in your own words, then press Show me to see the way, or Do it for me to watch it done.',
    pdf: 'PDF guide',
    faq: 'Common questions',
    known: 'Known limits',
    report: 'Didn’t find it? In the app: Help › Report a problem. No account, and you follow your report until it is fixed.',
    other: { href: '/help/', label: 'العربية' },
    home: '/en/',
    support: { href: '/en/support/', label: 'Support' },
    desktop: 'Desktop',
  },
};

function helpPage(lang) {
  const p = PAGE[lang];
  const url = lang === 'ar' ? 'https://pdf.zood.sa/help/' : 'https://pdf.zood.sa/en/help/';
  const sections = CATEGORIES.map((category) => {
    const list = ARTICLES.filter((one) => one.category === category.id);
    if (list.length === 0) return '';
    return `<section class="help-group"><h2>${escape(category.title[lang])}</h2>${list
      .map(
        (article) => `<article class="help-article" id="${article.id}">
<h3>${escape(article.title[lang])}${article.desktopOnly ? ` <span class="help-tag">${escape(p.desktop)}</span>` : ''}</h3>
<p class="help-summary">${escape(article.summary[lang])}</p>
<ol>${article.steps.map((step) => `<li>${escape(step[lang])}${shot(step, lang) ? `<picture>${existsSync(moving(step, lang)) ? `<source srcset="/help/shots/${step.pic}-${lang}.webp" type="image/webp" media="(prefers-reduced-motion: no-preference)">` : ''}<img src="/help/shots/${step.pic}-${lang}.jpg" alt="" loading="lazy" width="1080" height="672"></picture>` : ''}</li>`).join('')}</ol>
${article.tips ? `<ul class="help-tips">${article.tips.map((tip) => `<li>${escape(tip[lang])}</li>`).join('')}</ul>` : ''}
<p class="help-links"><a href="/help/guides/${article.id}-${lang}.pdf" download>${escape(p.pdf)}</a>${article.video ? ` · <a href="${escape(article.video)}" rel="noopener">▶</a>` : ''}</p>
</article>`,
      )
      .join('\n')}</section>`;
  }).join('\n');
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}" data-page="help">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escape(p.title)}</title>
<meta name="description" content="${escape(p.description)}">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="ar" href="https://pdf.zood.sa/help/">
<link rel="alternate" hreflang="en" href="https://pdf.zood.sa/en/help/">
<link rel="alternate" hreflang="x-default" href="https://pdf.zood.sa/help/">
<meta name="theme-color" content="#f5f1ed" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#041e42" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/css/help.css">
</head>
<body>
<!-- Generated by scripts/support/make-guides.mjs from packages/ui/src/support/articles.ts. Edit the articles, not this file. -->
<header class="help-bar">
<a class="help-logo" href="${p.home}"><img src="/assets/brand/logo-${lang}.svg" alt="ZOOD" width="120" height="37"></a>
<nav><a href="${p.support.href}">${escape(p.support.label)}</a><a href="${p.other.href}" lang="${lang === 'ar' ? 'en' : 'ar'}">${escape(p.other.label)}</a></nav>
</header>
<main class="help">
<h1>${escape(p.heading)}</h1>
<p class="help-lead">${escape(p.lead)}</p>
<nav class="help-index">${ARTICLES.map((article) => `<a href="#${article.id}">${escape(article.title[lang])}</a>`).join('')}</nav>
${sections}
<section class="help-group" id="faq"><h2>${escape(p.faq)}</h2>${FAQ.map((one) => `<details class="help-faq"><summary>${escape(one.q[lang])}</summary><p>${escape(one.a[lang])}</p></details>`).join('')}</section>
<section class="help-group" id="known"><h2>${escape(p.known)}</h2><ul class="help-known">${KNOWN_ISSUES.map((one) => `<li>${escape(one[lang])}</li>`).join('')}</ul></section>
<p class="help-report">${escape(p.report)}</p>
</main>
</body>
</html>
`;
}

mkdirSync(join(root, 'website/help'), { recursive: true });
mkdirSync(join(root, 'website/en/help'), { recursive: true });
writeFileSync(join(root, 'website/help/index.html'), helpPage('ar'));
writeFileSync(join(root, 'website/en/help/index.html'), helpPage('en'));
if (!existsSync(join(root, 'website/css/help.css'))) console.warn('website/css/help.css is missing');
console.log(`made ${made} PDF guides and the two help pages`);
