// Automated QA in Chromium: every size × language × theme × Reduce Motion.
// For each run it scrolls the whole story and checks that
//   - nothing overflows sideways, nothing logs an error (CSP included) and
//     nothing is fetched from another site,
//   - the device dock never moves (its top edge stays within 1 px),
//   - each chapter's stage numbers and actions reach their values,
//   - the wall's phone lines up with the middle column and shows every screen,
//   - the language switch points at the chapter on screen;
// then saves a contact sheet of the story. With --video it also records scroll videos.
//
//   node website/tools/serve.mjs 8080 &
//   node website/tools/qa.mjs <output-dir> [--video]
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { CHAPTERS, WALL } from '../js/story.js';

const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))(
  '@playwright/test',
);
const OUT = process.argv[2] ?? 'qa-out';
const VIDEO = process.argv.includes('--video');
const SITE = process.env.SITE_URL ?? 'http://127.0.0.1:8080';
mkdirSync(OUT, { recursive: true });

const SIZES = [
  ['phone-375', 375, 667, true],
  ['phone-390', 390, 844, true],
  ['phone-430', 430, 932, true],
  ['tablet-820', 820, 1180, true],
  ['laptop-1280', 1280, 800, false],
  ['desktop-1440', 1440, 900, false],
  ['desktop-1920', 1920, 1080, false],
];
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const report = [];

async function run(name, w, h, touch, lang, theme, motion) {
  const context = await browser.newContext({
    viewport: { width: w, height: h },
    colorScheme: theme,
    reducedMotion: motion,
    hasTouch: touch,
    isMobile: touch && w < 600,
  });
  const page = await context.newPage();
  const problems = [];
  page.on(
    'console',
    (m) =>
      ['error', 'warning'].includes(m.type()) &&
      problems.push(`console: ${m.text().slice(0, 160)}`),
  );
  page.on('pageerror', (e) => problems.push(`error: ${e.message}`));
  page.on('response', (r) => r.status() >= 400 && problems.push(`${r.status()} ${r.url()}`));
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (/^https?:$/.test(url.protocol) && url.origin !== new URL(SITE).origin)
      problems.push(`third-party request: ${r.url()}`);
  });
  await page.goto(`${SITE}${lang === 'en' ? '/en/' : '/'}`);
  await page.waitForTimeout(600);

  const story = CHAPTERS.filter((c) => c.kind !== 'inside');
  const dockTops = new Set();
  const shots = [];
  const tmp = `${OUT}/.tmp-${name}-${lang}-${theme}-${motion}`;
  mkdirSync(tmp, { recursive: true });
  for (const [i, c] of story.entries()) {
    const box = await page.evaluate((id) => {
      const el = document.getElementById(id);
      return { top: el.getBoundingClientRect().top + scrollY, height: el.offsetHeight };
    }, c.id);
    // Scroll in steps through the chapter, checking the stage at its middle.
    for (const f of [0.15, 0.45, 0.7]) {
      const y = box.top + box.height * f - h * 0.5;
      await page.evaluate((yy) => scrollTo(0, yy), y);
      await page.waitForTimeout(120);
      dockTops.add(
        Math.round(
          await page.evaluate(() => document.querySelector('.dock').getBoundingClientRect().top),
        ),
      );
      if (f === 0.45 && c.kind !== 'wall') {
        const state = await page.evaluate(() => {
          const s = getComputedStyle(document.querySelector('.stage'));
          const v = (n) => parseFloat(s.getPropertyValue(n));
          return {
            pages: v('--pages'),
            fan: v('--fan'),
            recede: v('--recede'),
            dusk: v('--dusk'),
            hash: document
              .querySelector('.lang-switch a[aria-current="false"]')
              .getAttribute('href'),
          };
        });
        const want = { pages: 1, fan: 0, recede: 0, dusk: 0, ...c.stage };
        for (const k of ['pages', 'fan', 'recede', 'dusk']) {
          if (Math.abs(state[k] - want[k]) > 0.01)
            problems.push(`${c.id}: --${k} is ${state[k]}, expected ${want[k]}`);
        }
        if (!state.hash.endsWith(`#${c.id}`))
          problems.push(`${c.id}: language switch points at ${state.hash}`);
        const shot = `${tmp}/${String(i).padStart(2, '0')}.png`;
        await page.waitForTimeout(motion === 'reduce' ? 250 : 450);
        await page.screenshot({ path: shot });
        shots.push(shot);
      }
    }
    // Each action reaches its end inside its chapter.
    for (const [action, [, end]] of Object.entries(c.act ?? {})) {
      await page.evaluate(
        (yy) => scrollTo(0, yy),
        box.top + box.height * Math.min(0.79, end + 0.02) - h * 0.5,
      );
      await page.waitForTimeout(120);
      const value = await page.evaluate(
        (a) =>
          parseFloat(getComputedStyle(document.querySelector('.stage')).getPropertyValue(`--${a}`)),
        action,
      );
      if (!(value > 0.97)) problems.push(`${c.id}: --${action} reached only ${value}`);
    }
  }

  // The wall (when the story has one): at each stop the phone's screen sits on a middle-column screen.
  if (CHAPTERS.some((c) => c.kind === 'wall')) {
    const wall = await page.evaluate(() => {
      const el = document.querySelector('.wall');
      return { top: el.getBoundingClientRect().top + scrollY, height: el.offsetHeight };
    });
    const shown = new Set();
    for (let f = 0; f <= 1.0001; f += 0.02) {
      await page.evaluate((yy) => scrollTo(0, yy), wall.top + f * (wall.height - h));
      await page.waitForTimeout(40);
      const r = await page.evaluate(() => {
        const dev = document.querySelector('.wall-device').getBoundingClientRect();
        const sTop = dev.top + dev.height * 0.0193;
        const imgs = [...document.querySelectorAll('.wall-col.middle img')].map((i) =>
          i.getBoundingClientRect(),
        );
        let best = 1e9;
        let idx = -1;
        imgs.forEach((b, i) => {
          if (Math.abs(b.top - sTop) < best) {
            best = Math.abs(b.top - sTop);
            idx = i;
          }
        });
        return { idx, dy: best, dw: Math.abs(imgs[0].width - dev.width * 0.92) };
      });
      if (r.dy < 1 && r.dw < 1) shown.add(r.idx);
    }
    if (shown.size !== WALL.middle.length)
      problems.push(`wall: the phone showed ${shown.size} of ${WALL.middle.length} screens`);
  }

  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (overflow > 0) problems.push(`page overflows sideways by ${overflow}px`);
  if (dockTops.size > 1) problems.push(`device dock moved: ${[...dockTops].join(', ')}`);

  const sheet = `${OUT}/${name}-${lang}-${theme}${motion === 'reduce' ? '-reduced' : ''}.webp`;
  execFileSync('python3', [
    '-c',
    `import sys
from PIL import Image
fs=sys.argv[2:]; ims=[Image.open(f).convert('RGB') for f in fs]
W=420; ims=[im.resize((W,int(im.height*W/im.width))) for im in ims]
cols=7 if ims[0].height<ims[0].width else 13
rows=(len(ims)+cols-1)//cols; H=ims[0].height
sheet=Image.new('RGB',(cols*W+(cols-1)*6,rows*H+(rows-1)*6),'white')
for i,im in enumerate(ims): sheet.paste(im,((i%cols)*(W+6),(i//cols)*(H+6)))
sheet.save(sys.argv[1],'WEBP',quality=72)`,
    sheet,
    ...shots,
  ]);
  rmSync(tmp, { recursive: true, force: true });
  await context.close();
  const line = `${problems.length ? 'FAIL' : 'ok  '} ${name} ${lang} ${theme} ${motion}${problems.length ? `\n      ${problems.join('\n      ')}` : ''}`;
  console.log(line);
  report.push(line);
}

