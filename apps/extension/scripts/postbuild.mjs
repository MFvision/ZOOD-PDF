#!/usr/bin/env node
// Runs after `vite build`: copies the static extension files into dist/ and
// writes dist/warraq-extension.zip (manifest.json at the zip root, as the
// Chrome Web Store, Edge Add-ons and Brave expect).
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const STATIC = ['manifest.json', 'background.js', '_locales', 'icons'];
const ZIP_NAME = 'warraq-extension.zip';
const EXCLUDE = /\.(zip|crx|pem|map)$|(^|\/)\.DS_Store$/;

if (!existsSync(join(dist, 'viewer.html'))) {
  console.error('postbuild: dist/viewer.html is missing; run `vite build` first');
  process.exit(1);
}
for (const entry of STATIC) {
  cpSync(join(root, entry), join(dist, entry), { recursive: true });
}
rmSync(join(dist, ZIP_NAME), { force: true });

const files = {};
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs);
    else {
      const rel = relative(dist, abs).split(sep).join('/');
      if (!EXCLUDE.test(rel)) files[rel] = readFileSync(abs);
    }
  }
})(dist);

const zip = zipSync(files, { level: 9 });
writeFileSync(join(dist, ZIP_NAME), zip);
const total = Object.values(files).reduce((n, b) => n + b.length, 0);
console.log(
  `postbuild: dist/${ZIP_NAME} — ${Object.keys(files).length} files, ${total} bytes uncompressed, ${zip.length} bytes zipped`,
);
