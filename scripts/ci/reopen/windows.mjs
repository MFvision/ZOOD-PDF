// Reopen where you left off, in the installed Windows app (CI), with a
// person's hands: files given to the app as Explorer gives them (the path on
// its command line; a second launch hands it to the running app), keys
// pressed and the window closed through Windows itself (hands.ps1), never
// through the app's insides. The steps and checks are flow.mjs's.
//   node windows.mjs --app <warraq-desktop.exe> --pdfs <folder> --out <folder>
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { run } from './flow.mjs';

const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const APP = arg('app');
const PDFS = arg('pdfs');
const OUT = arg('out');
mkdirSync(OUT, { recursive: true });
// The app's own WARRAQ_DEBUG lines: what it was handed and what EmbedPDF did.
const log = openSync(join(OUT, 'app.log'), 'a');

/** hands.ps1, started once: one request per line, one answer per line. */
function helper() {
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dirname(fileURLToPath(import.meta.url)), 'hands.ps1')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = [];
  createInterface({ input: child.stdout }).on('line', (line) => waiting.shift()?.(line));
  child.stderr.on('data', (chunk) => {
    console.log(`(hands.ps1: ${String(chunk).trim()})`);
    appendFileSync(join(OUT, 'hands.log'), chunk);
  });
  child.on('exit', (code) => {
    for (const next of waiting.splice(0)) next(`error hands.ps1 ended (${code})`);
  });
  const answer = (ms, what) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`hands.ps1 did not answer ${what} in ${ms / 1000} s`)), ms);
      waiting.push((line) => {
        clearTimeout(timer);
        if (line.startsWith('ok')) resolve(line.slice(3));
        else reject(new Error(line.replace(/^error /, '')));
      });
    });
  const ready = answer(60_000, 'at its start');
  return {
    ready,
    ask(request, ms = 30_000) {
      const reply = answer(ms, `"${request}"`);
      child.stdin.write(`${request}\n`);
      return reply;
    },
    end() {
      child.stdin.end();
    },
  };
}

function running() {
  try {
    return execFileSync('tasklist', ['/FI', 'IMAGENAME eq warraq-desktop.exe', '/NH'], { encoding: 'utf8' }).includes('warraq-desktop.exe');
  } catch {
    return false;
  }
}

const hand = helper();

const hands = {
  platform: 'Windows',
  session: join(process.env.APPDATA ?? '', 'app.warraq.desktop', 'session.json'),
  mod: 'ctrl',
  async about() {
    const size = await hand.ask(`shot ${join(tmpdir(), 'reopen-screen-size.png')}`);
    return [`app: ${APP}`, `Windows ${release()}, screen ${size}`];
  },
  start(files) {
    spawn(APP, files, { detached: true, stdio: ['ignore', log, log], env: { ...process.env, WARRAQ_DEBUG: '1' } }).unref();
  },
  running,
  kill() {
    try {
      execFileSync('taskkill', ['/F', '/IM', 'warraq-desktop.exe'], { stdio: 'ignore' });
    } catch {
      /* not running */
    }
  },
  front: () => hand.ask('front'),
  keys: (chord) => hand.ask(`keys ${chord}`),
  shot: (file) => hand.ask(`shot ${resolve(file)}`),
  // The close button's message to the main window, as a person closes it.
  quit: () => hand.ask('close'),
};

let failed = 1;
try {
  await hand.ready;
  failed = await run(hands, { pdfs: PDFS, out: OUT });
} catch (error) {
  // Only when the hands themselves did not start: run() reports everything else.
  const text = `ZOOD reopen check on Windows\nFAIL  the check's hands (hands.ps1) did not start (${error.message}; see hands.log)\nRESULT: FAILED\n`;
  console.log(text);
  writeFileSync(join(OUT, 'reopen.txt'), text);
}
hand.end();
process.exit(failed ? 1 : 0);