for (const [name, w, h, touch] of SIZES) {
  for (const lang of ['ar', 'en']) {
    for (const theme of ['light', 'dark']) {
      for (const motion of ['no-preference', 'reduce'])
        await run(name, w, h, touch, lang, theme, motion);
    }
  }
}
writeFileSync(`${OUT}/report.txt`, report.join('\n') + '\n');

if (VIDEO) {
  // Smooth scroll videos: the whole story, at a steady wheel speed.
  for (const [name, w, h, lang, theme, motion] of [
    ['desktop-1440', 1440, 900, 'ar', 'light', 'no-preference'],
    ['desktop-1440', 1440, 900, 'en', 'dark', 'no-preference'],
    ['phone-390', 390, 844, 'ar', 'light', 'no-preference'],
    ['phone-390', 390, 844, 'en', 'dark', 'no-preference'],
    ['desktop-1440', 1440, 900, 'ar', 'dark', 'reduce'],
  ]) {
    const dir = `${OUT}/.video`;
    const context = await browser.newContext({
      viewport: { width: w, height: h },
      colorScheme: theme,
      reducedMotion: motion,
      recordVideo: { dir, size: { width: w, height: h } },
    });
    const page = await context.newPage();
    await page.goto(`${SITE}${lang === 'en' ? '/en/' : '/'}`);
    await page.waitForTimeout(800);
    const total = await page.evaluate(
      () => document.querySelector('.inside').getBoundingClientRect().top + scrollY,
    );
    for (let y = 0; y < total; y += 14) {
      await page.evaluate((yy) => scrollTo(0, yy), y);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(500);
    const video = page.video();
    await context.close();
    await video.saveAs(
      `${OUT}/scroll-${name}-${lang}-${theme}${motion === 'reduce' ? '-reduced' : ''}.webm`,
    );
  }
  rmSync(`${OUT}/.video`, { recursive: true, force: true });
}
await browser.close();
