// Takes the pictures in the help guides: the real app, driven step by step,
// with the control each step talks about lit up and pointed at. One picture
// per step that names one (an article step's `pic`), in Arabic and English.
//   packages/ui/public/guides/shots/<pic>-<lang>.jpg   (the app and the PDFs)
// Run after `pnpm --filter @warraq/web exec vite build` (and, for the desktop
// pictures, `vite build --mode tauri --outDir dist-tauri`):
//   CHROMIUM=/path/to/chrome node scripts/support/make-shots.mjs [pic…]
// With names, only those pictures are taken again. Then make the PDFs:
//   node --experimental-strip-types scripts/support/make-guides.mjs
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { SHOTS } from './shots.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const playwright = await import(pathToFileURL(createRequire(join(root, 'apps/web/package.json')).resolve('@playwright/test')).href);
const { chromium } = playwright.chromium ? playwright : playwright.default;
const out = join(root, 'packages/ui/public/guides/shots');
const scratch = join(root, 'apps/web/test-results/shots');
mkdirSync(out, { recursive: true });
mkdirSync(scratch, { recursive: true });

const MESSAGES = {
  en: JSON.parse(readFileSync(join(root, 'packages/ui/src/i18n/en.json'), 'utf8')),
  ar: JSON.parse(readFileSync(join(root, 'packages/ui/src/i18n/ar.json'), 'utf8')),
};

