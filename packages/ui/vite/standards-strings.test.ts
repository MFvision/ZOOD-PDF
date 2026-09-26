/**
 * Every message the Rust engine (warraq-standards) can emit — finding variants, rule titles and
 * conversion actions — has English and Arabic text. Scans the Rust sources, so a new finding without
 * strings fails here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import en from '../src/i18n/en.json';
import ar from '../src/i18n/ar.json';

const here = path.dirname(fileURLToPath(import.meta.url));
const standardsSrc = path.resolve(here, '../../core/crates/warraq-standards/src');

describe('standards strings', () => {
  const rs = (file: string) => fs.readFileSync(path.join(standardsSrc, file), 'utf8');

  it('has en + ar text for every finding the engine can report', () => {
    const src = fs.readdirSync(standardsSrc).filter((x: string) => x.endsWith('.rs')).map(rs).join('\n');
    const re = /F::new\(\s*"([a-z0-9-]+)",\s*(?:if [^{]+\{\s*"([a-z0-9-]+)"\s*\}\s*else\s*\{\s*"([a-z0-9-]+)"\s*\}|"([a-z0-9-]+)")/g;
    const keys = new Set<string>();
    for (const m of src.matchAll(re)) for (const v of [m[2], m[3], m[4]]) if (v) keys.add(`standards.finding.${m[1]}.${v}`);
    expect(keys.size).toBeGreaterThan(100);
    for (const k of keys) {
      expect(en, k).toHaveProperty([k]);
      expect(ar, k).toHaveProperty([k]);
    }
  });

  it('has a title for every rule and a label for every conversion action', () => {
    const ids = [...rs('rules.rs').matchAll(/r\("([a-z0-9-]+)",/g)].map((m) => m[1]!);
    expect(ids).toHaveLength(56);
    for (const id of ids) expect(en, id).toHaveProperty([`standards.rule.${id}`]);
    const actions = new Set([...rs('convert.rs').matchAll(/(?:c\.did|log\.push\(\()\s*\(?"([a-z0-9-]+)"/g)].map((m) => m[1]!));
    for (const m of rs('convert.rs').matchAll(/\{\s*"([a-z0-9-]+)"\s*\}\s*else\s*\{\s*"([a-z0-9-]+)"\s*\}/g)) {
      if (m[1]!.startsWith('remove') || m[2]!.startsWith('remove')) {
        actions.add(m[1]!);
        actions.add(m[2]!);
      }
    }
    expect(actions.size).toBeGreaterThan(25);
    for (const a of actions) {
      expect(en, a).toHaveProperty([`standards.action.${a}`]);
      expect(ar, a).toHaveProperty([`standards.action.${a}`]);
    }
  });
});

describe('bundled fonts', () => {
  it('ship with their OFL licence in every build', async () => {
    const { BUNDLED_ASSETS, ALLOWED, zoodLicenses } = await import('./licenses.ts');
    const lib = BUNDLED_ASSETS.find((a) => a.name === 'Liberation Fonts')!;
    expect(lib.license).toMatch(ALLOWED);
    const emitted: string[] = [];
    const plugin = zoodLicenses() as unknown as { generateBundle: (this: { emitFile(f: { fileName: string; source: string }): void }) => void };
    plugin.generateBundle.call({ emitFile: (f) => void emitted.push(f.fileName) });
    expect(emitted).toContain('licenses/liberation-fonts-OFL.txt');
    const text = fs.readFileSync(path.resolve(here, '..', lib.file), 'utf8');
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1');
    const fonts = fs.readdirSync(path.resolve(here, '../assets/fonts/liberation')).filter((f) => f.endsWith('.ttf'));
    expect(fonts).toHaveLength(12);
  });
});
