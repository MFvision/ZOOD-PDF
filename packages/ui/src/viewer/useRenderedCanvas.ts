import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { RemoteDocument } from '../core/client';
import type { RenderedPageData } from '../core/types';

/** Short debounce so continuous zooming does not flood the worker. */
const RENDER_DEBOUNCE_MS = 80;

/** The most pixels the core draws a page with (`warraq_render::MAX_PIXELS`); past it, it refuses. */
export const MAX_RENDER_PIXELS = 64_000_000;

/**
 * `scale`, or less for a page that would take more than the core's budget at
 * it: a large page at a high zoom is drawn a little softer instead of refused
 * (the canvas is sized by the page, not by its bitmap).
 */
export function withinPixelBudget(scale: number, size: readonly [number, number]): number {
  const area = size[0] * size[1];
  if (!(area > 0)) return scale;
  // A hair under the budget, so rounding in the core never tips it over.
  return Math.min(scale, Math.sqrt(MAX_RENDER_PIXELS / area) * 0.999);
}

export function drawRgba(canvas: HTMLCanvasElement, page: RenderedPageData): void {
  canvas.width = page.width;
  canvas.height = page.height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.putImageData(new ImageData(page.rgba, page.width, page.height), 0, 0);
}

/**
 * Renders `document` page `index` at `scale` into the canvas while `active`.
 * With `releaseWhenInactive` the bitmap is dropped when the page leaves the
 * neighbourhood of the viewport so memory stays bounded on long documents.
 *
 * `revision` is the page's edit counter: bumping it re-renders the same page at
 * the same scale, which is how a committed edit reaches the canvas.
 */
export function useRenderedCanvas(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  document: RemoteDocument,
  index: number,
  scale: number,
  active: boolean,
  releaseWhenInactive: boolean,
  revision = 0,
): void {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!active) {
      if (releaseWhenInactive) {
        canvas.width = 0;
        canvas.height = 0;
      }
      return;
    }
    let cancelled = false;
    const size = document.pageSizes[index];
    const drawAt = size ? withinPixelBudget(scale, size) : scale;
    const timer = setTimeout(() => {
      document
        .render_page(index, drawAt)
        .then((page) => {
          if (!cancelled) drawRgba(canvas, page);
        })
        .catch(() => {
          /* a failed render leaves the page blank; the error surfaces in the worker log */
        });
    }, RENDER_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [canvasRef, document, index, scale, active, releaseWhenInactive, revision]);
}
