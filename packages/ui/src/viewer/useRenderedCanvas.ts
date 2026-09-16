import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { RemoteDocument } from '../core/client';
import type { RenderedPageData } from '../core/types';

/** Short debounce so continuous zooming does not flood the worker. */
const RENDER_DEBOUNCE_MS = 80;

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
 */
export function useRenderedCanvas(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  document: RemoteDocument,
  index: number,
  scale: number,
  active: boolean,
  releaseWhenInactive: boolean,
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
    const timer = setTimeout(() => {
      document
        .render_page(index, scale)
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
  }, [canvasRef, document, index, scale, active, releaseWhenInactive]);
}
