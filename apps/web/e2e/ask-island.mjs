// Ask ZOOD's island and pointer, drawn by the real interface with the desktop host stood in for:
// the keys held, the words heard, the model's decision, Do it, and a point on the screen.
// Run after `vite build --mode tauri`:  CHROMIUM=… node e2e/ask-island.mjs [out-dir]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium, expect } from '@playwright/test';

// Ask ZOOD shows only once the catalogue names a model that hears (its checksums pinned).
const catalogue = JSON.parse(await readFile(new URL('../../../packages/ui/src/ai/device/models.json', import.meta.url), 'utf8'));
if (!catalogue.models.some((model) => model.hears)) {
  console.log('skipped: models.json names no model that hears yet, so the island never shows');
  process.exit(0);
}

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

/** The desktop host, in the page: answers the island's commands and lets the test send its events. */
function host(scenario) {
  const callbacks = new Map();
  const listeners = [];
  let next = 1;
  globalThis.__calls = [];
  globalThis.__emit = (event, payload) => {
    for (const one of listeners) if (one.event === event) callbacks.get(one.handler)?.({ event, payload });
  };
  const wallet = {
    v: 2,
    profiles: [{ id: 'p1', name: 'Me', details: { nameEn: 'Mohammed', nationalId: '1012345678', phone: '0500000000' }, addresses: [], banks: [], custom: [] }],
    memory: [],
    memoryOn: true,
    memoryToCloud: false,
    labels: {},
  };
  globalThis.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'ask' } },
    transformCallback(callback) {
      const id = next++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    async invoke(cmd, args) {
      globalThis.__calls.push({ cmd, args });
      switch (cmd) {
        case 'plugin:event|listen':
          listeners.push({ event: args.event, handler: args.handler });
          return listeners.length;
        case 'plugin:event|unlisten':
          return null;
        case 'ai_memory_bytes':
          return 16 * 1024 ** 3;
        case 'ask_transcribe':
          return scenario.words;
        case 'ask_moment':
          return { files: scenario.files, screen: false };
        case 'profile_get':
          return JSON.stringify(wallet);
        case 'ask_think':
          return { text: JSON.stringify(scenario.decision), cutOff: false, tokens: 40, ms: 900 };
        case 'ask_point_last':
          return scenario.point ?? null;
        default:
          return null;
      }
    },
  };
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const shoot = async (page, name) => out && page.screenshot({ path: join(out, `${name}.png`) });

async function island(scenario) {
  const page = await browser.newPage({ viewport: { width: 460, height: 360 }, locale: scenario.locale ?? 'en-US' });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.addInitScript(host, scenario);
  await page.goto(`${base}/index.html?ask=1`);
  await page.waitForFunction(() => globalThis.__calls.filter((c) => c.cmd === 'plugin:event|listen').length >= 3);
  return page;
}

// 1. Compress the two selected files, in Arabic.
{
  const page = await island({
    locale: 'ar',
    words: 'اضغط هذه الملفات',
    files: ['Contract.pdf', 'Invoice.pdf'],
    decision: { say: 'سأضغط الملفين المحددين.', act: 'tool', tool: 'compress', query: '', fields: [], profile: 'Me' },
  });
  await page.evaluate(() => globalThis.__emit('ask://listen', { screen: false }));
  await page.evaluate(() => globalThis.__emit('ask://level', 0.8));
  await expect(page.locator('.ask-island')).toBeVisible();
  await expect(page.locator('.ask-title')).toHaveText(/أستمع/);
  await shoot(page, '1-listening');
  await page.evaluate(() => globalThis.__emit('ask://heard', { seconds: 1.8, short: false }));
  await expect(page.locator('.ask-do')).toBeVisible();
  await expect(page.locator('.ask-plan')).toContainText('2');
  await expect(page.locator('.ask-say')).toHaveText('سأضغط الملفين المحددين.');
  await shoot(page, '2-confirm-tool');
  const think = await page.evaluate(() => globalThis.__calls.find((c) => c.cmd === 'ask_think').args.request);
  if (!think.grammar.includes('compress') || think.screen !== false || !think.messages[0].content.includes('Contract.pdf')) throw new Error('the model was not asked as it should be');
  await page.locator('.ask-do').click();
  await page.waitForFunction(() => globalThis.__calls.some((c) => c.cmd === 'ask_run_tool' && c.args.tool === 'compress'));
  console.log('ok: tool, asked, confirmed, run');
  await page.close();
}

// 2. Type saved details, in English.
{
  const page = await island({
    words: 'fill my ID and phone',
    files: [],
    decision: { say: 'Typing your ID and phone.', act: 'fill', tool: 'none', query: '', fields: ['nationalId', 'phone', 'email'], profile: 'Me' },
  });
  await page.evaluate(() => globalThis.__emit('ask://listen', { screen: false }));
  await page.evaluate(() => globalThis.__emit('ask://heard', { seconds: 1.2, short: false }));
  await expect(page.locator('.ask-fields li')).toHaveCount(2);
  await expect(page.locator('.ask-fields')).toContainText('1012345678');
  await shoot(page, '3-confirm-fill');
  await page.locator('.ask-do').click();
  const typed = await page.evaluate(() => globalThis.__calls.find((c) => c.cmd === 'ask_type')?.args.parts);
  if (JSON.stringify(typed) !== JSON.stringify(['1012345678', '0500000000'])) throw new Error(`typed ${JSON.stringify(typed)}`);
  console.log('ok: fill, only saved details, in order');
  await page.close();
}

// 3. A tap, not a question.
{
  const page = await island({ words: '', files: [], decision: {} });
  await page.evaluate(() => globalThis.__emit('ask://listen', { screen: false }));
  await page.evaluate(() => globalThis.__emit('ask://heard', { seconds: 0.1, short: true }));
  await expect(page.locator('.ask-title')).toHaveText(/Hold the keys/);
  await shoot(page, '4-tap');
  console.log('ok: a tap says to hold');
  await page.close();
}

// 4. The pointer over the screen.
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(host, { point: { x: 0.72, y: 0.3, label: 'Click Save to keep your changes' } });
  await page.goto(`${base}/index.html?askpoint=1`);
  await expect(page.locator('.ask-point-label')).toHaveText('Click Save to keep your changes');
  const box = await page.locator('.ask-point').boundingBox();
  if (Math.abs(box.x - 0.72 * 1280) > 2 || Math.abs(box.y - 0.3 * 800) > 2) throw new Error(`point at ${box.x},${box.y}`);
  await shoot(page, '5-point');
  console.log('ok: the point is where the model said');
  await page.close();
}

await browser.close();
server.close();
