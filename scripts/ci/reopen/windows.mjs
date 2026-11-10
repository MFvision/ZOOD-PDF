// Reopen where you left off, in the real Windows app (CI): the installed
// ZOOD PDF, driven through its WebView2 over the DevTools protocol.
//   1. Three PDFs are opened as a person opens them (the first starts the
//      app, the next two come from Explorer to the running app), each moved
//      to its own page, two put in a named group, the middle one in front.
//   2. The window is closed with its close button's message (WM_CLOSE), and
//      the app must end.
//   3. ZOOD is started again with nothing: the same tabs, order, group,
//      front tab and page must come back, and each tab asleep until shown
//      must open on its own page.
//   4. A page turned just before quitting; then a file deleted while ZOOD
//      was closed: its tab must go, with a word about it.
// Everything is written to <out>/reopen.txt, with screenshots and each
// session.json. Exits 1 when something that must hold does not.
//   node windows.mjs --app <warraq-desktop.exe> --pdfs <folder> --out <folder> --playwright <playwright-core folder>
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const APP = arg('app');
const PDFS = arg('pdfs');
const OUT = arg('out');
const { chromium } = createRequire(import.meta.url)(arg('playwright'));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STRINGS = {
  en: JSON.parse(readFileSync(join(ROOT, 'packages/ui/src/i18n/en.json'), 'utf8')),
  ar: JSON.parse(readFileSync(join(ROOT, 'packages/ui/src/i18n/ar.json'), 'utf8')),
};
const PORT = 9222;
const SESSION = join(process.env.APPDATA ?? '', 'app.warraq.desktop', 'session.json');
const FILE = { A: join(PDFS, 'A-restore.pdf'), B: join(PDFS, 'B-restore.pdf'), C: join(PDFS, 'C-restore.pdf') };
const NAME = { A: 'A-restore.pdf', B: 'B-restore.pdf', C: 'C-restore.pdf' };
const GROUP = 'Restore test';
mkdirSync(OUT, { recursive: true });

