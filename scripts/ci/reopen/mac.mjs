// Reopen where you left off, in the released Mac app (CI), with a person's
// hands: files given to the app on its command line (a second launch hands
// them to the running app through its single-instance socket), keys pressed
// through System Events, screenshots with screencapture, and Quit as the
// Dock's Quit sends it (the quit Apple Event). The steps and checks are
// flow.mjs's.
//   node mac.mjs --app "<ZOOD PDF.app>" --pdfs <folder> --out <folder>
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from './flow.mjs';

const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const APP = arg('app');
const PDFS = arg('pdfs');
const OUT = arg('out');
const ID = 'app.warraq.desktop';
mkdirSync(OUT, { recursive: true });
// The app's own WARRAQ_DEBUG lines: what it was handed and what EmbedPDF did.
const log = openSync(join(OUT, 'app.log'), 'a');

/** Runs AppleScript; its output, or throws with what macOS said. */
function script(...parts) {
  const done = spawnSync('osascript', parts.flatMap((part) => ['-e', part]), { encoding: 'utf8', timeout: 20_000 });
  if (done.status !== 0) throw new Error((done.stderr || done.error?.message || 'osascript failed').trim().split('\n')[0]);
  return done.stdout.trim();
}

const KEY_CODES = { esc: 53, enter: 36, tab: 48 };
const MODIFIERS = { ctrl: 'control down', shift: 'shift down', cmd: 'command down', alt: 'option down' };

/** 'cmd+shift+n' → System Events' keystroke or key code, with its modifiers. */
function press(chord) {
  const parts = chord.toLowerCase().split('+');
  const key = parts.pop();
  const using = parts.map((name) => {
    if (!MODIFIERS[name]) throw new Error(`no modifier called ${name}`);
    return MODIFIERS[name];
  });
  const what = KEY_CODES[key] !== undefined ? `key code ${KEY_CODES[key]}` : key.length === 1 ? `keystroke "${key}"` : null;
  if (!what) throw new Error(`no key called ${key}`);
  script(`tell application "System Events" to ${what}${using.length ? ` using {${using.join(', ')}}` : ''}`);
}

const running = () => spawnSync('pgrep', ['-x', 'warraq-desktop']).status === 0;

const hands = {
  platform: 'macOS',
  session: join(homedir(), 'Library', 'Application Support', ID, 'session.json'),
  mod: 'cmd',
  async about() {
    let size = 'of a size not known';
    try {
      size = script('tell application "Finder" to get bounds of window of desktop').replace(/^0, 0, /, '').replace(', ', 'x');
    } catch {
      /* Finder not scriptable here: only the size goes unsaid */
    }
    return [`app: ${APP}`, `macOS ${execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()}, screen ${size}`];
  },
  start(files) {
    spawn(join(APP, 'Contents', 'MacOS', 'warraq-desktop'), files, { detached: true, stdio: ['ignore', log, log], env: { ...process.env, WARRAQ_DEBUG: '1' } }).unref();
  },
  running,
  kill() {
    spawnSync('pkill', ['-9', '-x', 'warraq-desktop']);
  },
  async front() {
    try {
      try {
        script(`tell application id "${ID}" to activate`);
      } catch {
        // Not known to Launch Services by its id: the process itself, by its number.
        const pid = spawnSync('pgrep', ['-x', 'warraq-desktop'], { encoding: 'utf8' }).stdout.trim().split(/\s+/)[0];
        script(`tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
      const name = script('tell application "System Events" to get name of first process whose frontmost is true');
      const pid = script('tell application "System Events" to get unix id of first process whose frontmost is true');
      const ours = spawnSync('pgrep', ['-x', 'warraq-desktop'], { encoding: 'utf8' }).stdout.split(/\s+/).includes(pid);
      return `${ours ? 'ZOOD in front' : 'NOT ZOOD in front'}: ${name} (${pid})`;
    } catch (error) {
      return `could not bring ZOOD to the front: ${error.message}`;
    }
  },
  async keys(chord) {
    press(chord);
  },
  async shot(file) {
    execFileSync('screencapture', ['-x', file]);
  },
  // Quit as the Dock's Quit does; flow.mjs waits for the app to end.
  async quit() {
    try {
      script(`with timeout of 10 seconds`, `tell application id "${ID}" to quit`, `end timeout`);
      return 'the quit Apple Event sent';
    } catch (error) {
      return `the quit Apple Event was refused: ${error.message}`;
    }
  },
};

const failed = await run(hands, { pdfs: PDFS, out: OUT });
process.exit(failed ? 1 : 0);
