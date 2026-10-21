// Ask ZOOD's taps, drawn by the real interface with the desktop host stood in for: a double tap
// in an email window (its picture read by the app's own Tesseract, the reply drafted and pasted),
// a double tap away from a conversation (ideas, one of them asked), and one tap to type a request.
// Run after `vite build --mode tauri`:  CHROMIUM=… node e2e/ask-tap.mjs [out-dir]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const dist = new URL('../dist/', import.meta.url).pathname;
const out = process.argv[2] ?? null;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.gz': 'application/gzip' };
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
  let thought = 0;
  globalThis.__calls = [];
  globalThis.__emit = (event, payload) => {
    for (const one of listeners) if (one.event === event) callbacks.get(one.handler)?.({ event, payload });
  };
  /** The window the person tapped in, drawn as a picture: what the host's xcap would take. */
  async function windowPicture() {
    const canvas = new OffscreenCanvas(1100, 420);
    const g = canvas.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 1100, 420);
    g.fillStyle = '#111111';
    g.font = '30px Arial, sans-serif';
    g.direction = 'ltr';
    scenario.window.lines.forEach((line, k) => g.fillText(line, 40, 70 + k * 56));
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return await blob.arrayBuffer();
  }
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
        case 'ask_moment':
          return { files: [], screen: false, app: scenario.window.app, title: scenario.window.title, readable: true };
        case 'ask_window_png':
          return await windowPicture();
        case 'profile_get':
          return JSON.stringify({ v: 2, profiles: [], memory: [], memoryOn: true, memoryToCloud: false, labels: {} });
        case 'ask_think':
          return { text: JSON.stringify(scenario.answers[Math.min(thought++, scenario.answers.length - 1)]), cutOff: false, tokens: 120, ms: 4200 };
        default:
          return null;
      }
    },
  };
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const shoot = async (page, name) => out && page.screenshot({ path: join(out, `${name}.png`) });
const calls = (page, cmd) => page.evaluate((name) => globalThis.__calls.filter((c) => c.cmd === name).map((c) => c.args), cmd);

async function island(scenario) {
  const page = await browser.newPage({ viewport: { width: 460, height: 420 }, locale: scenario.locale ?? 'en-US' });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.addInitScript(host, scenario);
  // The person's way of writing, as Settings keeps it.
  await page.addInitScript(() => localStorage.setItem('warraq.ask.style', JSON.stringify({ about: 'Mohammed, Operations Manager at ZOOD.', examples: 'Hi Ali,\nDone, thanks.\nBest regards,\nMohammed' })));
  await page.goto(`${base}/index.html?ask=1`);
  await page.waitForFunction(() => globalThis.__calls.filter((c) => c.cmd === 'plugin:event|listen').length >= 4);
  return page;
}

// 1. Double tap in an email: the window is read, a reply is drafted in the person's way and pasted.
{
  const reply = 'Hi Sara,\nThe invoice will be paid on [date]. I will confirm once it is done.\nBest regards,\nMohammed';
  const page = await island({
    window: { app: 'Outlook', title: 'RE: Invoice 20431', lines: ['From: Sara Ahmed', 'Hi Mohammed,', 'Could you confirm when invoice 20431 will be paid?', 'Thanks, Sara'] },
    answers: [{ kind: 'reply', say: 'Replied that you will confirm the payment date.', text: reply, ideas: [] }],
  });
  await page.evaluate(() => globalThis.__emit('ask://tap', { kind: 'draft', screen: true, app: 'Outlook', title: 'RE: Invoice 20431' }));
  await expect(page.locator('.ask-island')).toBeVisible();
  await shoot(page, '1-reading');
  await expect(page.locator('.ask-title')).toHaveText(/Your draft is in Outlook/, { timeout: 60_000 });
  await shoot(page, '2-placed');
  const [think] = await calls(page, 'ask_think');
  const [system, user] = think.request.messages;
  if (!/confirm when invoice 20431/i.test(user.content)) throw new Error(`the window was not read: ${user.content}`);
  if (!system.content.includes('Operations Manager at ZOOD') || !system.content.includes('Best regards')) throw new Error('the writing style was not given');
  if (think.request.screen !== false || !think.request.grammar.includes('suggest')) throw new Error('not asked as a draft');
  const [pasted] = await calls(page, 'ask_paste');
  if (pasted?.text !== reply) throw new Error(`pasted ${JSON.stringify(pasted)}`);
  // Write it again: the first draft is undone, then a new one is pasted.
  await page.locator('.ask-cancel', { hasText: 'Write it again' }).click();
  await page.waitForFunction(() => globalThis.__calls.filter((c) => c.cmd === 'ask_paste').length === 2);
  const order = await page.evaluate(() => globalThis.__calls.map((c) => c.cmd).filter((cmd) => cmd === 'ask_undo' || cmd === 'ask_paste'));
  if (JSON.stringify(order) !== JSON.stringify(['ask_paste', 'ask_undo', 'ask_paste'])) throw new Error(`order ${order}`);
  console.log('ok: double tap read the window, drafted in the person’s way, pasted, and wrote it again');
  await page.close();
}

