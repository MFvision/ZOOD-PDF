import { PT_TO_CSS_PX } from '../state/zoom';

/**
 * Paragraph boxes arrive in device space: points at scale 1, y growing down
 * from the top-left of the page after /Rotate — the same space as `text_lines`.
 * The overlay sits inside `.page`, whose size is `page_size * pageScale(zoom)`,
 * so one multiplication maps a box onto it.
 *
 * The result is expressed in logical properties. The overlay container forces
 * `direction: ltr` (like the text layer), so `inlineStart` is the physical left
 * edge of the page whatever the UI language is: page geometry is a property of
 * the document, not of the reading direction of the interface around it.
 */

export interface ParagraphBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayRect {
  inlineStart: number;
  blockStart: number;
  inlineSize: number;
  blockSize: number;
}

/** CSS px per PDF point at `zoom` (100 % is 1 pt = 96/72 px). */
export function pageScale(zoom: number): number {
  return PT_TO_CSS_PX * zoom;
}

/** Maps a paragraph box to the overlay rectangle, in CSS px. */
export function paragraphRect(box: ParagraphBox, scale: number): OverlayRect {
  return {
    inlineStart: box.x * scale,
    blockStart: box.y * scale,
    inlineSize: box.width * scale,
    blockSize: box.height * scale,
  };
}

/**
 * True when a point in overlay CSS px is inside the box. Used to find the
 * paragraph under the pointer without an element per paragraph in the hit path.
 */
export function rectContains(rect: OverlayRect, x: number, y: number): boolean {
  return (
    x >= rect.inlineStart &&
    x <= rect.inlineStart + rect.inlineSize &&
    y >= rect.blockStart &&
    y <= rect.blockStart + rect.blockSize
  );
}
