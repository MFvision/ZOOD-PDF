import { describe, expect, it } from 'vitest';
import { arabic } from './ar';
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
const arabicStrings = flatten(arabic.translations as Tree);

describe("EmbedPDF's Arabic locale", () => {
  it('has exactly the keys of its English locale', () => {
    const missing = [...english.keys()].filter((key) => !arabicStrings.has(key));
    const extra = [...arabicStrings.keys()].filter((key) => !english.has(key));
    expect(missing, 'English keys with no Arabic').toEqual([]);
    expect(extra, 'Arabic keys English does not have').toEqual([]);
    expect(arabicStrings.size).toBe(english.size);
  });

  it('keeps every placeholder of the English string, and adds none', () => {
    for (const [key, text] of english) {
      expect(placeholders(arabicStrings.get(key) ?? ''), key).toEqual(placeholders(text));
    }
  });

  it('leaves no string empty or still in English', () => {
    for (const [key, text] of arabicStrings) {
      expect(text.trim(), key).not.toBe('');
      expect(text, key).toMatch(/[؀-ۿ]/);
    }
  });

  it('is registered under the code Warraq switches to', () => {
    expect(arabic.code).toBe('ar');
    expect(arabic.name).toBe('العربية');
  });
});
