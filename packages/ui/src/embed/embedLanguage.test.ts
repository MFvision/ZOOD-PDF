import { describe, expect, it } from 'vitest';
import type { PluginRegistry } from '@embedpdf/react-pdf-viewer';
import { ENGLISH_MISSING, fillIn, setEmbedLanguage } from './embedLanguage';
import { arabic, arabicBeyondEnglish } from './locales/ar';
import { englishTranslations } from './locales/en';

/** The i18n plugin as EmbedPDF 2.15.1 behaves: unknown locales are ignored. */
function fakeRegistry(withI18n = true) {
  const english = { code: 'en', name: 'English', translations: { form: { textfield: 'Text Field' } } as Record<string, unknown> };
  const locales = new Map<string, unknown>([
    ['en', english],
    ['de', { code: 'de', name: 'Deutsch', translations: {} }],
  ]);
  let current = 'en';
  const registered: string[] = [];
  const i18n = {
    hasLocale: (code: string) => locales.has(code),
    registerLocale: (locale: { code: string }) => {
      registered.push(locale.code);
      locales.set(locale.code, locale);
    },
    setLocale: (code: string) => {
      if (locales.has(code)) current = code;
    },
    getLocaleInfo: (code: string) => locales.get(code) ?? null,
  };
  const registry = {
    getPlugin: (id: string) => (withI18n && id === 'i18n' ? { provides: () => i18n } : null),
  } as unknown as PluginRegistry;
  return { registry, registered, locales, english, current: () => current };
}

describe("EmbedPDF's language follows Warraq's", () => {
  it('adds Arabic beside the built-in locales and switches to it', () => {
    const fake = fakeRegistry();
    setEmbedLanguage(fake.registry, 'ar');
    expect(fake.current()).toBe('ar');
    expect(fake.locales.get('ar')).toBe(arabic);
    expect([...fake.locales.keys()]).toEqual(['en', 'de', 'ar']);
  });

  it('switches back to its own English, registering Arabic only once', () => {
    const fake = fakeRegistry();
    setEmbedLanguage(fake.registry, 'ar');
    setEmbedLanguage(fake.registry, 'en');
    expect(fake.current()).toBe('en');
    setEmbedLanguage(fake.registry, 'ar');
    expect(fake.current()).toBe('ar');
    expect(fake.registered).toEqual(['ar']);
  });

  it('does nothing when the viewer has no i18n plugin', () => {
    const fake = fakeRegistry(false);
    expect(() => setEmbedLanguage(fake.registry, 'ar')).not.toThrow();
    expect(fake.current()).toBe('en');
  });

  it("gives EmbedPDF's English the strings it lacks, and changes none it has", () => {
    const fake = fakeRegistry();
    setEmbedLanguage(fake.registry, 'en');
    expect(fake.english.translations).toEqual({ form: { textfield: 'Text Field', toggleFillMode: 'Fill Form Fields' } });
    // Twice is the same as once.
    setEmbedLanguage(fake.registry, 'ar');
    setEmbedLanguage(fake.registry, 'en');
    expect(fake.english.translations).toEqual({ form: { textfield: 'Text Field', toggleFillMode: 'Fill Form Fields' } });
  });
});

describe('the English EmbedPDF lacks', () => {
  type Tree = { [key: string]: string | Tree };
  const leaves = (tree: Tree, prefix = ''): string[] =>
    Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [`${prefix}${key}`] : leaves(value, `${prefix}${key}.`)));

  it('is only what its English locale does not have, and all of it Arabic has', () => {
    const english = new Set(leaves(englishTranslations as Tree));
    const beyond = new Set(leaves(arabicBeyondEnglish as Tree));
    for (const key of leaves(ENGLISH_MISSING as Tree)) {
      expect(english.has(key), key).toBe(false);
      expect(beyond.has(key), key).toBe(true);
    }
  });

  it('is filled in without overwriting anything', () => {
    const into: Tree = { a: 'kept', b: { c: 'kept' } };
    fillIn(into, { a: 'new', b: { c: 'new', d: 'added' }, e: { f: 'added' } });
    expect(into).toEqual({ a: 'kept', b: { c: 'kept', d: 'added' }, e: { f: 'added' } });
  });
});
