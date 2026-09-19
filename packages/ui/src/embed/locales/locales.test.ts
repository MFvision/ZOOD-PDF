import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMBED_PATCHES, HARD_CODED_STRINGS, isEmbedBundle, patchEmbed } from '../../../vite/embedPatches';
import { arabic, arabicBeyondEnglish, arabicHardCoded, arabicTranslations } from './ar';
import { englishTranslations } from './en';

type Tree = { [key: string]: string | Tree };

/** "zoom.level" → "Zoom Level ({level}%)", for every leaf of the tree. */
function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [leaf, text] of flatten(value, path)) out.set(leaf, text);
  }
  return out;
}

const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

const english = flatten(englishTranslations);
const translation = flatten(arabicTranslations);
const beyond = flatten(arabicBeyondEnglish);
const registered = flatten(arabic.translations as Tree);

describe("EmbedPDF's Arabic locale", () => {
  it('has exactly the keys of its English locale', () => {
    const missing = [...english.keys()].filter((key) => !translation.has(key));
    const extra = [...translation.keys()].filter((key) => !english.has(key));
    expect(missing, 'English keys with no Arabic').toEqual([]);
    expect(extra, 'Arabic keys English does not have').toEqual([]);
    expect(translation.size).toBe(english.size);
  });

  it('keeps every placeholder of the English string, and adds none', () => {
    for (const [key, text] of english) {
      expect(placeholders(translation.get(key) ?? ''), key).toEqual(placeholders(text));
    }
  });

  it('adds only strings the English lacks, never a second word for one it has', () => {
    for (const key of beyond.keys()) expect(english.has(key), key).toBe(false);
    expect(beyond.size).toBe(23);
  });

  it('registers the translation and those strings together, unchanged', () => {
    expect(registered.size).toBe(translation.size + beyond.size);
    for (const [key, text] of [...translation, ...beyond])
      expect(registered.get(key), key).toBe(text);
  });

  it('leaves no string empty or still in English', () => {
    for (const [key, text] of registered) {
      expect(text.trim(), key).not.toBe('');
      expect(text, key).toMatch(/\p{Script=Arabic}/u);
    }
  });

  it('is registered under the code Warraq switches to', () => {
    expect(arabic.code).toBe('ar');
    expect(arabic.name).toBe('العربية');
  });
});

/** EmbedPDF's viewer bundle as installed: `@embedpdf/snippet`, a dependency of its React wrapper. */
function installedBundle(): { path: string; code: string } {
  const require = createRequire(import.meta.url);
  const wrapper = createRequire(require.resolve('@embedpdf/react-pdf-viewer'));
  const dist = dirname(wrapper.resolve('@embedpdf/snippet'));
  const name = readdirSync(dist).find((file) => isEmbedBundle(join(dist, file)));
  if (!name) throw new Error(`no viewer bundle in ${dist}`);
  const path = join(dist, name);
  return { path, code: readFileSync(path, 'utf8') };
}

describe("EmbedPDF's strings written into its code", () => {
  it('have Arabic, every one the patches look up, and nothing else', () => {
    expect(Object.keys(arabicHardCoded).sort()).toEqual([...HARD_CODED_STRINGS].sort());
    for (const [english, text] of Object.entries(arabicHardCoded)) {
      expect(text, english).toMatch(/\p{Script=Arabic}/u);
      expect(text, english).not.toMatch(/[A-Za-z]/);
      // A string that ends in a space goes before a number: so does its Arabic.
      expect(text.endsWith(' '), english).toBe(english.endsWith(' '));
    }
  });

  it('are all found in the installed EmbedPDF, as often as each patch says', () => {
    const { path, code } = installedBundle();
    expect(isEmbedBundle(path)).toBe(true);
    const patched = patchEmbed(code);
    for (const patch of EMBED_PATCHES) {
      expect(patched.includes(patch.find), patch.find).toBe(false);
      expect(patched.split(patch.replace).length - 1, patch.replace).toBe(patch.count ?? 1);
    }
  });

  it('fail the build when a patch no longer matches', () => {
    expect(() => patchEmbed('nothing to patch here')).toThrow(/EmbedPDF patch/);
  });
});
