// @vitest-environment node
/**
 * Upgrade guards for EmbedPDF: every string patch still has a target in the shipped dist chunk, and the
 * Arabic locale covers every key of EmbedPDF's own English locale. An EmbedPDF upgrade that moves
 * things fails here (and the build fails in the Vite plugin).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { applyPatches, loadPatches, packageDir } from './index.ts';
import ar from '../src/viewer/embedpdf-ar.json';

const distDir = path.join(packageDir('@embedpdf/snippet'), 'dist');
const chunkName = fs.readdirSync(distDir).find((f) => /^embedpdf-[\w-]+\.js$/.test(f));
const chunk = fs.readFileSync(path.join(distDir, chunkName!), 'utf8');

type Dict = { [k: string]: string | Dict };

function extractEnglishLocale(src: string): Dict {
  // The snippet's own locale list is the last English locale in the chunk (an earlier one is a plugin default).
  const at = src.lastIndexOf('{code:"en",name:"English",translations:');
  expect(at).toBeGreaterThan(-1);
  let depth = 0;
  let inStr: string | null = null;
  let i = at;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) break;
  }
  // Evaluated in an empty sandbox: the literal contains only strings and objects.
  return (vm.runInNewContext(`(${src.slice(at, i + 1)})`, {}) as { translations: Dict }).translations;
}

function leafKeys(d: Dict, prefix = ''): string[] {
  return Object.entries(d).flatMap(([k, v]) => (typeof v === 'string' ? [prefix + k] : leafKeys(v, `${prefix}${k}.`)));
}

function get(d: Dict, key: string): string | Dict | undefined {
  return key.split('.').reduce<string | Dict | undefined>((o, p) => (typeof o === 'object' ? o[p] : undefined), d);
}

describe('EmbedPDF string patches', () => {
  const { patches, chunk: chunkPrefix } = loadPatches();

  it('targets the chunk that ships in this version', () => {
    expect(`@embedpdf/snippet/dist/${chunkName}`.startsWith(chunkPrefix)).toBe(true);
  });

  it('every patch target still exists', () => {
    const { missing } = applyPatches(chunk, patches);
    expect(missing).toEqual([]);
  });

  it('every patch has a non-empty Arabic translation', () => {
    for (const p of patches) expect(p.ar.trim(), p.en).not.toBe('');
  });

  it('rewrites literals into runtime lookups that fall back to English', () => {
    const { code } = applyPatches('x={title:"Bold"}', [{ context: 'title:', en: 'Bold', ar: 'غامق' }]);
    expect(code).toBe('x={title:(globalThis.__zoodEP?globalThis.__zoodEP("Bold"):"Bold")}');
    const ctx: Record<string, unknown> = {};
    new vm.Script(code.replace('x=', 'result=')).runInNewContext(ctx);
    expect(ctx.result).toEqual({ title: 'Bold' });
  });
});

describe('EmbedPDF Arabic locale', () => {
  const en = extractEnglishLocale(chunk);

  it('translates every key of the built-in English locale', () => {
    const missing = leafKeys(en).filter((k) => typeof get(ar as Dict, k) !== 'string');
    expect(missing).toEqual([]);
  });

  it('keeps every {placeholder}', () => {
    for (const k of leafKeys(en)) {
      const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(names(get(ar as Dict, k) as string), k).toEqual(names(get(en, k) as string));
    }
  });

  it('has no empty strings', () => {
    for (const k of leafKeys(ar as Dict)) expect((get(ar as Dict, k) as string).trim(), k).not.toBe('');
  });
});
