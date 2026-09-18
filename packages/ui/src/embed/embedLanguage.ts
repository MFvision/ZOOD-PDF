import type { I18nCapability, PluginRegistry } from '@embedpdf/react-pdf-viewer';
import type { Lang } from '../i18n/messages';
import { capability } from './embedControl';
import { arabic } from './locales/ar';

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

/** Switches EmbedPDF to Warraq's language, adding Arabic the first time. */
export function setEmbedLanguage(registry: PluginRegistry, lang: Lang): void {
  const i18n = capability<I18nCapability>(registry, 'i18n');
  if (!i18n) return;
  if (!i18n.hasLocale(arabic.code)) i18n.registerLocale(arabic);
  i18n.setLocale(EMBED_LOCALES[lang]);
}
