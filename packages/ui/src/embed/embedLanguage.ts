import type { I18nCapability, Locale, PluginRegistry } from '@embedpdf/react-pdf-viewer';
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

type Tree = Locale['translations'];

/**
 * Keys EmbedPDF 2.15.1's interface asks for that neither its English locale
 * nor its code has any English for, so it showed the key itself: the Form
 * toolbar's fill button was named "form.toggleFillMode". Added to its
 * English locale where it has nothing (`addMissingEnglish`); in EmbedPDF's
 * own words and style. The Arabic has them all (`arabicBeyondEnglish`), and
 * `e2e/embed-latin.spec.ts` fails if a key is shown as it is again.
 */
export const ENGLISH_MISSING: Tree = {
  form: { toggleFillMode: 'Fill Form Fields' },
};

/** Copies into `into` whatever of `from` it does not have; nothing it has is changed. */
export function fillIn(into: Tree, from: Tree): void {
  for (const [key, value] of Object.entries(from)) {
    const current = into[key];
    if (typeof value === 'string') {
      if (current === undefined) into[key] = value;
    } else if (current === undefined) {
      into[key] = structuredClone(value);
    } else if (typeof current === 'object') {
      fillIn(current, value);
    }
  }
}

/**
 * EmbedPDF's English, with the strings it lacks. The locale can be neither
 * replaced nor registered twice, so what it lacks is added to it where it
 * is — the translation it reads each time it draws.
 */
function addMissingEnglish(i18n: I18nCapability): void {
  const english = i18n.getLocaleInfo('en');
  if (english) fillIn(english.translations, ENGLISH_MISSING);
}

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

/** Switches EmbedPDF to Warraq's language, adding Arabic — and English it lacks — the first time. */
export function setEmbedLanguage(registry: PluginRegistry, lang: Lang): void {
  setEmbedStrings(lang);
  const i18n = capability<I18nCapability>(registry, 'i18n');
  if (!i18n) return;
  if (!i18n.hasLocale(arabic.code)) i18n.registerLocale(arabic);
  addMissingEnglish(i18n);
  i18n.setLocale(EMBED_LOCALES[lang]);
}
