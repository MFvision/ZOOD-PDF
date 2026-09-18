import { describe, expect, it } from 'vitest';
import type { PluginRegistry } from '@embedpdf/react-pdf-viewer';
import { setEmbedLanguage } from './embedLanguage';
import { arabic } from './locales/ar';

/** The i18n plugin as EmbedPDF 2.15.1 behaves: unknown locales are ignored. */
function fakeRegistry(withI18n = true) {
  const locales = new Map<string, unknown>([
    ['en', {}],
    ['de', {}],
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
  };
  const registry = {
    getPlugin: (id: string) => (withI18n && id === 'i18n' ? { provides: () => i18n } : null),
  } as unknown as PluginRegistry;
  return { registry, registered, locales, current: () => current };
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
});
