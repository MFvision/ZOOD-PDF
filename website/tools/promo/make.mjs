// Makes the film: node website/tools/promo/make.mjs [ar|en ...] [--at=t1,t2 ...]
// Pulls frames out of the app's recordings, serves the site and them,
// captures promo.js frame by frame in Chromium, writes the music (music.mjs)
// and encodes assets/film/film-<lang>.mp4, .webm (and -720 copies for phones)
// and a .webp poster.
// With --at it only writes stills of those moments, to check a scene.
// Needs ffmpeg and the repo's Playwright (as tools/capture-screens.mjs does).
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeMusic } from './music.mjs';

const SITE = fileURLToPath(new URL('../../', import.meta.url));
const TMP = join(tmpdir(), 'zood-film');
const OUT = join(SITE, 'assets/film');
const args = process.argv.slice(2);
const at = args
  .find((a) => a.startsWith('--at='))
  ?.slice(5)
  .split(',')
  .map(Number);
const langs = args.filter((a) => a === 'ar' || a === 'en');
if (!langs.length) langs.push('ar', 'en');
const CLIPS = {
  read: 'phone/02-read-light',
  comment: 'tablet/05-comment-light',
  ai: 'desktop/11-ai-light',
  sign: 'desktop/08-sign-light',
};
const LENGTH = 30;
const FPS = 30;
const POSTER = 26.9;
// The ring plays from 2.6 s to 6.3 s of the film (promo.js).
const RING_FRAMES = 111;

const ffmpeg = (...a) =>
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...a], { stdio: 'inherit' });

// 1. The recordings, as numbered frames.
const counts = {};
for (const lang of langs) {
  counts[lang] = {};
  for (const [key, clip] of Object.entries(CLIPS)) {
    const dir = join(TMP, 'frames', lang, clip);
    let n = 0;
    try {
      n = readdirSync(dir).length;
    } catch {}
    if (!n) {
      mkdirSync(dir, { recursive: true });
      ffmpeg('-i', join(SITE, 'assets', lang, `${clip}.mp4`), '-q:v', '3', join(dir, '%04d.jpg'));
      n = readdirSync(dir).length;
    }
    counts[lang][key] = n;
  }
}

// 2. The site and the frames, over HTTP.
const TYPES = {
  '.png': 'image/png',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(
    /^(\.\.[/\\])+/,
    '',
  );
  const file = path.startsWith('/_frames/')
    ? join(TMP, 'frames', path.slice(9))
    : join(SITE, path.endsWith('/') ? `${path}index.html` : path);
  try {
    if (!statSync(file).isFile()) throw new Error();
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

// 3. Frame by frame.
const require = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);
mkdirSync(OUT, { recursive: true });
if (!at) writeMusic(join(TMP, 'music.wav'));
for (const lang of langs) {
  // The ring, as the site's own ring section plays it, one frame per film frame.
  const ringDir = join(TMP, 'frames', lang, 'ring');
  if (!existsSync(ringDir)) {
    mkdirSync(ringDir, { recursive: true });
    const site = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await site.goto(`${base}/${lang === 'en' ? 'en/' : ''}`);
    await site.waitForTimeout(1500);
    // Only the ring's drawing, over nothing, so the film's own colour shows behind it.
    await site.evaluate(() => {
      for (const el of document.body.children)
        if (el.tagName !== 'MAIN') el.style.visibility = 'hidden';
      for (const el of document.querySelectorAll('main > *'))
        if (el.id !== 'ring') el.style.visibility = 'hidden';
      for (const el of [
        document.documentElement,
        document.body,
        document.getElementById('ring'),
        document.querySelector('#ring .ring-stage'),
      ])
        el.style.background = 'transparent';
      document.querySelector('#ring .ring-words').style.visibility = 'hidden';
    });
    for (let k = 0; k < RING_FRAMES; k++) {
      await site.evaluate(
        (p) => {
          const r = document.getElementById('ring');
          scrollTo(0, r.offsetTop + p * (r.offsetHeight - innerHeight));
          return new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
        },
        k / (RING_FRAMES - 1),
      );
      await site.waitForTimeout(60);
      await site.locator('#ring .rs').screenshot({
        path: join(ringDir, `${String(k + 1).padStart(4, '0')}.png`),
        omitBackground: true,
      });
    }
    await site.close();
  }
  counts[lang].ring = readdirSync(ringDir).length;
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', (e) => console.error(e.message));
  await page.goto(`${base}/tools/promo/?lang=${lang}`);
  await page.waitForFunction(() => window.ready);
  await page.evaluate((c) => window.setCounts(c), counts[lang]);
  const shots = join(TMP, 'shots', lang);
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const times = at ?? Array.from({ length: LENGTH * FPS }, (_, k) => k / FPS);
  for (const [k, t] of times.entries()) {
    await page.evaluate((t) => window.render(t), t);
    await page.screenshot({
      path: at
        ? join(TMP, `still-${lang}-${t}.png`)
        : join(shots, `${String(k).padStart(5, '0')}.jpg`),
      type: at ? 'png' : 'jpeg',
      quality: at ? undefined : 92,
    });
    if (k % 150 === 0) console.log(lang, t.toFixed(1));
  }
  if (!at) {
    const frames = join(shots, '%05d.jpg');
    const music = join(TMP, 'music.wav');
    // Full HD, and a 720p copy for phones (film.js picks it on narrow screens).
    for (const [suffix, size] of [
      ['', []],
      ['-720', ['-vf', 'scale=1280:-2']],
    ]) {
      ffmpeg(
        ...['-framerate', String(FPS), '-i', frames, '-i', music, ...size],
        ...['-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p'],
        ...['-c:a', 'aac', '-b:a', suffix ? '128k' : '160k', '-movflags', '+faststart'],
        ...['-shortest', join(OUT, `film-${lang}${suffix}.mp4`)],
      );
      ffmpeg(
        ...['-framerate', String(FPS), '-i', frames, '-i', music, ...size],
        ...['-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-row-mt', '1'],
        ...['-deadline', 'good', '-cpu-used', '2'],
        ...['-c:a', 'libopus', '-b:a', suffix ? '96k' : '128k'],
        ...['-shortest', join(OUT, `film-${lang}${suffix}.webm`)],
      );
    }
    ffmpeg(
      '-i',
      join(shots, `${String(Math.round(POSTER * FPS)).padStart(5, '0')}.jpg`),
      '-vf',
      'scale=1280:-2',
      '-quality',
      '82',
      join(OUT, `film-${lang}.webp`),
    );
  }
  await page.close();
}
await browser.close();
server.close();
console.log(at ? `stills in ${TMP}` : `film in ${OUT}`);
