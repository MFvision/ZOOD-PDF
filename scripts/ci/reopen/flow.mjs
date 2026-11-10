// Reopen where you left off, tried in the released app as a person uses it
// (windows.mjs and mac.mjs give it hands on each system). Three witnesses:
//   - the app's own session.json: the tabs, their order, groups, front tab
//     and each tab's page, as ZOOD keeps them;
//   - the screen: every page of the sample PDFs has its own colour
//     (pdfs.mjs), so a screenshot says which page a person actually sees,
//     not only what the page box says;
//   - screenshots kept in <out>, for a person to look at.
// Steps: three files opened, each sent to its own page, the tabs switched;
// ZOOD closed and started again with nothing; a page turned just before
// closing; a session with a tab group; a file deleted while ZOOD was closed.
// Writes <out>/reopen.txt; resolves with the number of failed checks.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { FILES, writePdfs } from './pdfs.mjs';
import { pageOnScreen } from './screen.mjs';

const NAME = { A: 'A-restore.pdf', B: 'B-restore.pdf', C: 'C-restore.pdf' };
const GROUP = 'Restore test';

/**
 * hands: { platform, session (session.json's path), mod ('ctrl' or 'cmd'),
 *   about(): lines, start(files), running(), kill(), front(): what is in front,
 *   keys(chord) e.g. 'ctrl+shift+n', 'esc', 'enter', 'ctrl+tab', '4',
 *   shot(file.png), quit(): how ZOOD was asked to close }
 */
