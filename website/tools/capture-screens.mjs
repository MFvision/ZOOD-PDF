// Captures the website's device screens from the real web app, in the Zood
// colours (zood-look.css), Arabic and English, light and dark.
//
//   pnpm build:core && pnpm --filter @warraq/web build     (once)
//   node website/tools/make-samples.mjs
//   (cd apps/web && npx vite preview --host 127.0.0.1 --port 4391) &
//   node website/tools/capture-screens.mjs [screen-name ...]
//
// Writes website/assets/<lang>/<device>/<file>-<theme>.webp via a PNG and
// Python's Pillow (python3 -m pip install pillow).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SCREENS } from '../js/story.js';

const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))(
  '@playwright/test',
);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SAMPLES = `${ROOT}tools/samples/out/`;
const APP = process.env.APP_URL ?? 'http://127.0.0.1:4391/';
const look = readFileSync(`${ROOT}tools/zood-look.css`, 'utf8');
const vazir = readFileSync(`${ROOT}assets/fonts/vazirmatn.woff2`).toString('base64');
const fontFace = `@font-face{font-family:Vazirmatn;src:url(data:font/woff2;base64,${vazir}) format('woff2');font-weight:100 900}`;

// Viewport in CSS px; the scale makes the file the size story.js expects.
const DEVICES = {
  phone: { width: 390, height: 845, scale: 640 / 390 },
  tablet: { width: 1024, height: 768, scale: 1600 / 1024 },
  desktop: { width: 1440, height: 900, scale: 1600 / 1440 },
  browser: { width: 1440, height: 900, scale: 1600 / 1440 },
};

const NAMES = {
  edit: { ar: 'تحرير', en: 'Edit' },
  organize: { ar: 'تنظيم الصفحات', en: 'Organize pages' },
  comment: { ar: 'تعليق', en: 'Comment' },
  fillSign: { ar: 'تعبئة وتوقيع', en: 'Fill & sign' },
  redact: { ar: 'تنقيح', en: 'Redact' },
  ocr: { ar: 'مسح ضوئي وتعرّف على النص', en: 'Scan & OCR' },
  prepareForm: { ar: 'إعداد نموذج', en: 'Prepare form' },
};

const sample = (name, lang) => `${SAMPLES}${name}-${lang}.pdf`;

async function open(page, file) {
  await page.locator('input[type="file"]').first().setInputFiles(file);
  await page.locator('embedpdf-container').waitFor();
  await page.waitForTimeout(2500);
}

async function tool(page, lang, id) {
  const toolbar = page.getByRole('toolbar').first();
  await toolbar
    .getByRole('button', { name: lang === 'ar' ? /^اختيار أداة/ : /^Choose a tool/ })
    .click();
  await page.getByRole('dialog').getByRole('radio', { name: NAMES[id][lang] }).click();
  await page.waitForTimeout(1500);
}

async function tryStep(fn) {
  try {
    await fn();
  } catch (error) {
    console.warn('  step skipped:', String(error.message).split('\n')[0]);
  }
}

