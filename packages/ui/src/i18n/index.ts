/**
 * Tiny typed i18n: flat message catalogues, ICU-like `{x}` and `{n, plural, …}` syntax,
 * locale digits via Intl (Arabic → Arabic-Indic digits), text direction per locale.
 */
import en from './en.json';
import ar from './ar.json';

export type Locale = 'en' | 'ar';
export type MessageKey = keyof typeof en;
export type MessageArgs = Record<string, string | number>;

export const LOCALES: readonly Locale[] = ['en', 'ar'] as const;

const catalogues: Record<Locale, Record<MessageKey, string>> = { en, ar };

/** BCP-47 tags with an explicit numbering system so Arabic always uses Arabic-Indic digits. */
export function intlTag(locale: Locale): string {
  return locale === 'ar' ? 'ar-u-nu-arab' : 'en';
}

export function dirFor(locale: Locale): 'rtl' | 'ltr' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

export function detectLocale(languages: readonly string[]): Locale {
  for (const lang of languages) {
    const base = lang.toLowerCase().split('-')[0];
    if (base === 'ar') return 'ar';
    if (base === 'en') return 'en';
  }
  return 'en';
}

const numberFormats = new Map<Locale, Intl.NumberFormat>();
export function formatNumber(n: number, locale: Locale): string {
  let f = numberFormats.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(intlTag(locale));
    numberFormats.set(locale, f);
  }
  return f.format(n);
}

export function formatDate(d: Date | number, locale: Locale, opts?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(intlTag(locale), opts ?? { dateStyle: 'medium' }).format(d);
}

export function formatBytes(bytes: number, locale: Locale): string {
  const units = locale === 'ar' ? ['بايت', 'ك.ب', 'م.ب', 'غ.ب'] : ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const n = new Intl.NumberFormat(intlTag(locale), { maximumFractionDigits: i === 0 ? 0 : 1 }).format(v);
  return `${n} ${units[i]}`;
}

/** Finds the index of the brace that closes the one at `open`. Bounded by the string length. */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function formatPlural(body: string, value: number, locale: Locale, args: MessageArgs): string {
  const forms = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i] ?? '')) i++;
    const open = body.indexOf('{', i);
    if (open < 0) break;
    const selector = body.slice(i, open).trim();
    const close = matchBrace(body, open);
    if (close < 0) break;
    forms.set(selector, body.slice(open + 1, close));
    i = close + 1;
  }
  const category = new Intl.PluralRules(intlTag(locale)).select(value);
  const chosen = forms.get(`=${value}`) ?? forms.get(category) ?? forms.get('other') ?? '';
  // `#` inside the chosen branch is the formatted number.
  return formatMessage(chosen.replace(/#/g, formatNumber(value, locale)), locale, args);
}

export function formatMessage(message: string, locale: Locale, args: MessageArgs = {}): string {
  let out = '';
  let i = 0;
  while (i < message.length) {
    const open = message.indexOf('{', i);
    if (open < 0) {
      out += message.slice(i);
      break;
    }
    out += message.slice(i, open);
    const close = matchBrace(message, open);
    if (close < 0) {
      out += message.slice(open);
      break;
    }
    const inner = message.slice(open + 1, close);
    const parts = inner.split(',');
    const name = (parts[0] ?? '').trim();
    const value = args[name];
    if (parts.length >= 3 && (parts[1] ?? '').trim() === 'plural') {
      const body = parts.slice(2).join(',');
      out += typeof value === 'number' ? formatPlural(body, value, locale, args) : `{${inner}}`;
    } else if (value === undefined) {
      out += `{${inner}}`;
    } else {
      out += typeof value === 'number' ? formatNumber(value, locale) : value;
    }
    i = close + 1;
  }
  return out;
}

export type Translate = (key: MessageKey, args?: MessageArgs) => string;

export function createTranslator(locale: Locale): Translate {
  const catalogue = catalogues[locale];
  return (key, args) => formatMessage(catalogue[key] ?? catalogues.en[key] ?? key, locale, args);
}

export function isLocale(v: unknown): v is Locale {
  return v === 'en' || v === 'ar';
}
