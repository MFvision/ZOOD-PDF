/**
 * Arabic for EmbedPDF: a full `ar` locale for its i18n plugin plus the runtime lookup used by the
 * build-time string patches (window.__zoodEP) for literals EmbedPDF does not route through i18n.
 */
import arTranslations from './embedpdf-ar.json';
import patchFile from './embedpdf-patches.json';
import type { Locale } from '../i18n';

export const embedPdfArabicLocale = { code: 'ar', name: 'العربية', translations: arTranslations };

const patched = new Map(patchFile.patches.map((p) => [p.en, p.ar]));
let current: Locale = 'en';

declare global {
  var __zoodEP: ((en: string) => string) | undefined;
}

export function setEmbedPdfLocale(locale: Locale): void {
  current = locale;
  globalThis.__zoodEP = (en: string) => (current === 'ar' ? (patched.get(en) ?? en) : en);
}
