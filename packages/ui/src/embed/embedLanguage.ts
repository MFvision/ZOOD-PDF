import type { I18nCapability, PluginRegistry } from '@embedpdf/react-pdf-viewer';
import type { Lang } from '../i18n/messages';
import { capability } from './embedControl';
import { arabic, arabicHardCoded } from './locales/ar';

/**
 * EmbedPDF's interface in Warraq's language.
 *
 * EmbedPDF ships ten locales and no Arabic. Passing `locales` in its config
 * would replace all ten — the snippet merges plugin config shallowly — and
 * leave Warraq keeping a frozen copy of its English. Instead Arabic is
 * registered next to them through the i18n capability, and English stays
 * EmbedPDF's own.
 */

/** EmbedPDF's locale code for each of Warraq's languages. */
export const EMBED_LOCALES: Record<Lang, string> = { ar: arabic.code, en: 'en' };

/**
 * The strings EmbedPDF writes into its code, for the language on screen:
 * its bundle is patched to look them up in this global as it draws
 * (`vite/embedPatches.ts`). Set before its i18n plugin switches, so what
 * redraws then reads the new language; English is EmbedPDF's own.
 */
export function setEmbedStrings(lang: Lang): void {
  const global = globalThis as { __warraqEmbedStrings?: Record<string, string>; __warraqEmbedLocale?: string };
  global.__warraqEmbedStrings = lang === 'ar' ? arabicHardCoded : undefined;
  // Dates in its comments sidebar: Arabic month names and digits.
  global.__warraqEmbedLocale = lang === 'ar' ? 'ar' : undefined;
}

/** Switches EmbedPDF to Warraq's language, adding Arabic the first time. */
export function setEmbedLanguage(registry: PluginRegistry, lang: Lang): void {
  setEmbedStrings(lang);
  const i18n = capability<I18nCapability>(registry, 'i18n');
  if (!i18n) return;
  if (!i18n.hasLocale(arabic.code)) i18n.registerLocale(arabic);
  i18n.setLocale(EMBED_LOCALES[lang]);
}
