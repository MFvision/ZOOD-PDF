import { describe, expect, it } from 'vitest';
import { arabic, arabicBeyondEnglish, arabicTranslations } from './ar';
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
