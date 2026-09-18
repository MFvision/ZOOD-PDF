#!/usr/bin/env node
// Writes the licence texts of every Rust crate linked into the desktop app,
// for the host it is built on, to the file named on the command line:
//
//   node scripts/rust-licenses.mjs apps/web/dist/licenses/RUST-CRATES.md
//
// `apps/web`'s `build:tauri` runs it, so the desktop bundle carries them next
// to the JavaScript packages' (THIRD-PARTY-NOTICES.md). Each distinct text is
// written once, under the crates it covers; where a crate is offered under
// MIT or another licence, MIT is the one taken.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.argv[2];
if (!out) {
  console.error('usage: rust-licenses.mjs <output.md>');
  process.exit(2);
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = join(repo, 'apps/desktop/src-tauri/Cargo.toml');

const host = /^host: (.+)$/m.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))?.[1];
if (!host) throw new Error('rustc did not name its host');
const args = [
  'metadata',
  '--format-version',
  '1',
  '--manifest-path',
  manifest,
  '--filter-platform',
  host,
];
let json;
try {
  // Offline first: everything a build of this host links is already fetched.
  json = execFileSync('cargo', [...args, '--offline'], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch {
  json = execFileSync('cargo', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
}
const metadata = JSON.parse(json);
const own = new Set(metadata.workspace_members);
const linked = new Set(metadata.resolve.nodes.map((node) => node.id));

const LICENCE_FILE = /^(licen[cs]e|copying|notice|unlicense)/i;

/** The licence files a crate ships, the MIT one alone when MIT is offered. */
function texts(pkg) {
  const dir = dirname(pkg.manifest_path);
  const files = readdirSync(dir)
    .filter((name) => LICENCE_FILE.test(name))
    .sort();
  const mitOffered = /\bMIT\b/.test(pkg.license ?? '') && / OR |\//.test(pkg.license ?? '');
  const mit = files.filter((name) => /mit/i.test(name));
  const chosen = mitOffered && mit.length > 0 ? mit : files;
  return chosen.map((name) => readFileSync(join(dir, name), 'utf8').trim());
}

const byText = new Map();
const without = [];
for (const pkg of metadata.packages) {
  if (!linked.has(pkg.id) || own.has(pkg.id)) continue;
  const label = `${pkg.name} ${pkg.version} (${pkg.license ?? pkg.license_file ?? 'no licence named'})`;
  const found = texts(pkg);
  if (found.length === 0) without.push(`${label}${pkg.repository ? ` — ${pkg.repository}` : ''}`);
  for (const text of found) {
    const crates = byText.get(text) ?? [];
    crates.push(label);
    byText.set(text, crates);
  }
}

const sections = [...byText.entries()]
  .map(([text, crates]) => ({ text, crates: crates.sort() }))
  .sort((a, b) => a.crates[0].localeCompare(b.crates[0]));
const lines = [
  '# Rust crates in the desktop app',
  '',
  `The crates linked into Warraq's desktop app on ${host}, and their licence texts.`,
  'Each text is given once, under every crate it covers.',
  '',
];
for (const { text, crates } of sections) {
  lines.push(...crates.map((crate) => `- ${crate}`), '', '```text', text, '```', '');
}
if (without.length > 0) {
  lines.push(
    '## Crates that ship no licence file',
    '',
    'Their licence is the one named; its text is in their repository.',
    '',
  );
  lines.push(...without.sort().map((crate) => `- ${crate}`), '');
}
mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(out, lines.join('\n'));
console.log(
  `rust-licenses: ${linked.size - own.size} crates, ${sections.length} distinct texts -> ${out}`,
);
