#!/usr/bin/env node
// Validates the built extension the way the browser does: runs Chrome (or
// Chromium/Edge/Brave, via CHROME_BIN) headless with --pack-extension on a copy
// of dist/ inside a temp dir. Chrome refuses to pack an extension whose
// manifest is invalid and prints the reason; a .crx is produced otherwise.
// Usage: node scripts/pack-chrome.mjs [--keep]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const keep = process.argv.includes('--keep');

const CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

function findChrome() {
  for (const c of CANDIDATES) {
    if (/[\\/]/.test(c)) {
      if (existsSync(c)) return c;
    } else if (!spawnSync(c, ['--version'], { stdio: 'ignore' }).error) {
      return c;
    }
  }
  return null;
}

if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('pack-chrome: dist/manifest.json is missing; run the build first');
  process.exit(1);
}
const chrome = findChrome();
if (!chrome) {
  console.error('pack-chrome: no Chrome/Chromium binary found (set CHROME_BIN)');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'warraq-ext-'));
const extDir = join(tmp, 'warraq-extension');
cpSync(dist, extDir, { recursive: true });
for (const f of ['warraq-extension.zip']) rmSync(join(extDir, f), { force: true });

const args = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${join(tmp, 'profile')}`,
  `--pack-extension=${extDir}`,
];
console.log(`pack-chrome: ${chrome} --pack-extension=${extDir}`);
const res = spawnSync(chrome, args, { encoding: 'utf8', timeout: 120_000 });
const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
const crx = `${extDir}.crx`;
const ok = !res.error && existsSync(crx) && statSync(crx).size > 0;

if (output)
  console.log(
    output
      .split('\n')
      .filter((l) => !/DevTools|dbus|Fontconfig/.test(l))
      .join('\n'),
  );
if (ok) {
  console.log(`pack-chrome: OK — Chrome packed the extension (${statSync(crx).size} bytes .crx)`);
} else {
  console.error(
    `pack-chrome: FAILED — Chrome did not produce ${crx}${res.error ? ` (${res.error.message})` : ''}; see the manifest errors above`,
  );
}
if (keep) console.log(`pack-chrome: kept ${tmp}`);
else rmSync(tmp, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
