// QA for the iPhone Duo page (iphone-duo/): every size × language × theme
// × Reduce Motion. It scrolls the page top to bottom and checks that nothing
// overflows sideways, nothing logs an error or warning, nothing is fetched
// from another site or fails, every screen picture loads, the hero device
// ends open and the carousel's arrows move it.
//   node website/tools/serve.mjs 8080 &
//   node website/tools/qa-foldable.mjs
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))(
  '@playwright/test',
);
const SITE = process.env.SITE_URL ?? 'http://127.0.0.1:8080';
const SIZES = [
  [375, 667, true],
  [390, 844, true],
  [820, 1180, true],
  [1280, 800, false],
  [1920, 1080, false],
];
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
let failed = 0;
for (const [w, h, touch] of SIZES)
  for (const lang of ['ar', 'en'])
    for (const theme of ['light', 'dark'])
      for (const motion of ['no-preference', 'reduce']) {
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
          (m) => ['error', 'warning'].includes(m.type()) && problems.push(`console: ${m.text()}`),
        );
        page.on('pageerror', (e) => problems.push(`error: ${e.message}`));
        page.on('response', (r) => r.status() >= 400 && problems.push(`${r.status()} ${r.url()}`));
        page.on('request', (r) => {
          const url = new URL(r.url());
          if (/^https?:$/.test(url.protocol) && url.origin !== new URL(SITE).origin)
            problems.push(`external request: ${r.url()}`);
        });
        await page.goto(`${SITE}/${lang === 'en' ? 'en/' : ''}iphone-duo/`);
        await page.waitForTimeout(800);
        const total = await page.evaluate(() => document.documentElement.scrollHeight);
        for (let y = 0; y < total; y += Math.round(h * 0.6)) {
          await page.evaluate((y) => scrollTo(0, y), y);
          await page.waitForTimeout(60);
          const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
          if (wide > 1) problems.push(`overflows sideways by ${wide}px at ${y}`);
        }
        const hero = await page.evaluate(() => {
          const s = document.querySelector('.fd-hero');
          scrollTo(0, s.offsetTop + s.offsetHeight);
          return new Promise((ok) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() =>
                ok(getComputedStyle(s.querySelector('.fd-device')).getPropertyValue('--fold')),
              ),
            ),
          );
        });
        if (Number(hero) > 0.01) problems.push(`hero device not open (--fold ${hero})`);
        const broken = await page.evaluate(async () => {
          const imgs = [...document.querySelectorAll('img.fd-shot')];
          imgs.forEach((i) => (i.loading = 'eager'));
          await Promise.race([
            Promise.all(imgs.map((i) => i.decode().catch(() => 0))),
            new Promise((ok) => setTimeout(ok, 5000)),
          ]);
          return imgs.filter((i) => !i.naturalWidth).map((i) => i.src);
        });
        broken.forEach((src) => problems.push(`picture missing: ${src}`));
        const moved = await page.evaluate(async () => {
          const list = document.querySelector('.fd-cards');
          list.scrollIntoView();
          const before = list.scrollLeft;
          document.querySelector('.fd-step[data-step="1"]').click();
          await new Promise((ok) => setTimeout(ok, 900));
          return Math.abs(list.scrollLeft - before);
        });
        if (moved < 50) problems.push('carousel arrow did not move it');
        const name = `${w}x${h} ${lang} ${theme} ${motion}`;
        if (problems.length) {
          failed++;
          console.log(`FAIL ${name}\n  ${problems.slice(0, 8).join('\n  ')}`);
        } else console.log(`ok   ${name}`);
        await context.close();
      }
await browser.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exitCode = failed ? 1 : 0;
