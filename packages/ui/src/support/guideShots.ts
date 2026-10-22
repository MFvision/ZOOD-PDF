import type { Lang } from '../i18n/messages';

/**
 * The pictures in the guides, one per step that has one and language, taken
 * from the real app by `scripts/support/make-shots.mjs` into
 * `public/guides/shots/`. A step whose picture is missing shows its words alone.
 * A few steps also have a moving picture (`.webp`), shown unless the person
 * asked for less motion.
 */
const urls = import.meta.glob<string>('../../public/guides/shots/*.{jpg,webp}', { query: '?url', import: 'default', eager: true });

const byName = new Map(Object.entries(urls).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]));

export function shotUrl(pic: string | undefined, lang: Lang): string | null {
  return pic ? (byName.get(`${pic}-${lang}.jpg`) ?? null) : null;
}

export function motionUrl(pic: string | undefined, lang: Lang): string | null {
  return pic ? (byName.get(`${pic}-${lang}.webp`) ?? null) : null;
}
