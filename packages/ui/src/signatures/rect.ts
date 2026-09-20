/** A rectangle on a page as it is shown, in points from its top-left corner. */
export type ShownRect = [number, number, number, number];

/** The smallest box a drag makes, in points; anything less is a click. */
const MIN_W = 20;
const MIN_H = 12;

/** Where a signature goes until the person draws somewhere else: the page's bottom corner at the end of the reading direction. */
export function defaultRect(size: readonly [number, number], rtl: boolean): ShownRect {
  const [w, h] = size;
  const bw = Math.min(210, w * 0.45);
  const bh = Math.min(70, h * 0.12);
  const margin = Math.min(36, w * 0.06);
  const x0 = rtl ? margin : w - margin - bw;
  const y0 = h - margin - bh;
  return [x0, y0, x0 + bw, y0 + bh];
}

/**
 * The rectangle a drag from `from` to `to` (points) makes, or `null` when it
 * is too small to be one — a click, or a click with a pixel of jitter.
 */
export function dragRect(from: { x: number; y: number }, to: { x: number; y: number }): ShownRect | null {
  const rect: ShownRect = [Math.min(from.x, to.x), Math.min(from.y, to.y), Math.max(from.x, to.x), Math.max(from.y, to.y)];
  return rect[2] - rect[0] >= MIN_W && rect[3] - rect[1] >= MIN_H ? rect : null;
}
