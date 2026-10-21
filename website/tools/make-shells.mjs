// Writes the small HTML files each URL serves (/, /en/, /privacy/, …). They
// hold only what must be in the HTML before any script runs: the language and
// direction, the title, description, social preview and alternate-language
// links. Everything else comes from js/story.js and js/legal.js.
// Re-run after changing a title or description:  node website/tools/make-shells.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SITE, CHAPTERS, UI } from '../js/story.js';
import { PAGES } from '../js/legal.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const hero = CHAPTERS[0];
const plain = (s) => s.replace(/\[\[|\]\]/g, '');
const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
const path = (lang, slug) => (lang === 'ar' ? '/' : '/en/') + (slug ? `${slug}/` : '');

function shell(lang, slug) {
  const name = SITE.name[lang];
  const title = slug
    ? `${PAGES[slug].title[lang]} · ${name}`
    : `${name}: ${plain(hero.title[lang])}`;
  const description = slug ? PAGES[slug].description[lang] : hero.lead[lang];
  const url = SITE.url + path(lang, slug);
  return `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}" data-page="${slug || 'story'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="ar" href="${SITE.url + path('ar', slug)}">
<link rel="alternate" hreflang="en" href="${SITE.url + path('en', slug)}">
<link rel="alternate" hreflang="x-default" href="${SITE.url + path('ar', slug)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:locale" content="${lang === 'ar' ? 'ar_SA' : 'en_US'}">
<meta property="og:image" content="${SITE.url}/assets/og/og-${lang}.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#f5f1ed" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#041e42" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/brand/apple-touch-icon.png">
<link rel="preload" href="/assets/fonts/${lang === 'ar' ? 'vazirmatn' : 'inter'}.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/css/site.css">
<script src="/js/boot.js"></script>
<script type="module" src="/js/main.js"></script>
</head>
<body>
<noscript><p style="padding:96px 16px 0;max-width:760px;margin:auto">${esc(UI.noscript[lang])}</p></noscript>
</body>
</html>
`;
}

for (const lang of ['ar', 'en']) {
  for (const slug of ['', 'privacy', 'terms', 'support']) {
    const dir = ROOT + path(lang, slug).slice(1);
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}index.html`, shell(lang, slug));
  }
}
console.log('shells written');
