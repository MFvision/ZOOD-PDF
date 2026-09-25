/**
 * Vite plugins shared by every host that bundles @zood/ui (web, extension, desktop).
 *
 * - zoodEngine: resolves `virtual:warraq-core` to the wasm-pack output in src/wasm/pkg and FAILS the
 *   build when it is missing (no silent mock). `ZOOD_ALLOW_MISSING_ENGINE=1` is a development-only
 *   escape hatch that produces an engine whose every call rejects with `engine_missing`.
 * - zoodEmbedPdfPatches: rewrites EmbedPDF's hard-coded English literals into runtime lookups, driven
 *   by src/viewer/embedpdf-patches.json. A patch target that no longer exists fails the build.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, PluginOption } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));
export const UI_ROOT = path.resolve(here, '..');
export const WASM_PKG = path.join(UI_ROOT, 'src/wasm/pkg/warraq_core.js');
const VIRTUAL = 'virtual:warraq-core';
const MISSING = '\0warraq-core-missing';

export function zoodEngine(): Plugin {
  return {
    name: 'zood:engine',
    enforce: 'pre',
    resolveId(id) {
      if (id !== VIRTUAL) return null;
      if (fs.existsSync(WASM_PKG)) return WASM_PKG;
      if (process.env.ZOOD_ALLOW_MISSING_ENGINE === '1') {
        this.warn('warraq-core WASM package is missing: building WITHOUT the engine (ZOOD_ALLOW_MISSING_ENGINE=1).');
        return MISSING;
      }
      this.error(
        `The warraq-core WASM package is missing (${path.relative(process.cwd(), WASM_PKG)}).\n` +
          'Build it first: bash scripts/build-wasm.sh',
      );
    },
    load(id) {
      if (id !== MISSING) return null;
      return [
        "const missing = () => { throw { code: 'engine_missing', message: 'This build has no warraq-core engine' }; };",
        'export default async function init() { missing(); }',
        'export class WarraqDocument { static open() { missing(); } call() { missing(); } }',
        'export function callStatic() { missing(); }',
      ].join('\n');
    },
  };
}

export interface PatchEntry {
  context: string;
  en: string;
  ar: string;
}
export interface PatchFile {
  chunk: string;
  patches: PatchEntry[];
}

export const PATCH_FILE = path.join(UI_ROOT, 'src/viewer/embedpdf-patches.json');

export function loadPatches(file = PATCH_FILE): PatchFile {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as PatchFile;
}

/** Applies every patch; returns the new code and the list of patches that found no target. */
export function applyPatches(code: string, patches: PatchEntry[]): { code: string; missing: PatchEntry[] } {
  const missing: PatchEntry[] = [];
  let out = code;
  for (const p of patches) {
    const lit = JSON.stringify(p.en);
    const find = `${p.context}${lit}`;
    if (!out.includes(find)) {
      missing.push(p);
      continue;
    }
    const lookup = `(globalThis.__zoodEP?globalThis.__zoodEP(${lit}):${lit})`;
    out = out.split(find).join(`${p.context}${lookup}`);
  }
  return { code: out, missing };
}

export function zoodEmbedPdfPatches(file = PATCH_FILE): Plugin {
  const { chunk, patches } = loadPatches(file);
  return {
    name: 'zood:embedpdf-patches',
    enforce: 'pre',
    transform(code, id) {
      const norm = id.split(path.sep).join('/');
      if (!norm.includes(chunk) || !norm.endsWith('.js')) return null;
      const res = applyPatches(code, patches);
      if (res.missing.length) {
        this.error(
          `EmbedPDF string patches no longer match (${res.missing.map((m) => m.context + JSON.stringify(m.en)).join(', ')}).` +
            ' Update src/viewer/embedpdf-patches.json for the new EmbedPDF version.',
        );
      }
      return { code: res.code, map: null };
    },
  };
}

/** Directory of an installed package (works for packages without an `exports` entry for package.json). */
export function packageDir(name: string, from = UI_ROOT): string {
  let dir = path.join(from, 'node_modules', name);
  if (fs.existsSync(dir)) return fs.realpathSync(dir);
  dir = path.join(from, '..', '..', 'node_modules', name);
  if (fs.existsSync(dir)) return fs.realpathSync(dir);
  throw new Error(`Cannot find package ${name}`);
}

/** Local copies of EmbedPDF's assets (PDFium wasm, Arabic fallback font, stamps): no CDN. */
export function zoodAssetAliases(): Record<string, string> {
  return {
    '@zood-assets/fonts-arabic': path.join(packageDir('@embedpdf/fonts-arabic'), 'fonts'),
    '@zood-assets/stamps': packageDir('@embedpdf/default-stamps'),
    '@zood-assets/pdfium': path.join(packageDir('@embedpdf/snippet'), 'dist'),
  };
}

/** Everything a host needs: React, the engine resolver, EmbedPDF patches and local asset aliases. */
export function zoodUi(): PluginOption[] {
  return [
    react(),
    zoodEngine(),
    zoodEmbedPdfPatches(),
    {
      name: 'zood:config',
      config() {
        return {
          resolve: { alias: zoodAssetAliases() },
          // Pre-bundling would skip our transform (string patches) in dev.
          optimizeDeps: { exclude: ['@embedpdf/snippet', '@embedpdf/react-pdf-viewer'] },
          worker: { format: 'es' as const, plugins: () => [zoodEngine()] },
          build: { target: 'es2022', assetsInlineLimit: 0 },
        };
      },
    },
  ];
}
