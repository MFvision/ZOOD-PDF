// Reopen where you left off, in the real Mac app (CI): the released
// ZOOD PDF.app, with no DevTools on a Mac, so the app's own session.json is
// the witness. The front tab's page in it is the page the viewer reports,
// written by the app 0.7 s after it changes, so a page that did not come
// back shows there.
//   1. Three PDFs opened from Finder (`open -a`), the first starting the
//      app: three tabs, the last in front, written down.
//   2. If this Mac lets scripts press keys (System Events), page 3 is typed
//      in Go to page; then the app is quit and started again with nothing:
//      the same tabs, front tab and page must come back.
//   3. A session left by a run with tabs on other pages, two in a group and
//      the middle one in front: started with nothing, the front tab must be
//      on its page and the group kept; then the same with another tab in
//      front.
// Writes <out>/reopen.txt with screenshots and each session.json. Exits 1
// when something that must hold does not.
//   node mac.mjs --app "<ZOOD PDF.app>" --pdfs <folder> --out <folder>
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const APP = arg('app');
const PDFS = arg('pdfs');
const OUT = arg('out');
const SESSION = join(homedir(), 'Library', 'Application Support', 'app.warraq.desktop', 'session.json');
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

async function until(what, test, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const got = await Promise.resolve()
      .then(test)
      .catch(() => null);
    if (got) return got;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const running = () => spawnSync('pgrep', ['-x', 'warraq-desktop']).status === 0;
const open = (...files) => execFileSync('open', ['-a', APP, ...files]);
const base = (path) => String(path).split('/').pop();
function session() {
  try {
    return JSON.parse(readFileSync(SESSION, 'utf8'));
  } catch {
    return null;
  }
}
const written = () => (existsSync(SESSION) ? statSync(SESSION).mtimeMs : 0);
const brief = (kept) =>
  kept
    ? kept.tabs.map((one, at) => `${base(one.path)} p${one.page}${one.group != null ? ` g${one.group}` : ''}${at === kept.active ? ' *front*' : ''}`).join(', ') +
      ` | groups: ${kept.groups.map((g) => `${g.id}:${g.name}/${g.colour}`).join(', ') || 'none'}`
    : 'no session.json';
const front = (kept) => (kept && typeof kept.active === 'number' ? kept.tabs[kept.active] : null);
const pageOf = (kept, letter) => kept?.tabs.find((one) => base(one.path) === NAME[letter])?.page ?? null;
const keep = (name) => existsSync(SESSION) && copyFileSync(SESSION, join(OUT, name));

function shot(name) {
  const done = spawnSync('screencapture', ['-x', join(OUT, name)], { encoding: 'utf8' });
  if (done.status !== 0) say(`      (no screenshot ${name}: ${(done.stderr || '').trim()})`);
}

/** Runs an AppleScript; the error text when this Mac refuses it. */
function script(...parts) {
  const done = spawnSync('osascript', parts.flatMap((part) => ['-e', part]), { encoding: 'utf8', timeout: 20_000 });
  return done.status === 0 ? null : (done.stderr || done.error?.message || 'failed').trim();
}

/** Quit as the Dock's Quit does (the quit Apple Event); then SIGTERM; then SIGKILL. Says which ended it. */
async function quit(label) {
  const ended = () => until('the app to end', () => !running(), 20_000).then(() => true, () => false);
  let how = 'the quit Apple Event';
  const refused = script('tell application id "app.warraq.desktop" to quit');
  if (refused) say(`      quit Apple Event: ${refused}`);
  if (!(await ended())) {
    how = 'SIGTERM';
    spawnSync('pkill', ['-TERM', '-x', 'warraq-desktop']);
    if (!(await ended())) {
      how = 'SIGKILL';
      spawnSync('pkill', ['-9', '-x', 'warraq-desktop']);
      await ended();
    }
  }
  say(`      ${label}: ended by ${how}`);
  check(`${label}: ZOOD ended`, !running());
  await sleep(1500);
}

/** Starts ZOOD with nothing and waits until it has written the session again and it reads as `expect` says. */
async function start(what, expect) {
  const was = written();
  open();
  let last = null;
  const got = await until(
    what,
    () => {
      last = session();
      return written() !== was && expect(last) ? last : null;
    },
    60_000,
  ).catch((error) => {
    say(`      ${error.message}; session.json: ${brief(last)}${written() === was ? ' (not written again since the start)' : ''}`);
    return null;
  });
  await sleep(2500);
  return got ?? session();
}

async function main() {
  say(`ZOOD reopen check on macOS ${new Date().toISOString()}`);
  say(`app: ${APP}`);
  say(`system: ${execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()}`);
  if (running()) {
    spawnSync('pkill', ['-9', '-x', 'warraq-desktop']);
    await sleep(2000);
  }
  rmSync(SESSION, { force: true });

  say('-- 1. three files opened from Finder');
  open(FILE.A);
  await until('A written down', () => session()?.tabs.some((one) => base(one.path) === NAME.A), 90_000).catch((error) => say(`      ${error.message}`));
  await sleep(2000);
  open(FILE.B);
  await until('B written down', () => base(front(session())?.path ?? '') === NAME.B, 30_000).catch((error) => say(`      ${error.message}`));
  open(FILE.C);
  const three = await until('C written down in front', () => (base(front(session())?.path ?? '') === NAME.C && session().tabs.length === 3 ? session() : null), 30_000).catch(() => session());
  say(`      session.json: ${brief(three)}`);
  check('three files opened from Finder are kept as three tabs, the last in front', three?.tabs.length === 3 && base(front(three)?.path ?? '') === NAME.C);
  keep('session-1-three-files.json');
  await sleep(2000);
  shot('1-three-files.png');

  say('-- 2. Go to page 3 by the keyboard, quit, start again');
  open();
  await sleep(1500);
  const refused = script(
    'tell application "System Events" to key code 53',
    'delay 0.5',
    'tell application "System Events" to key code 53',
    'delay 0.5',
    'tell application "System Events" to keystroke "n" using {command down, shift down}',
    'delay 1',
    'tell application "System Events" to keystroke "3"',
    'delay 0.3',
    'tell application "System Events" to key code 36',
  );
  let typed = false;
  if (refused) say(`      this Mac does not let scripts press keys: ${refused.split('\n')[0]}`);
  else {
    typed = !!(await until('C on page 3', () => pageOf(session(), 'C') === 3, 15_000).catch(() => false));
    say(`      after typing page 3: ${brief(session())}`);
  }
  await sleep(1500);
  shot('2-before-quit.png');
  const order = (session()?.tabs ?? []).map((one) => base(one.path));
  await quit('first quit');
  const back = await start('the tabs back', (now) => now && now.tabs.length === 3 && (!typed || pageOf(now, 'C') === 3));
  say(`      after the start: ${brief(back)}`);
  check('the same tabs come back, in the same order', JSON.stringify((back?.tabs ?? []).map((one) => base(one.path))) === JSON.stringify(order), (back?.tabs ?? []).map((one) => base(one.path)).join(', '));
  check('the same tab is in front (C)', base(front(back)?.path ?? '') === NAME.C);
  if (typed) check('C comes back on page 3, the page it was left on', pageOf(back, 'C') === 3, `page ${pageOf(back, 'C')}`);
  keep('session-2-after-start.json');
  shot('3-after-start.png');
  await quit('second quit');

  say('-- 3. a session left with pages, a group and B in front');
  const left = {
    tabs: [
      { path: FILE.A, page: 6, group: 1 },
      { path: FILE.C, page: 2, group: 1 },
      { path: FILE.B, page: 4, group: null },
    ],
    groups: [{ id: 1, name: GROUP, colour: 'green', collapsed: false }],
    active: 2,
  };
  writeFileSync(SESSION, JSON.stringify(left));
  const b = await start('B in front on page 4', (now) => now && base(front(now)?.path ?? '') === NAME.B && pageOf(now, 'B') === 4);
  say(`      after the start: ${brief(b)}`);
  check('B comes back in front on page 4 of 6', base(front(b)?.path ?? '') === NAME.B && pageOf(b, 'B') === 4, `front ${base(front(b)?.path ?? 'none')} page ${pageOf(b, 'B')}`);
  check(`the group "${GROUP}" comes back with A and C`, !!b && b.groups.some((g) => g.name === GROUP && g.colour === 'green') && b.tabs.filter((one) => one.group != null).map((one) => base(one.path)).sort().join() === [NAME.A, NAME.C].join(), brief(b));
  check('A and C keep their pages (6 and 2) while asleep', pageOf(b, 'A') === 6 && pageOf(b, 'C') === 2, brief(b));
  keep('session-3-B-front.json');
  shot('4-B-page-4.png');
  await quit('third quit');

  left.active = 0;
  writeFileSync(SESSION, JSON.stringify(left));
  const a = await start('A in front on page 6', (now) => now && base(front(now)?.path ?? '') === NAME.A && pageOf(now, 'A') === 6);
  say(`      after the start: ${brief(a)}`);
  check('A comes back in front on page 6 of 8', base(front(a)?.path ?? '') === NAME.A && pageOf(a, 'A') === 6, `front ${base(front(a)?.path ?? 'none')} page ${pageOf(a, 'A')}`);
  keep('session-4-A-front.json');
  shot('5-A-page-6.png');
  await quit('last quit');
}

try {
  await main();
} catch (error) {
  check('the check ran to the end', false, error.message.split('\n')[0]);
}
say(failed.length ? `RESULT: FAILED (${failed.join('; ')})` : 'RESULT: PASSED');
writeFileSync(join(OUT, 'reopen.txt'), `${lines.join('\n')}\n`);
process.exit(failed.length ? 1 : 0);