// 2. Double tap on a document, in Arabic: ideas, and one asked with a click.
{
  const page = await island({
    locale: 'ar',
    window: { app: 'Chrome', title: 'Lease agreement', lines: ['Lease agreement', 'The tenant pays the rent every month.'] },
    answers: [
      { kind: 'suggest', say: 'هذه صفحة عقد إيجار. يمكنني مساعدتك فيها.', text: '', ideas: ['لخّص هذه الصفحة', 'ترجمها إلى العربية'] },
      { say: 'ملخص العقد.', act: 'answer', tool: 'none', query: '', fields: [], profile: 'none', text: 'يدفع المستأجر الإيجار شهريًا.' },
    ],
  });
  await page.evaluate(() => globalThis.__emit('ask://tap', { kind: 'draft', screen: true, app: 'Chrome', title: 'Lease agreement' }));
  await expect(page.locator('.ask-idea-list button')).toHaveCount(2, { timeout: 60_000 });
  await shoot(page, '3-ideas-ar');
  await page.locator('.ask-idea-list button').first().click();
  await expect(page.locator('.ask-text')).toHaveText('يدفع المستأجر الإيجار شهريًا.');
  await shoot(page, '4-summary-ar');
  const asks = await calls(page, 'ask_think');
  if (asks[1].request.messages[1].content !== 'لخّص هذه الصفحة') throw new Error('the idea was not asked');
  if (!asks[1].request.messages[0].content.includes('The tenant pays the rent')) throw new Error('the window was not kept for the follow-up');
  if ((await calls(page, 'ask_window_png')).length !== 1) throw new Error('the window was read twice');
  console.log('ok: away from a conversation, ideas; one asked, with the same window');
  await page.close();
}

// 3. One tap: a typed request, written where the cursor is.
{
  const page = await island({
    window: { app: 'WhatsApp', title: 'Ali', lines: ['Ali: Are you free this week?'] },
    answers: [{ say: 'Told Ali you are free on Thursday.', act: 'write', tool: 'none', query: '', fields: [], profile: 'none', text: 'Yes, I am free on Thursday.' }],
  });
  await page.evaluate(() => globalThis.__emit('ask://tap', { kind: 'type', screen: true, app: 'WhatsApp', title: 'Ali' }));
  await expect(page.locator('.ask-type textarea')).toBeFocused();
  await page.locator('.ask-type textarea').fill('reply that I am free on Thursday');
  await shoot(page, '5-typing');
  await page.keyboard.press('Enter');
  await expect(page.locator('.ask-title')).toHaveText(/Your draft is in WhatsApp/, { timeout: 60_000 });
  await shoot(page, '6-written');
  const [pasted] = await calls(page, 'ask_paste');
  if (pasted?.text !== 'Yes, I am free on Thursday.') throw new Error(`pasted ${JSON.stringify(pasted)}`);
  const [think] = await calls(page, 'ask_think');
  if (!think.request.grammar.includes('write') || think.request.messages[1].content !== 'reply that I am free on Thursday') throw new Error('not asked as typed');
  console.log('ok: one tap, typed, written where the cursor is');
  await page.close();
}

await browser.close();
server.close();
