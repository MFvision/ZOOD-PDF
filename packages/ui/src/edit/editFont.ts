/**
 * The faces an edit can be shaped with.
 *
 * A PDF embeds only a subset of its own fonts, so text that did not exist when
 * the file was made generally cannot reuse them: new characters have no glyphs
 * to borrow. These three ship with the app instead, each under SIL OFL 1.1
 * with its licence beside it in `public/fonts`.
 *
 * Amiri is a Naskh book face, so replaced Arabic keeps the shape of a book
 * rather than turning into a UI sans; Cairo is the sans when that is what the
 * page wants; Inter covers Latin. `packages/core` proves all three survive
 * shaping, subsetting and embedding — including the two variable ones — and
 * the panel may only offer what that test covers.
 *
 * `new URL(..., import.meta.url)` is the Vite asset form: the bytes come from
 * the app's own origin, which keeps the strict CSP and the "nothing leaves the
 * device without a click" rule intact.
 */

export type EditFontId = 'amiri' | 'cairo' | 'inter';

export interface EditFont {
  id: EditFontId;
  /** Shown in the panel; a font's name is not translated. */
  name: string;
  url: string;
}

export const EDIT_FONTS: readonly EditFont[] = [
  {
    id: 'amiri',
    name: 'Amiri',
    url: new URL('../../public/fonts/Amiri-Regular.ttf', import.meta.url).href,
  },
  {
    id: 'cairo',
    name: 'Cairo',
    url: new URL('../../public/fonts/Cairo-Variable.ttf', import.meta.url).href,
  },
  {
    id: 'inter',
    name: 'Inter',
    url: new URL('../../public/fonts/Inter-Variable.ttf', import.meta.url).href,
  },
];

export const DEFAULT_EDIT_FONT: EditFontId = 'amiri';

export function editFontName(id: EditFontId): string {
  return EDIT_FONTS.find((font) => font.id === id)?.name ?? 'Amiri';
}

const cache = new Map<EditFontId, Promise<Uint8Array>>();

/**
 * Loads a face once and reuses the bytes for every edit that asks for it.
 * A failed load is not kept, so a later edit can try again.
 */
export function loadEditFont(id: EditFontId = DEFAULT_EDIT_FONT): Promise<Uint8Array> {
  const existing = cache.get(id);
  if (existing) return existing;
  const font = EDIT_FONTS.find((f) => f.id === id) ?? EDIT_FONTS[0];
  if (!font) return Promise.reject(new Error('E_NOT_FOUND: no editing font'));
  const pending = fetch(font.url)
    .then((response) => {
      if (!response.ok) throw new Error(`E_NOT_FOUND: ${font.name} (${response.status})`);
      return response.arrayBuffer();
    })
    .then((buffer) => new Uint8Array(buffer))
    .catch((err: unknown) => {
      cache.delete(id);
      throw err;
    });
  cache.set(id, pending);
  return pending;
}
