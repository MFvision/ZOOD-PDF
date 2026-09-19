import type { RemoteDocument } from '../core/client';
import { forgetRecentThumbnail, saveRecentThumbnail } from '../state/recent';

/**
 * The home screen's recent grid shows a small picture of each file's first
 * page. It is kept on this device only (`state/recent.ts`), and it must never
 * show what the person has hidden or removed:
 *
 * - it is taken when a file opens, never for one that needed a password or is
 *   encrypted, and opening such a file forgets one kept under its name;
 * - it is forgotten the moment anything is marked for redaction, and none is
 *   taken again while that file stays open;
 * - it is forgotten when the file is saved, since the saved file may no longer
 *   look like it (a page deleted, a password set, a redaction applied); the
 *   next time the file opens, a new one is taken.
 */

/** The largest picture kept, in pixels: two per point of the grid's 120 × 160-pt pages. */
export const THUMB_BOX = { width: 240, height: 320 };

/** The core never draws below this scale (`render_page` clamps to it). */
const CORE_MIN_SCALE = 0.05;

/**
 * The scale page 1 is drawn at to fit `THUMB_BOX`, or null for a page the core
 * would draw larger than that even at its smallest scale. The page's size is
 * read from the file, and a hostile one claims a page of a million points.
 */
export function thumbnailScale(width: number, height: number): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const scale = Math.min(THUMB_BOX.width / width, THUMB_BOX.height / height);
  return scale >= CORE_MIN_SCALE ? scale : null;
}

/** Page 1 of `doc`, drawn by Warraq's core as a small JPEG data URL; null if it cannot be. */
async function firstPagePicture(doc: RemoteDocument): Promise<string | null> {
  const [width, height] = doc.pageSizes[0] ?? [0, 0];
  const scale = thumbnailScale(width, height);
  if (scale === null) return null;
  const page = await doc.render_page(0, scale);
  if (page.width === 0 || page.height === 0) return null;
  const make = () => {
    const canvas = globalThis.document.createElement('canvas');
    canvas.width = page.width;
    canvas.height = page.height;
    return canvas;
  };
  // The page may leave its paper transparent; a JPEG would make that black.
  const drawn = make();
  const paper = make();
  const drawnContext = drawn.getContext('2d');
  const paperContext = paper.getContext('2d');
  if (!drawnContext || !paperContext) return null;
  drawnContext.putImageData(new ImageData(page.rgba, page.width, page.height), 0, 0);
  paperContext.fillStyle = '#fff';
  paperContext.fillRect(0, 0, page.width, page.height);
  paperContext.drawImage(drawn, 0, 0);
  return paper.toDataURL('image/jpeg', 0.72);
}

/**
 * A file has just opened: keeps a picture of its first page, unless it needed
 * a password or is encrypted — then the picture kept under its name, of what
 * may be an earlier, unprotected copy, is forgotten. `still` is asked again
 * once the page is drawn: nothing is kept if, meanwhile, something was marked
 * for redaction.
 */
export async function keepFirstPage(
  name: string,
  doc: RemoteDocument,
  password: string | undefined,
  still: () => boolean,
): Promise<void> {
  if (password !== undefined || doc.info.encrypted) {
    forgetRecentThumbnail(name);
    return;
  }
  const picture = await firstPagePicture(doc).catch(() => null);
  if (picture && still()) saveRecentThumbnail(name, picture);
}
