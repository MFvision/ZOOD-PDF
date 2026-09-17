/**
 * The face `replace_paragraph` shapes with when the page's own font cannot be
 * reused. Amiri is a Naskh design, so replaced Arabic keeps the shape of a book
 * face rather than turning into a UI sans; it is SIL OFL 1.1 and the licence
 * ships beside it in `public/fonts/Amiri-OFL.txt`.
 *
 * `new URL(..., import.meta.url)` is the Vite asset form: the bytes are fetched
 * from the app's own origin, which keeps the strict CSP and the "no network
 * without a user action" rule intact.
 */
const AMIRI_URL = new URL('../../public/fonts/Amiri-Regular.ttf', import.meta.url).href;

export const EDIT_FONT_NAME = 'Amiri';

let cached: Promise<Uint8Array> | null = null;

/**
 * Loads the editing font once per page and reuses the bytes for every edit.
 * A failed load is not cached, so a later edit can try again.
 */
export function loadEditFont(): Promise<Uint8Array> {
  cached ??= fetch(AMIRI_URL)
    .then((response) => {
      if (!response.ok) throw new Error(`E_NOT_FOUND: editing font (${response.status})`);
      return response.arrayBuffer();
    })
    .then((buffer) => new Uint8Array(buffer))
    .catch((err: unknown) => {
      cached = null;
      throw err;
    });
  return cached;
}
