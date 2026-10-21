// Files moving between the phone and the PC, as the PC's screen shows them, drawn by the real
// interface with the desktop host stood in for: one from the phone rises, is shown large, then
// settles at the Desktop's corner; one sent to the phone lifts where it was and flies off the
// bottom of the screen. Run after `vite build --mode tauri`:  CHROMIUM=… node e2e/arrival.mjs [out-dir]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const dist = new URL('../dist/', import.meta.url).pathname;
const out = process.argv[2] ?? null;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  try {
    const body = await readFile(join(dist, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

const picture = `data:image/svg+xml;base64,${Buffer.from(
  "<svg xmlns='http://www.w3.org/2000/svg' width='300' height='400'><defs><linearGradient id='g' x2='0' y2='1'><stop offset='0' stop-color='#d6b287'/><stop offset='1' stop-color='#041e42'/></linearGradient></defs><rect width='300' height='400' fill='url(#g)'/><circle cx='150' cy='170' r='70' fill='#f6f1ea'/></svg>",
).toString('base64')}`;

/** The desktop host, in the page: the arrival window's one question, what came last. */
function host(payload) {
  globalThis.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'arrival' } },
    transformCallback: () => 1,
    unregisterCallback() {},
    async invoke(cmd) {
      return cmd === 'arrival_last' ? payload : null;
    },
  };
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const shoot = async (page, name) => out && page.screenshot({ path: join(out, `${name}.png`) });
const errors = [];

async function show(payload, moments) {
  // VIDEO: also film it at its own speed, for a person to watch.
  const video = process.env.VIDEO && out ? { recordVideo: { dir: out, size: { width: 1280, height: 800 } } } : {};
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...video });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  // A desktop to see the window over.
  await page.addInitScript(host, payload);
  await page.goto(`${base}/index.html?arrival=1`);
  await page.addStyleTag({ content: 'html.arrival-page body { background: linear-gradient(160deg, #1c4a5a, #0b1d2a) !important; }' });
  await expect(page.locator('.arrival-file')).toBeVisible();
  await expect(page.locator('.arrival-name')).toHaveText(payload.name);
  if (process.env.VIDEO) {
    await page.waitForTimeout(4200);
  } else {
    // Each moment, held still: every animation set to that time since the file came.
    for (const [ms, name] of moments) {
      await page.evaluate((time) => {
        for (const animation of globalThis.document.getAnimations()) {
          animation.pause();
          animation.currentTime = time;
        }
      }, ms);
      await shoot(page, name);
    }
  }
  await context.close();
}

try {
  await show({ way: 'in', name: 'Photo from the phone.png', kind: 'picture', picture, from: null }, [
    [250, 'in-edge'],
    [600, 'in-rising'],
    [900, 'in-sharpening'],
    [1600, 'in-large'],
    [3200, 'in-corner'],
  ]);
  console.log('arrival: from the phone, risen, large, then at the corner');
  await show({ way: 'out', name: 'Contract.pdf', kind: 'pdf', picture: null, from: { x: 300, y: 260 } }, [
    [250, 'out-lifted'],
    [700, 'out-drawn'],
    [1000, 'out-passing'],
    [1300, 'out-wave'],
  ]);
  console.log('arrival: to the phone, lifted where it was, then off the bottom');
  if (errors.length) throw new Error(`errors on the page:\n${errors.join('\n')}`);
  console.log('arrival: all steps held');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
