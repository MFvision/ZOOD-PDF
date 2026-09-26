/**
 * Ships the licence texts of every npm package bundled into the interface (web, extension, desktop):
 * emitted as `licenses/*.txt` next to the app, plus THIRD-PARTY-NOTICES.md. Only permissive licences
 * are allowed (docs/decisions/0002-licences.md); the test in licenses.test.ts enforces it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Packages whose code or assets end up in the build (the snippet bundles preact and tailwind-merge). */
export const SHIPPED = [
  'react',
  'react-dom',
  'scheduler',
  '@embedpdf/react-pdf-viewer',
  '@embedpdf/snippet',
  '@embedpdf/pdfium',
  '@embedpdf/fonts-arabic',
  '@embedpdf/default-stamps',
  'preact',
  'tailwind-merge',
] as const;

export const ALLOWED = /^(MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC|Zlib|OFL-1\.1|CC0-1\.0|Unicode-3\.0)$/;

const REPO = path.resolve(UI_ROOT, '../..');

/** Finds an installed package directory (direct dependency or anywhere in pnpm's store). */
export function findPackage(name: string): string {
  for (const base of [path.join(UI_ROOT, 'node_modules'), path.join(REPO, 'node_modules')]) {
    const direct = path.join(base, name);
    if (fs.existsSync(path.join(direct, 'package.json'))) return fs.realpathSync(direct);
  }
  const store = path.join(REPO, 'node_modules/.pnpm');
  const prefix = `${name.replace('/', '+')}@`;
  const hit = fs.readdirSync(store).find((d) => d.startsWith(prefix));
  if (!hit) throw new Error(`package ${name} is not installed`);
  return path.join(store, hit, 'node_modules', name);
}

export interface ShippedPackage {
  name: string;
  version: string;
  license: string;
  files: { name: string; text: string }[];
}

export function shippedPackages(): ShippedPackage[] {
  return SHIPPED.map((name) => {
    const dir = findPackage(name);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version: string; license?: string };
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^(licen[cs]e|notice|copying)/i.test(f))
      .map((f) => ({ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
    // Some packages only state their licence in the LICENSE file (e.g. @embedpdf/default-stamps).
    const fromFile = files.some((f) => /^\s*MIT License/.test(f.text)) ? 'MIT' : 'UNKNOWN';
    return { name, version: pkg.version, license: pkg.license ?? fromFile, files };
  });
}

export function zoodLicenses(): Plugin {
  return {
    name: 'zood:licenses',
    apply: 'build',
    generateBundle() {
      const index: string[] = ['ZOOD PDF — third-party licences shipped in this build', ''];
      for (const p of shippedPackages()) {
        index.push(`${p.name} ${p.version} (${p.license})`);
        for (const f of p.files) {
          this.emitFile({ type: 'asset', fileName: `licenses/${p.name.replace('@', '').replace('/', '-')}-${f.name}.txt`, source: f.text });
        }
      }
      this.emitFile({ type: 'asset', fileName: 'licenses/INDEX.txt', source: `${index.join('\n')}\n` });
      const notices = path.join(REPO, 'THIRD-PARTY-NOTICES.md');
      if (fs.existsSync(notices)) this.emitFile({ type: 'asset', fileName: 'licenses/THIRD-PARTY-NOTICES.md', source: fs.readFileSync(notices, 'utf8') });
      this.emitFile({ type: 'asset', fileName: 'licenses/ZOOD-PDF-LICENSE.txt', source: fs.readFileSync(path.join(REPO, 'LICENSE'), 'utf8') });
      // Fonts compiled into the engine (Edit / Create PDF embed subsets of them): OFL texts.
      const engineFonts = path.join(REPO, 'packages/core/assets/fonts');
      if (fs.existsSync(engineFonts)) {
        for (const family of fs.readdirSync(engineFonts)) {
          const ofl = path.join(engineFonts, family, 'OFL.txt');
          if (fs.existsSync(ofl)) this.emitFile({ type: 'asset', fileName: `licenses/font-${family}-OFL.txt`, source: fs.readFileSync(ofl, 'utf8') });
        }
      }
    },
  };
}
