import type { Lang } from '../i18n/messages';

/**
 * The PDF guides, one per article and language, made from the articles by
 * `scripts/support/make-guides.mjs` into `public/guides/`. Vite gives each
 * its address; an article without a guide yet simply has no button.
 */
const urls = import.meta.glob<string>('../../public/guides/*.pdf', { query: '?url', import: 'default', eager: true });

const byName = new Map(Object.entries(urls).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]));

export function guidePdfUrl(id: string, lang: Lang): string | null {
  return byName.get(`${id}-${lang}.pdf`) ?? null;
}
