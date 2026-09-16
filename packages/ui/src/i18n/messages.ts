import ar from './ar.json';
import en from './en.json';

export type Lang = 'ar' | 'en';
export type Direction = 'rtl' | 'ltr';
/** Every UI string key; derived from the English dictionary so typos fail type-checking. */
export type TKey = keyof typeof en;
export type TParams = Record<string, string | number>;

export const dictionaries: Record<Lang, Record<TKey, string>> = { ar, en };

export const LANGS: readonly Lang[] = ['ar', 'en'];

export function directionOf(lang: Lang): Direction {
  return lang === 'ar' ? 'rtl' : 'ltr';
}

/** Arabic is the default when the browser language starts with "ar"; otherwise English. */
export function detectLanguage(navigatorLanguage: string | undefined, stored: Lang | null): Lang {
  if (stored && LANGS.includes(stored)) return stored;
  return navigatorLanguage?.toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

/** Replaces `{name}` placeholders; unknown placeholders are left as written. */
export function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

export function translate(lang: Lang, key: TKey, params?: TParams): string {
  const value = dictionaries[lang][key] ?? dictionaries.en[key] ?? key;
  return interpolate(value, params);
}