export async function run(hands, { pdfs, out }) {
  mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'reopen-screens-'));
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

  const base = (path) => String(path).split(/[\\/]/).pop();
  const letterOf = (path) => Object.keys(NAME).find((letter) => NAME[letter] === base(path)) ?? base(path);
  const session = () => {
    try {
      return JSON.parse(readFileSync(hands.session, 'utf8'));
    } catch {
      return null;
    }
  };
  const written = () => (existsSync(hands.session) ? statSync(hands.session).mtimeMs : 0);
  const brief = (kept) =>
    kept && Array.isArray(kept.tabs)
      ? `${kept.tabs.map((one, at) => `${letterOf(one.path)} p${one.page}${one.group != null ? ` g${one.group}` : ''}${at === kept.active ? ' (front)' : ''}`).join(', ') || 'no tabs'}; groups: ${
          (kept.groups ?? []).map((g) => `${g.id} "${g.name}" ${g.colour}${g.collapsed ? ' folded' : ''}`).join(', ') || 'none'
        }`
      : 'no session.json';
  const inFront = (kept) => (kept && Number.isInteger(kept.active) && kept.tabs?.[kept.active] ? letterOf(kept.tabs[kept.active].path) : null);
  const pageOf = (kept, letter) => kept?.tabs?.find((one) => letterOf(one.path) === letter)?.page ?? null;
  const order = (kept) => (kept?.tabs ?? []).map((one) => letterOf(one.path)).join('');
  const keep = (name) => existsSync(hands.session) && copyFileSync(hands.session, join(out, name));

  /** Waits until session.json passes `test`; null (and a line saying what it holds) when it never does. */
  async function waitFor(what, test, ms = 15_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const now = session();
      if (now && test(now)) return now;
      await sleep(250);
    }
    say(`      waited ${Math.round(ms / 1000)} s for ${what}; session.json: ${brief(session())}`);
    return null;
  }

  async function until(test, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await test()) return true;
      await sleep(300);
    }
    return false;
  }

  const front = async () => {
    const said = await hands.front();
    if (!/^ZOOD in front/.test(said)) say(`      (bringing ZOOD to the front: ${said})`);
  };
  const keys = (chord) => hands.keys(chord.replace(/\bmod\b/, hands.mod));
  /** Go to page (Ctrl+Shift+N or Cmd+Shift+N), the number, Enter. */
  async function goTo(page) {
    await front();
    await keys('mod+shift+n');
    await sleep(900);
    for (const digit of String(page)) await keys(digit);
    await sleep(250);
    await keys('enter');
  }
  async function nextTab() {
    await front();
    await keys('ctrl+tab');
  }
  const shot = (name) => hands.shot(join(out, name)).catch((error) => say(`      (no screenshot ${name}: ${error.message})`));

  /**
   * The page a person sees: screenshots until `page`'s colour covers the
   * document view and still does 2.5 s later (not only on its way through).
   */
  let screens = 0;
  async function onScreen(letter, page, label, name) {
    let last = { page: null, seen: 'nothing yet' };
    const read = async () => {
      const file = join(scratch, `screen-${++screens}.png`);
      try {
        await hands.shot(file);
        return { file, ...pageOnScreen(file) };
      } catch (error) {
        return { file: null, page: null, seen: `no screenshot: ${error.message}` };
      }
    };
    const end = Date.now() + 25_000;
    while (Date.now() < end) {
      last = await read();
      if (last.page === page) {
        await sleep(2500);
        last = await read();
        if (last.page === page) break;
      }
      await sleep(1000);
    }
    if (last.file) copyFileSync(last.file, join(out, name));
    const what = last.page ? `page ${last.page}` : 'no page of the file';
    return check(label, last.page === page, `${letter} of ${FILES[letter]} pages; the screen shows ${what}: ${last.seen}; ${name}`);
  }

  async function ended(label) {
    const gone = await until(() => !hands.running(), 20_000);
    check(`${label}: ZOOD ends`, gone);
    if (!gone) {
      hands.kill();
      await sleep(2000);
    }
    await sleep(1500);
  }
  async function quit(label) {
    say(`      ${label}: ${await hands.quit()}`);
    await ended(label);
  }
  /**
   * When no page of the file can be seen at all, something is over it (the
   * first run's welcome tour, a note): kept as a screenshot, said, and
   * Escape pressed once, so the checks after it look at the page itself.
   */
  async function uncover(name) {
    const file = join(scratch, `uncover-${++screens}.png`);
    try {
      await hands.shot(file);
    } catch {
      return;
    }
    const now = pageOnScreen(file);
    if (now.page) return;
    copyFileSync(file, join(out, name));
    say(`      no page of the file on screen (${now.seen}): something over it? Escape pressed once; see ${name}`);
    await front();
    await keys('esc');
    await sleep(1000);
  }

  /** Starts ZOOD with nothing; waits until it has written its session again and the session passes `expect`. */
  async function startAgain(what, expect, name) {
    const was = written();
    hands.start([]);
    const got = await waitFor(what, (now) => written() !== was && expect(now), 60_000);
    await sleep(3000);
    await front();
    await uncover(name);
    return got ?? session();
  }

  try {
    say(`ZOOD reopen check on ${hands.platform}, ${new Date().toISOString()}`);
    for (const line of await hands.about()) say(line);
    if (hands.running()) {
      say('ZOOD was running already: ended first');
      hands.kill();
      await sleep(2000);
    }
    rmSync(hands.session, { force: true });
    const file = writePdfs(pdfs);

    say('-- 1. three files opened as from the file manager: the first starts ZOOD, the next two go to it');
    hands.start([file.A]);
    if (!(await waitFor('A open', (now) => order(now) === 'A', 120_000))) throw new Error('ZOOD did not open the first file');
    await sleep(3000);
    await front();
    await keys('esc'); // the first run's welcome tour
    await sleep(1000);
    await shot('1-first-file.png');
    await uncover('1-first-file-covered.png');
    hands.start([file.B]);
    await waitFor('B open in front', (now) => order(now) === 'AB' && inFront(now) === 'B', 30_000);
    hands.start([file.C]);
    const three = await waitFor('C open in front', (now) => order(now) === 'ABC' && inFront(now) === 'C', 30_000);
    check('three files, three tabs, the last one in front', !!three, brief(session()));
    await sleep(1500);
    await onScreen('C', 1, 'C, just opened, shows its first page', '2-C-opened.png');

    say('-- 2. each file sent to its own page (Go to page), Ctrl+Tab between the tabs');
    await goTo(4);
    check('Go to page takes C to page 4 (the keys reach ZOOD)', !!(await waitFor('C on page 4', (now) => pageOf(now, 'C') === 4)), brief(session()));
    await onScreen('C', 4, 'C shows page 4 after Go to page (the check reads the screen)', '3-C-page-4.png');
    await nextTab();
    check('Ctrl+Tab goes on to the next tab, round to the first (A)', !!(await waitFor('A in front', (now) => inFront(now) === 'A')), brief(session()));
    await goTo(6);
    await waitFor('A on page 6', (now) => pageOf(now, 'A') === 6);
    await onScreen('A', 6, 'A shows page 6 after Go to page', '4-A-page-6.png');
    await nextTab();
    await waitFor('B in front', (now) => inFront(now) === 'B');
    await goTo(4);
    await waitFor('B on page 4', (now) => pageOf(now, 'B') === 4);
    await onScreen('B', 4, 'B shows page 4 after Go to page', '5-B-page-4.png');

    say('-- 3. back to the other tabs in the same run');
    await nextTab();
    await waitFor('C in front', (now) => inFront(now) === 'C');
    await onScreen('C', 4, 'C, shown again, is still on page 4 on screen', '6-C-again.png');
    check('... and ZOOD says page 4 for C', pageOf(session(), 'C') === 4, brief(session()));
    await nextTab();
    await waitFor('A in front', (now) => inFront(now) === 'A');
    await onScreen('A', 6, 'A, shown again, is still on page 6 on screen', '7-A-again.png');
    check('... and ZOOD says page 6 for A', pageOf(session(), 'A') === 6, brief(session()));
    await nextTab();
    const before = await waitFor('B in front, A 6, B 4, C 4', (now) => inFront(now) === 'B' && pageOf(now, 'A') === 6 && pageOf(now, 'B') === 4 && pageOf(now, 'C') === 4);
    check('ZOOD keeps A on 6, B on 4, C on 4, with B in front', !!before, brief(session()));
    keep('session-1-before-closing.json');
    await shot('8-before-closing.png');

    say('-- 4. ZOOD closed, then started again with nothing');
    await quit('first close');
    const back = await startAgain('the three tabs back with B in front', (now) => now.tabs.length === 3 && inFront(now) === 'B', '9-start-covered.png');
    check('the same three tabs come back, in the same order', order(back) === 'ABC', brief(back));
    check('the same tab is in front (B)', inFront(back) === 'B', brief(back));
    check('ZOOD says B is on page 4', pageOf(back, 'B') === 4, brief(back));
    await onScreen('B', 4, 'B, in front at the start, shows page 4 on screen', '9-start-B.png');
    await nextTab();
    await waitFor('C in front', (now) => inFront(now) === 'C');
    await onScreen('C', 4, 'C, asleep until shown, shows page 4 on screen', '10-start-C.png');
    check('... and ZOOD says page 4 for C', pageOf(session(), 'C') === 4, brief(session()));
    await nextTab();
    await waitFor('A in front', (now) => inFront(now) === 'A');
    await onScreen('A', 6, 'A, asleep until shown, shows page 6 on screen', '11-start-A.png');
    check('... and ZOOD says page 6 for A', pageOf(session(), 'A') === 6, brief(session()));
    keep('session-2-after-start.json');

    say('-- 5. a page turned just before closing ZOOD');
    await goTo(2);
    say(`      closed at once: ${await hands.quit()}`);
    await ended('quick close');
    const quick = await startAgain('the three tabs back', (now) => now.tabs.length === 3, '12-start-covered.png');
    const kept = pageOf(quick, 'A');
    check('a page turned just before closing is kept (A on 2)', kept === 2, `A came back on page ${kept}`, false);
    if (inFront(quick) === 'A' && kept) await onScreen('A', kept, `A shows on screen the page ZOOD says (${kept})`, '12-quick-close.png');
    await quit('close');

    say('-- 6. a session left with a tab group (A and C) and B in front');
    writeFileSync(
      hands.session,
      JSON.stringify({
        tabs: [
          { path: file.A, page: 6, group: 1 },
          { path: file.C, page: 4, group: 1 },
          { path: file.B, page: 4, group: null },
        ],
        groups: [{ id: 1, name: GROUP, colour: 'green', collapsed: false }],
        active: 2,
      }),
    );
    const grouped = await startAgain('B in front, with the group', (now) => now.tabs.length === 3 && inFront(now) === 'B', '13-start-covered.png');
    check(
      `the group "${GROUP}" comes back, green, holding A and C`,
      !!grouped?.groups?.some((g) => g.name === GROUP && g.colour === 'green') &&
        grouped.tabs.filter((one) => one.group != null).map((one) => letterOf(one.path)).sort().join('') === 'AC',
      brief(grouped),
    );
    check('the tabs come back in the order they were left (A, C, B)', order(grouped) === 'ACB', brief(grouped));
    check('ZOOD says B is on page 4', pageOf(grouped, 'B') === 4, brief(grouped));
    await onScreen('B', 4, 'B shows page 4 on screen', '13-group-B.png');
    keep('session-3-group.json');
    await quit('close');

    say('-- 7. C deleted while ZOOD was closed');
    rmSync(file.C, { force: true });
    const left = await startAgain('two tabs', (now) => now.tabs.length === 2, '14-start-covered.png');
    check("C's tab is gone; A and B are back", order(left) === 'AB', brief(left));
    check('A and B keep their pages (6 and 4)', pageOf(left, 'A') === 6 && pageOf(left, 'B') === 4, brief(left));
    await sleep(1500);
    await shot('14-file-gone.png');
    keep('session-4-file-gone.json');
    await quit('last close');
  } catch (error) {
    check('the check ran to the end', false, String(error?.message ?? error).split('\n')[0]);
    await shot('stopped-here.png');
    if (hands.running()) hands.kill();
  }
  rmSync(scratch, { recursive: true, force: true });
  say(failed.length ? `RESULT: FAILED (${failed.length}: ${failed.join('; ')})` : 'RESULT: PASSED');
  writeFileSync(join(out, 'reopen.txt'), `${lines.join('\n')}\n`);
  return failed.length;
}