/** The built app, served as the web host serves it. */
async function serve(dist) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path === '/' ? 'index.html' : path;
    try {
      const body = await readFile(join(dist, file));
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const VIEW = { width: 1280, height: 800 };
const SCALE = 1.5;
/** Each picture's size on the page of a guide, before it is shrunk to WIDTH. */
const CROP = { width: 900, height: 560 };
const WIDTH = 1080;

/**
 * Lights up the marked controls: the rest of the window dims a little, each
 * mark gets a bronze ring, and a pointer rests on the first one.
 */
function annotate({ rects, pointer, at: spot }) {
  document.getElementById('zood-shot')?.remove();
  const layer = document.createElement('div');
  layer.id = 'zood-shot';
  // A popover, so it sits above an open dialog too (both are in the top layer; the later one wins).
  layer.popover = 'manual';
  layer.setAttribute('style', 'position:fixed;inset:0;inline-size:100vw;block-size:100vh;margin:0;padding:0;border:0;background:none;overflow:visible;pointer-events:none');
  const w = innerWidth;
  const h = innerHeight;
  const hole = (r, pad) => `<rect x="${r.x - pad}" y="${r.y - pad}" width="${r.width + pad * 2}" height="${r.height + pad * 2}" rx="${Math.min(12, (r.height + pad * 2) / 2)}" fill="black"/>`;
  const ring = (r, pad) =>
    `<rect x="${r.x - pad}" y="${r.y - pad}" width="${r.width + pad * 2}" height="${r.height + pad * 2}" rx="${Math.min(12, (r.height + pad * 2) / 2)}" fill="none" stroke="#c0884a" stroke-width="3"/>` +
    `<rect x="${r.x - pad - 4}" y="${r.y - pad - 4}" width="${r.width + pad * 2 + 8}" height="${r.height + pad * 2 + 8}" rx="${Math.min(16, (r.height + pad * 2 + 8) / 2)}" fill="none" stroke="#c0884a" stroke-opacity="0.35" stroke-width="5"/>`;
  const at = spot ?? (pointer && rects[0] ? { x: rects[0].x + Math.min(rects[0].width * 0.62, rects[0].width - 6), y: rects[0].y + rects[0].height * 0.62 } : null);
  layer.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <defs><mask id="zs-m"><rect width="${w}" height="${h}" fill="white"/>${rects.map((r) => hole(r, 6)).join('')}</mask>
    <filter id="zs-s" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.45"/></filter></defs>
    ${rects.length > 0 ? `<rect width="${w}" height="${h}" fill="#0b1f3a" fill-opacity="0.32" mask="url(#zs-m)"/>` : ''}
    ${rects.map((r) => ring(r, 6)).join('')}
    ${at ? `<g transform="translate(${at.x} ${at.y})" filter="url(#zs-s)"><path d="M0 0 L0 22 L6 16.5 L10 26 L14 24.3 L10 15 L18 15 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></g>` : ''}
  </svg>`;
  document.body.append(layer);
  layer.showPopover();
}

/** The part of the window a picture keeps: around the marks, at least CROP, inside the window. */
function cropAround(rects, full) {
  if (full || rects.length === 0) return { x: 0, y: 0, width: VIEW.width, height: VIEW.height };
  const x0 = Math.min(...rects.map((r) => r.x)) - 24;
  const y0 = Math.min(...rects.map((r) => r.y)) - 24;
  const x1 = Math.max(...rects.map((r) => r.x + r.width)) + 24;
  const y1 = Math.max(...rects.map((r) => r.y + r.height)) + 24;
  let width = Math.max(CROP.width, x1 - x0);
  let height = Math.max(CROP.height, y1 - y0);
  // Keep the shape of the others, so the guide's pictures line up.
  if (width / height > CROP.width / CROP.height) height = width * (CROP.height / CROP.width);
  else width = height * (CROP.width / CROP.height);
  width = Math.min(width, VIEW.width);
  height = Math.min(height, VIEW.height);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const x = Math.max(0, Math.min(VIEW.width - width, cx - width / 2));
  const y = Math.max(0, Math.min(VIEW.height - height, cy - height / 2));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

const corpus = (name) => join(root, 'tests/corpus/arabic/generated', name);

/** What a recipe works with: the page, the app's own words, and the common moves. */
function kit(page, lang) {
  const t = (key) => {
    const value = MESSAGES[lang][key];
    if (value === undefined) throw new Error(`no words for ${key}`);
    return value;
  };
  const kit = {
    page,
    lang,
    t,
    corpus,
    /** Opens a PDF and waits for its first page to be drawn. */
    async open(file = 'chrome-cairo-mixed-invoice.pdf') {
      await page.locator('input[type="file"]').first().setInputFiles(corpus(file));
      await page.locator('.toolbar-title-name').waitFor();
      await page.waitForFunction(() => {
        const root = document.querySelector('embedpdf-container')?.shadowRoot;
        return root ? [...root.querySelectorAll('img')].some((img) => img.complete && img.naturalWidth > 0) : false;
      }, null, { timeout: 30_000 });
      await page.waitForTimeout(600);
    },
    /** A tool's card in the tools pane, back at the list first if a tool is open. */
    async toolCard(tool) {
      const back = page.getByRole('button', { name: t('tool.back') });
      if (await back.isVisible().catch(() => false)) await back.click();
      return page.locator('.pane-end .tool-card', { hasText: t(`tool.${tool}`) }).first();
    },
    async tool(tool) {
      await (await kit.toolCard(tool)).click();
      await page.locator('.toolbar-tool-picker', { hasText: t(`tool.${tool}`) }).waitFor();
      await page.waitForTimeout(500);
    },
    button: (key, scope = page) => scope.getByRole('button', { name: t(key), exact: true }).first(),
    named: (key, scope = page) => scope.getByText(t(key), { exact: true }).first(),
    pane: () => page.locator('.pane-end'),
    /** Opens Settings, from the app's menu as a person does, at a page of it. */
    async settings(section) {
      await page.getByRole('menubar').getByRole('menuitem').first().click();
      await page.getByRole('menuitem', { name: t('settings.open') }).click();
      const dialog = page.locator('.prefs-dialog');
      await dialog.waitFor();
      if (section) await dialog.locator('.prefs-nav-item', { hasText: t(`prefs.${section}`) }).first().click();
      await page.waitForTimeout(400);
      return dialog;
    },
  };
  return kit;
}

/**
 * A small window of the desktop app (the quick tools, the ring) on a plain
 * desktop, the size of the other pictures, so the guide's pictures line up.
 */
function onDesktop(png, target, kind = 'jpg') {
  const side = { width: CROP.width * SCALE, height: CROP.height * SCALE };
  execFileSync('convert', [
    '-size', `${side.width}x${side.height}`, 'gradient:#eef1f6-#f3eadf',
    '(', png, '-resize', `${side.width - 120}x${side.height - 80}>`, '(', '+clone', '-background', '#0b1f3a', '-shadow', '28x14+0+10', ')', '+swap', '-background', 'none', '-layers', 'merge', '+repage', ')',
    '-gravity', 'center', '-composite',
    '-resize', `${WIDTH}x`, ...(kind === 'jpg' ? ['-strip', '-sampling-factor', '4:2:0', '-quality', '74'] : []), target,
  ]);
}

/**
 * A moving picture: the recipe calls `frame` at each moment worth seeing
 * (the same marks and pointer as a still), and the moments play in turn,
 * each for its `ms`, then start again. The still of the same name is its
 * first moment that has a mark, for the PDFs and for reduced motion.
 */
async function moving(page, s, id, recipe, lang) {
  const win = recipe.window;
  const frames = [];
  await recipe.motion(s, async ({ mark, at, pointer = true, ms = 1400, settle = 400 } = {}) => {
    const marks = Array.isArray(mark) ? mark : mark ? [mark] : [];
    for (const one of marks) await one.waitFor({ state: 'visible' });
    await page.waitForTimeout(settle);
    const rects = [];
    for (const one of marks) rects.push(await one.boundingBox());
    if (rects.length > 0 || at) await page.evaluate(annotate, { rects, pointer, at });
    const png = join(scratch, `${id}-${lang}-${frames.length}.png`);
    await page.screenshot({ path: png, omitBackground: Boolean(win?.transparent) });
    await page.evaluate(() => document.getElementById('zood-shot')?.remove());
    frames.push({ png, rects: at ? [...rects, { ...at, width: 1, height: 1 }] : rects, ms, marked: rects.length > 0 });
  });
  const clip = win ? null : cropAround(frames.flatMap((one) => one.rects), recipe.full);
  const shown = frames.map((one, index) => {
    const png = join(scratch, `${id}-${lang}-${index}-shown.png`);
    if (win) onDesktop(one.png, png, 'png');
    else execFileSync('convert', [one.png, '-crop', `${Math.round(clip.width * SCALE)}x${Math.round(clip.height * SCALE)}+${Math.round(clip.x * SCALE)}+${Math.round(clip.y * SCALE)}`, '+repage', '-resize', `${WIDTH}x`, png]);
    return png;
  });
  const still = frames.findIndex((one) => one.marked);
  execFileSync('convert', [shown[Math.max(0, still)], '-strip', '-sampling-factor', '4:2:0', '-quality', '74', join(out, `${id}-${lang}.jpg`)]);
  const webp = join(out, `${id}-${lang}.webp`);
  execFileSync('convert', [...frames.flatMap((one, index) => ['-delay', String(Math.round(one.ms / 10)), shown[index]]), '-loop', '0', '-quality', '68', '-define', 'webp:method=6', webp]);
  return webp;
}

async function take(browser, base, id, recipe, lang) {
  const win = recipe.window;
  const context = await browser.newContext({ viewport: win ? { width: win.width, height: win.height } : VIEW, deviceScaleFactor: SCALE, reducedMotion: 'reduce', colorScheme: 'light', locale: lang === 'ar' ? 'ar-SA' : 'en-US' });
  await context.addInitScript(
    ([l, extra]) => {
      if (!localStorage.getItem('warraq.preferences')) localStorage.setItem('warraq.preferences', JSON.stringify({ lang: l, theme: 'light', ...extra }));
      localStorage.setItem('warraq.fontsAsked', '1');
      localStorage.setItem('warraq.tour', JSON.stringify({ seen: true, version: 99 }));
    },
    [lang, recipe.prefs ?? {}],
  );
  if (recipe.host) await context.addInitScript({ content: recipe.host(lang) });
  const page = await context.newPage();
  try {
    await page.goto(`${base}/${win?.query ?? ''}`);
    await page.locator(win?.ready ?? '.home').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    const s = kit(page, lang);
    if (recipe.motion) return await moving(page, s, id, recipe, lang);
    const result = (await recipe.run(s)) ?? {};
    const marks = Array.isArray(result.mark) ? result.mark : result.mark ? [result.mark] : [];
    for (const mark of marks) await mark.waitFor({ state: 'visible' });
    if (marks[0]) await marks[0].scrollIntoViewIfNeeded();
    await page.waitForTimeout(result.settle ?? 500);
    const rects = [];
    for (const mark of marks) rects.push(await mark.boundingBox());
    if (rects.length > 0) await page.evaluate(annotate, { rects, pointer: result.pointer !== false });
    const png = join(scratch, `${id}-${lang}.png`);
    const jpg = join(out, `${id}-${lang}.jpg`);
    if (win) {
      await page.screenshot({ path: png, omitBackground: Boolean(win.transparent) });
      onDesktop(png, jpg);
      return jpg;
    }
    const clip = result.full ? cropAround([], true) : cropAround(result.around ? [await result.around.boundingBox(), ...rects] : rects, false);
    await page.screenshot({ path: png, clip });
    execFileSync('convert', [png, '-resize', `${WIDTH}x`, '-strip', '-sampling-factor', '4:2:0', '-quality', '74', jpg]);
    return jpg;
  } finally {
    await context.close();
  }
}

const wanted = process.argv.slice(2);
const ids = Object.keys(SHOTS).filter((id) => wanted.length === 0 || wanted.includes(id));
if (wanted.length === 0) {
  // A full run: pictures no recipe makes any more are dropped.
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const web = await serve(join(root, 'apps/web/dist'));
const desktopDist = join(root, 'apps/web/dist-tauri');
const desktop = ids.some((id) => SHOTS[id].host) ? (existsSync(desktopDist) ? await serve(desktopDist) : null) : null;
let failed = 0;
for (const id of ids) {
  const recipe = SHOTS[id];
  const server = recipe.host ? desktop : web;
  if (!server) {
    console.error(`${id}: needs the desktop build (vite build --mode tauri --outDir dist-tauri)`);
    failed += 1;
    continue;
  }
  for (const lang of ['ar', 'en']) {
    try {
      await take(browser, server.base, id, recipe, lang);
      console.log(`${id}-${lang}`);
    } catch (error) {
      failed += 1;
      console.error(`${id}-${lang}: ${error.message.split('\n')[0]}`);
    }
  }
}
await browser.close();
web.close();
desktop?.close();
if (failed) {
  console.error(`${failed} pictures failed`);
  process.exit(1);
}