// What each screen shows. `device` limits a flow to the frames that use it.
const FLOWS = {
  home: async () => {},
  read: async (page, lang, device) => {
    await open(page, sample('report', lang));
    if (device !== 'phone') {
      await tryStep(() =>
        page
          .getByRole('toolbar')
          .first()
          .getByRole('button', {
            name: lang === 'ar' ? /الشريط الجانبي|الصور المصغرة/ : /sidebar|Thumbnails/i,
          })
          .first()
          .click({ timeout: 3000 }),
      );
      await page.waitForTimeout(1200);
    }
  },
  search: async (page, lang) => {
    await open(page, sample('invoice', lang));
    await page.keyboard.press('Control+f');
    await page.waitForTimeout(600);
    const box = page.getByPlaceholder(lang === 'ar' ? 'بحث' : 'Search').last();
    await box.fill(lang === 'ar' ? 'الفاتوره' : 'invoice');
    await box.press('Enter');
    await page.waitForTimeout(1500);
  },
  edit: async (page, lang) => {
    await open(page, sample('report', lang));
    await tool(page, lang, 'edit');
    await page.waitForTimeout(1500);
  },
  comment: async (page, lang) => {
    await open(page, sample('report', lang));
    await tool(page, lang, 'comment');
  },
  pages: async (page, lang) => {
    await open(page, sample('report', lang));
    await tool(page, lang, 'organize');
  },
  form: async (page, lang) => {
    await open(page, sample('form', lang));
    await tool(page, lang, 'prepareForm');
    await tryStep(() =>
      page
        .locator('.pane-end')
        .getByRole('button', { name: lang === 'ar' ? /اكتشاف الحقول/ : /Detect fields/ })
        .first()
        .click({ timeout: 5000 }),
    );
    await page.waitForTimeout(2500);
  },
  sign: async (page, lang) => {
    await open(page, sample('form', lang));
    await tool(page, lang, 'fillSign');
  },
  redact: async (page, lang) => {
    await open(page, sample('invoice', lang));
    await tool(page, lang, 'redact');
    // Find the email, phone, ID, IBAN and card patterns, then mark what was found.
    await tryStep(async () => {
      const pane = page.locator('.pane-end');
      const boxes = pane.getByRole('checkbox');
      for (let i = 0; i < (await boxes.count()); i++)
        await boxes
          .nth(i)
          .check({ timeout: 2000 })
          .catch(() => {});
      await pane
        .getByRole('button', { name: lang === 'ar' ? /^بحث$/ : /^Find$/ })
        .first()
        .click({ timeout: 3000 });
      await page.waitForTimeout(2000);
      await pane
        .getByRole('button', { name: lang === 'ar' ? /^تعليم المحدد/ : /^Mark selected/ })
        .first()
        .click({ timeout: 3000 });
      await page.waitForTimeout(1500);
    });
  },
  scan: async (page, lang) => {
    await open(page, sample('scan', lang));
    await tool(page, lang, 'ocr');
  },
};

// Which devices need which screens (the chapters' devices plus the wall's phone).
const NEEDS = {
  phone: ['home', 'read', 'search', 'comment', 'pages', 'sign', 'redact', 'scan'],
  tablet: ['read', 'comment'],
  desktop: ['edit', 'pages', 'sign', 'redact', 'scan'],
  browser: ['form'],
};

const only = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const tmp = `${ROOT}tools/samples/out/png/`;
mkdirSync(tmp, { recursive: true });

for (const [device, screens] of Object.entries(NEEDS)) {
  const size = DEVICES[device];
  for (const screen of screens) {
    if (only.length && !only.includes(screen) && !only.includes(device)) continue;
    for (const lang of ['ar', 'en']) {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: { width: size.width, height: size.height },
          deviceScaleFactor: size.scale,
          serviceWorkers: 'block',
          colorScheme: theme,
          bypassCSP: true,
          hasTouch: device === 'phone' || device === 'tablet',
          isMobile: device === 'phone',
          locale: lang === 'ar' ? 'ar-SA' : 'en-US',
        });
        const page = await context.newPage();
        await page.addInitScript(
          ([l, t]) => {
            if (!localStorage.getItem('warraq.preferences'))
              localStorage.setItem('warraq.preferences', JSON.stringify({ lang: l, theme: t }));
          },
          [lang, theme],
        );
        await page.goto(APP);
        await page.addStyleTag({ content: fontFace + look });
        await page.locator('.shell').waitFor();
        console.log(device, screen, lang, theme);
        await tryStep(() => FLOWS[screen](page, lang, device));
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(600);
        const png = `${tmp}${device}-${screen}-${lang}-${theme}.png`;
        await page.screenshot({ path: png });
        const dir = `${ROOT}assets/${lang}/${device}/`;
        mkdirSync(dir, { recursive: true });
        const out = `${dir}${SCREENS.files[screen]}-${theme}.webp`;
        execFileSync('python3', [
          '-c',
          'import sys; from PIL import Image; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2], "WEBP", quality=80, method=6)',
          png,
          out,
        ]);
        await context.close();
      }
    }
  }
}
await browser.close();
if (!process.env.KEEP_PNG) rmSync(tmp, { recursive: true, force: true });
