#!/usr/bin/env node
// Privacy audit for the extension folder. No dependencies; run:  node audit.mjs
//
// It fails (exit 1) if the extension could do more than blur the page:
//   * the manifest asks for anything beyond the "storage" permission and web.whatsapp.com,
//     can auto-update, can be messaged by other extensions or sites, or exposes files to pages;
//   * any script contains a way to send data out, read the page, read keys, or run hidden code;
//   * any file is not one of the known, readable kinds.
// It also prints a SHA-256 for every file so you can tell if anything changed later.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('./extension/', import.meta.url));
const problems = [];
const fail = (msg) => problems.push(msg);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// ---- manifest ----

const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

if (!same(manifest.permissions, ['storage'])) {
  fail(`manifest: permissions must be exactly ["storage"], found ${JSON.stringify(manifest.permissions)}`);
}
for (const key of [
  'host_permissions', 'optional_permissions', 'optional_host_permissions', 'web_accessible_resources',
  'update_url', 'oauth2', 'key', 'declarative_net_request', 'chrome_url_overrides', 'devtools_page',
  'sandbox', 'side_panel', 'options_page', 'options_ui', 'storage',
]) {
  if (key in manifest) fail(`manifest: "${key}" is not allowed`);
}
const ext = manifest.externally_connectable;
if (!ext || !same(ext.ids, []) || ext.matches?.length || ext.accepts_tls_channel_id) {
  fail('manifest: externally_connectable must be { "ids": [] } so no other extension or site can talk to it');
}
const scripts = manifest.content_scripts ?? [];
for (const cs of scripts) {
  if (!same(cs.matches, ['https://web.whatsapp.com/*'])) {
    fail(`manifest: content script may only run on https://web.whatsapp.com/*, found ${JSON.stringify(cs.matches)}`);
  }
  if (cs.all_frames || cs.match_about_blank || cs.match_origin_as_fallback || cs.world === 'MAIN') {
    fail('manifest: content script must stay in the top frame and the isolated world');
  }
}
const csp = manifest.content_security_policy?.extension_pages ?? '';
for (const directive of ["default-src 'none'", "connect-src 'none'", "script-src 'self'"]) {
  if (!csp.includes(directive)) fail(`manifest: extension_pages CSP must include ${directive}`);
}

// ---- files ----

const ALLOWED_TYPES = new Set(['.js', '.css', '.html', '.json', '.png']);
const files = walk(DIR).sort();
for (const file of files) {
  if (!ALLOWED_TYPES.has(extname(file))) fail(`${relative(DIR, file)}: unexpected file type`);
}

// Anything that can send data out, read the page or the keyboard, or load code.
// Each line is checked after its // comments are removed.
const FORBIDDEN = [
  [/\bfetch\s*\(/, 'network: fetch()'],
  [/XMLHttpRequest/, 'network: XMLHttpRequest'],
  [/WebSocket/, 'network: WebSocket'],
  [/EventSource/, 'network: EventSource'],
  [/sendBeacon/, 'network: sendBeacon'],
  [/RTCPeerConnection|RTCDataChannel/, 'network: WebRTC'],
  [/\bnew\s+(Image|Audio)\b/, 'network: image or audio request'],
  [/\.src\s*=|\.href\s*=|\.action\s*=|\.srcset\s*=/, 'network: setting a URL on an element'],
  [/\bopen\s*\(/, 'network: window.open()'],
  [/https?:\/\/(?!www\.w3\.org\/2000\/svg')/, 'network: a web address'],
  [/\bimport\s*\(|\bimport\s+[\w{*]/, 'code loading: import'],
  [/importScripts\s*\((?!'defaults\.js'\))/, 'code loading: importScripts other than defaults.js'],
  [/\beval\b|\bFunction\s*\(|setTimeout\s*\(\s*['"`]|setInterval\s*\(\s*['"`]/, 'code loading: eval'],
  [/\bnew\s+(Shared)?Worker\b/, 'code loading: worker'],
  [/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser/, 'HTML strings'],
  [/postMessage|BroadcastChannel/, 'talking to the page or other contexts'],
  [/chrome\.runtime\.(sendMessage|connect|onMessage|onConnect)/, 'extension messaging'],
  [/chrome\.(tabs|scripting|webRequest|declarativeNetRequest|cookies|history|downloads|debugger|identity)\b/,
    'privileged chrome API'],
  [/chrome\.storage\.sync/, 'synced storage (would leave this computer)'],
];

// Extra rules for content.js, the only script that runs inside WhatsApp Web: it must not look at the page.
const PAGE_ONLY = [
  [/innerText/, 'reading page text: innerText'],
  [/document\.(querySelector|getElement|evaluate|forms|links|images|body\.)/, 'reading the page'],
  [/\bMutationObserver\b/, 'watching the page'],
  [/\bkey(down|up|press)\b|KeyboardEvent/, 'reading the keyboard'],
  [/clipboard|getSelection|execCommand/, 'reading the clipboard or selection'],
  [/document\.cookie|localStorage|sessionStorage|indexedDB/, 'reading page storage'],
  [/getDisplayMedia|getUserMedia|captureVisibleTab|tabCapture|desktopCapture|html2canvas|toDataURL/,
    'screenshots, camera or microphone'],
];

let lines = 0;
for (const file of files.filter((f) => ['.js', '.html'].includes(extname(f)))) {
  const name = relative(DIR, file);
  readFileSync(file, 'utf8').split('\n').forEach((raw, i) => {
    lines += 1;
    if (raw.length > 160) fail(`${name}:${i + 1}: line longer than 160 characters (minified code?)`);
    const code = raw.replace(/(^|[^:])\/\/.*$/, '$1');
    const rules = name === 'content.js' ? [...FORBIDDEN, ...PAGE_ONLY] : FORBIDDEN;
    for (const [pattern, why] of rules) {
      if (pattern.test(code)) fail(`${name}:${i + 1}: ${why}\n    ${raw.trim()}`);
    }
  });
}

// popup.html may only load its own two scripts and stylesheet.
const popup = readFileSync(join(DIR, 'popup.html'), 'utf8');
const refs = [...popup.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]).sort();
if (!same(refs, ['defaults.js', 'icons/icon-32.png', 'popup.css', 'popup.js'])) {
  fail(`popup.html: unexpected resources ${JSON.stringify(refs)}`);
}

// ---- report ----

console.log(`Extension: ${manifest.name === '__MSG_extName__' ? 'Privacy Blur for WhatsApp Web' : manifest.name}`);
console.log(`Permissions: ${JSON.stringify(manifest.permissions)}   Runs on: https://web.whatsapp.com/*`);
console.log(`Files (${files.length}, ${lines} lines of script and HTML):`);
for (const file of files) {
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
  console.log(`  ${hash}  ${relative(DIR, file)}`);
}
if (problems.length) {
  console.log(`\nFAIL: ${problems.length} problem(s)`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('\nPASS: no network access, no page reading, no extra permissions.');