const lines = [];
const failed = [];
const say = (text) => {
  console.log(text);
  lines.push(text);
};
const check = (label, ok, detail = '', must = true) => {
  say(`${ok ? 'PASS' : must ? 'FAIL' : 'NOTE'}  ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok && must) failed.push(label);
  return ok;
};
const save = () => writeFileSync(join(OUT, 'reopen.txt'), `${lines.join('\n')}\n`);

let lang = 'en';
const t = (key, vars = {}) => String(STRINGS[lang][key] ?? STRINGS.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? `{${name}}`);
const digits = (text) => String(text ?? '').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));

async function until(what, test, ms = 20_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await test();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

function running() {
  try {
    return execFileSync('tasklist', ['/FI', 'IMAGENAME eq warraq-desktop.exe', '/NH'], { encoding: 'utf8' }).includes('warraq-desktop.exe');
  } catch {
    return false;
  }
}

function launch(files = []) {
  const child = spawn(APP, files, {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

/** The main window's page over the DevTools protocol. */
async function connect() {
  await until('the DevTools port', async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok, 90_000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = await until(
    'the main window',
    async () => {
      for (const context of browser.contexts()) {
        for (const one of context.pages()) {
          const label = await one.evaluate(() => globalThis.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null).catch(() => null);
          if (label === 'main') return one;
        }
      }
      return null;
    },
    60_000,
  );
  await page.waitForLoadState('domcontentloaded');
  lang = (await page.evaluate(() => document.documentElement.lang || 'en')).startsWith('ar') ? 'ar' : 'en';
  return { browser, page };
}

/** Closes what opened by itself (the first run's tour, What's new), saying what it was. */
async function dismiss(page) {
  for (let n = 0; n < 4; n++) {
    const open = page.locator('dialog[open]');
    if ((await open.count()) === 0) return;
    const title = (await open.first().locator('.dialog-header').innerText().catch(() => '')).trim().split('\n')[0];
    say(`      (closed a window that opened by itself: "${title}")`);
    await page.keyboard.press('Escape');
    await sleep(700);
  }
}

async function tabs(page) {
  return page.$$eval('.tab[data-tab-key]', (all) =>
    all.map((el) => ({
      title: el.querySelector('.tab-title')?.textContent?.trim() ?? '',
      front: el.querySelector('[role="tab"]')?.getAttribute('aria-selected') === 'true',
      grouped: el.classList.contains('in-group'),
      asleep: el.classList.contains('is-asleep'),
    })),
  );
}

/** The page box: the page the app says it is on, and of how many. */
async function where(page) {
  const box = await page.evaluate(() => {
    const input = [...document.querySelectorAll('.page-input')].find((el) => el.offsetParent !== null);
    return input ? { value: input.value, total: input.parentElement?.querySelector('.page-total')?.textContent ?? '' } : null;
  });
  if (!box) return { page: null, total: null };
  return { page: Number(digits(box.value)), total: Number((digits(box.total).match(/\d+/) ?? [])[0] ?? NaN) };
}

const tab = (page, letter) => page.locator('.tab[data-tab-key]').filter({ hasText: NAME[letter] });

async function front(page, letter, pages) {
  await until(`${NAME[letter]} in front with ${pages} pages`, async () => {
    const list = await tabs(page);
    const live = list.find((one) => one.front);
    return live?.title === NAME[letter] && (await where(page)).total === pages;
  }, 45_000);
}

async function show(page, letter, pages) {
  await dismiss(page);
  await tab(page, letter).locator('[role="tab"]').click();
  await front(page, letter, pages);
}

/** Types the page in the page box, then waits until the app itself says that page (it writes it to session.json). */
async function turn(page, letter, number) {
  await dismiss(page);
  const box = page.locator('.page-input:visible').first();
  await box.fill(String(number));
  await box.press('Enter');
  await until(`${NAME[letter]} kept on page ${number}`, async () => session()?.tabs.some((one) => base(one.path) === NAME[letter] && one.page === number), 15_000).catch((error) =>
    say(`      ${error.message}; session.json says: ${brief(session())}`),
  );
}

function session() {
  try {
    return JSON.parse(readFileSync(SESSION, 'utf8'));
  } catch {
    return null;
  }
}

const base = (path) => String(path).split(/[\\/]/).pop();
const brief = (kept) =>
  kept
    ? kept.tabs.map((one, at) => `${base(one.path)} p${one.page}${one.group != null ? ` g${one.group}` : ''}${at === kept.active ? ' *front*' : ''}`).join(', ') +
      ` | groups: ${kept.groups.map((g) => `${g.id}:${g.name}/${g.colour}`).join(', ') || 'none'}`
    : 'no session.json';

/** Waits until the app has written what the screen shows, then keeps a copy. */
async function kept(expect, name) {
  const got = await until(`session.json: ${expect.map(([l, p]) => `${l} p${p}`).join(', ')}`, async () => {
    const now = session();
    if (!now) return null;
    const ok = expect.every(([letter, page]) => now.tabs.some((one) => base(one.path) === NAME[letter] && one.page === page));
    return ok ? now : null;
  }, 15_000).catch((error) => {
    say(`      ${error.message}; it says: ${brief(session())}`);
    return session();
  });
  if (existsSync(SESSION)) copyFileSync(SESSION, join(OUT, name));
  return got;
}

const CLOSER = join(dirname(fileURLToPath(import.meta.url)), 'close-window.ps1');

/** The closer made ready ahead (PowerShell and its types take seconds to start); `fire` closes at once. */
function closer() {
  const flag = join(OUT, `close-now-${Date.now()}.flag`);
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CLOSER, '-WaitFor', flag], { stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.on('data', (chunk) => (text += chunk));
  child.stderr.on('data', (chunk) => (text += chunk));
  const done = new Promise((resolve) => child.on('exit', () => resolve(text.trim())));
  return { fire: () => writeFileSync(flag, 'now'), done };
}

/** The close button's message to the largest window of ZOOD's, then the app must end. */
async function quit(label, ready = null) {
  const close = ready ?? closer();
  if (!ready) close.fire();
  const said = await close.done;
  for (const line of said.split(/\r?\n/)) say(`      ${line}`);
  const ended = await until('the app to end', async () => !running(), 20_000).then(() => true, () => false);
  check(`${label}: closing the window ends ZOOD`, ended);
  if (!ended) {
    execFileSync('taskkill', ['/F', '/IM', 'warraq-desktop.exe']);
    await sleep(2000);
  }
  await sleep(1500);
}

async function shot(page, name) {
  await page.screenshot({ path: join(OUT, name) }).catch((error) => say(`      (no screenshot ${name}: ${error.message})`));
}

async function main() {
  say(`ZOOD reopen check on Windows ${new Date().toISOString()}`);
  say(`app: ${APP}`);
  if (running()) {
    say('ZOOD was already running: ended first');
    execFileSync('taskkill', ['/F', '/IM', 'warraq-desktop.exe']);
    await sleep(2000);
  }
  rmSync(SESSION, { force: true });

  // 1. Three files, as a person opens them.
  say('-- 1. open three files, each on its own page, two in a group');
  launch([FILE.A]);
  let { page } = await connect();
  say(`      interface language: ${lang}`);
  await sleep(1500);
  await dismiss(page);
  await front(page, 'A', 8);
  launch([FILE.B]);
  await front(page, 'B', 6);
  launch([FILE.C]);
  await front(page, 'C', 5);
  await dismiss(page);
  check('three files opened as three tabs', (await tabs(page)).length === 3, (await tabs(page)).map((one) => one.title).join(', '));

  await turn(page, 'C', 2);
  await show(page, 'A', 8);
  await turn(page, 'A', 6);

  await tab(page, 'A').click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: t('tabs.newGroup') }).click();
  const name = page.getByRole('textbox', { name: t('tabs.group.name') });
  await name.fill(GROUP);
  await page.getByRole('radio', { name: t('tabs.colour.green') }).click();
  await name.press('Enter');
  await tab(page, 'C').click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: t('tabs.addTo', { name: GROUP }) }).click();

  await show(page, 'B', 6);
  await turn(page, 'B', 4);

  const before = await kept([['A', 6], ['B', 4], ['C', 2]], 'session-1-before-quit.json');
  say(`      session.json: ${brief(before)}`);
  const order = (await tabs(page)).map((one) => one.title);
  say(`      tabs on screen: ${order.join(', ')}; in front: ${(await tabs(page)).find((one) => one.front)?.title}`);
  check('the app kept each tab\'s page (A 6, B 4, C 2) and the group', !!before && before.groups.some((g) => g.name === GROUP) && before.tabs.filter((one) => one.group != null).length === 2);
  await shot(page, '1-before-quit.png');

  // 2. Quit.
  say('-- 2. close the window');
  await quit('first quit');

  // 3. Start again with nothing.
  say('-- 3. start ZOOD again');
  launch([]);
  ({ page } = await connect());
  await sleep(1500);
  await dismiss(page);
  const back = await until('the tabs to come back', async () => ((await tabs(page)).length >= 3 ? tabs(page) : null), 45_000).catch(() => tabs(page));
  check('the same tabs come back, in the same order', JSON.stringify(back.map((one) => one.title)) === JSON.stringify(order), back.map((one) => one.title).join(', '));
  check('the same tab is in front (B)', back.find((one) => one.front)?.title === NAME.B, back.find((one) => one.front)?.title ?? 'none');
  const chip = await page.locator('[data-group-chip]').allInnerTexts();
  check(`the group "${GROUP}" is back with its two tabs`, chip.some((text) => text.includes(GROUP)) && back.filter((one) => one.grouped).length === 2, `chips: ${chip.join(' | ') || 'none'}; grouped tabs: ${back.filter((one) => one.grouped).map((one) => one.title).join(', ')}`);
  check('the tabs not in front wait asleep until shown', back.filter((one) => !one.front).every((one) => one.asleep), back.map((one) => `${one.title}${one.asleep ? ' asleep' : ''}`).join(', '), false);
  const frontPage = await until('B on page 4', async () => ((await where(page)).page === 4 ? where(page) : null), 30_000).catch(() => where(page));
  check('B opens on page 4 of 6', frontPage.page === 4 && frontPage.total === 6, `page box says ${frontPage.page} of ${frontPage.total}`);
  await sleep(1200);
  await shot(page, '2-after-start-B.png');
  await show(page, 'A', 8);
  const aPage = await until('A on page 6', async () => ((await where(page)).page === 6 ? where(page) : null), 30_000).catch(() => where(page));
  check('A, asleep until now, opens on page 6 of 8', aPage.page === 6, `page box says ${aPage.page} of ${aPage.total}`);
  await sleep(1200);
  await shot(page, '3-after-start-A.png');
  await show(page, 'C', 5);
  const cPage = await until('C on page 2', async () => ((await where(page)).page === 2 ? where(page) : null), 30_000).catch(() => where(page));
  check('C, asleep until now, opens on page 2 of 5', cPage.page === 2, `page box says ${cPage.page} of ${cPage.total}`);
  const again = await kept([['A', 6], ['B', 4], ['C', 2]], 'session-2-after-start.json');
  check('after the start the app still keeps A 6, B 4, C 2', !!again && [['A', 6], ['B', 4], ['C', 2]].every(([l, p]) => again.tabs.some((one) => base(one.path) === NAME[l] && one.page === p)), brief(again));

  // 4. A page turned just before quitting.
  say('-- 4. turn C to page 5 and close the window at once');
  const ready = closer();
  await sleep(6000);
  const box = page.locator('.page-input:visible').first();
  await box.fill('5');
  await box.press('Enter');
  await sleep(150);
  ready.fire();
  await quit('quick quit', ready);
  launch([]);
  ({ page } = await connect());
  await sleep(1500);
  await dismiss(page);
  await until('the tabs to come back', async () => (await tabs(page)).length >= 3, 45_000).catch(() => {});
  const quick = await until('C on page 5', async () => ((await where(page)).page === 5 ? where(page) : null), 20_000).catch(() => where(page));
  check('a page turned just before quitting is kept (C on 5)', quick.page === 5, `C came back on page ${quick.page}`, false);
  await sleep(2500);
  await quit('third quit');

  // 5. A file deleted while ZOOD was closed.
  say('-- 5. delete C while ZOOD is closed, start again');
  rmSync(FILE.C, { force: true });
  launch([]);
  ({ page } = await connect());
  await sleep(1500);
  await dismiss(page);
  const left = await until('two tabs', async () => ((await tabs(page)).length === 2 ? tabs(page) : null), 45_000).catch(() => tabs(page));
  check('the deleted file\'s tab is gone, the other two are back', left.length === 2 && !left.some((one) => one.title === NAME.C), left.map((one) => one.title).join(', '));
  const note = await page.evaluate((name) => document.body.innerText.includes(name), NAME.C).catch(() => false);
  check('ZOOD says the deleted file is no longer there', note, '', false);
  await shot(page, '4-file-gone.png');
  if (existsSync(SESSION)) copyFileSync(SESSION, join(OUT, 'session-3-file-gone.json'));
  await quit('last quit');
}

try {
  await main();
} catch (error) {
  check('the check ran to the end', false, error.message.split('\n')[0]);
}
say(failed.length ? `RESULT: FAILED (${failed.join('; ')})` : 'RESULT: PASSED');
save();
process.exit(failed.length ? 1 : 0);
