import { useEffect } from 'react';
import type { RemoteDocument } from '../core/client';
import type { DocumentInfo } from '../state/appReducer';
import { useAppState, useServices } from '../state/AppContext';
import { saveRecentThumbnail } from '../state/recent';

/** Width of the stored picture, in pixels: two per point of the grid's 120-pt tiles. */
const THUMB_WIDTH = 240;

/**
 * A small JPEG of the first page, drawn by Warraq's core as the page
 * thumbnails are; `null` when there is nothing to draw. The cloud drives'
 * recent files use it too (`cloud/`).
 */
export async function renderThumbnail(document: RemoteDocument, info: DocumentInfo): Promise<string | null> {
  const [width] = info.pageSizes[0] ?? [0, 0];
  if (!(width > 0)) return null;
  const page = await document.render_page(0, THUMB_WIDTH / width);
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
 * Keeps a small picture of the first page of each file opened, for the home
 * screen's recent grid. Never for a file that needed a password: its first
 * page is exactly what the password protects.
 */
export function useRecentThumbnail(): void {
  const { document: info } = useAppState();
  const { document, documentPassword } = useServices();

  useEffect(() => {
    if (!info || !document || documentPassword !== undefined || info.metadata.encrypted) return;
    let cancelled = false;
    void renderThumbnail(document, info)
      .then((picture) => {
        if (!cancelled && picture) saveRecentThumbnail(info.name, picture);
      })
      .catch(() => {
        /* no picture: the tile shows a plain page */
      });
    return () => {
      cancelled = true;
    };
    // Once per opened file, not on every page change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document]);
}
