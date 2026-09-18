/**
 * Where two renders of a page look different: what Compare's text reading
 * cannot see — a drawing, a stamp, a picture, a moved block.
 *
 * Both renders are compared on a grid of small cells; a cell changes when
 * enough of its pixels differ by more than anti-aliasing does, and cells
 * that touch are merged into boxes. Boxes are fractions of the page, so they
 * can be drawn over a render of any size.
 */

/** A render: RGBA, row by row. */
export interface Raster {
  width: number;
  height: number;
  rgba: Uint8ClampedArray | Uint8Array;
}

/** A box on the page, in fractions of its width and height from its top-left corner. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Cell side, in pixels of the render. */
const CELL = 8;
/** A pixel differs when its luminance moves more than this (of 255): past anti-aliasing. */
const PIXEL = 48;
/** A cell changes when this share of its pixels differ. */
const SHARE = 0.03;
/** Pages whose proportions differ by more than this are different pages. */
const SHAPE = 0.01;

const luminance = (rgba: Raster['rgba'], at: number) =>
  0.2126 * rgba[at]! + 0.7152 * rgba[at + 1]! + 0.0722 * rgba[at + 2]!;

/**
 * The boxes where `after` looks different from `before`. Renders of pages of
 * another shape are one change, the whole page; of the same shape and a
 * different size, compared on the smaller.
 */
export function visualChanges(before: Raster, after: Raster): Box[] {
  const shapeBefore = before.width / Math.max(1, before.height);
  const shapeAfter = after.width / Math.max(1, after.height);
  if (Math.abs(shapeBefore - shapeAfter) > SHAPE * shapeBefore) return [{ x: 0, y: 0, w: 1, h: 1 }];
  const width = Math.min(before.width, after.width);
  const height = Math.min(before.height, after.height);
  const columns = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const changed = new Uint8Array(columns * rows);
  // Each render sampled at the same place of the page, whatever its size.
  const pixel = (raster: Raster, x: number, y: number) => {
    const sx = Math.min(raster.width - 1, Math.floor((x * raster.width) / width));
    const sy = Math.min(raster.height - 1, Math.floor((y * raster.height) / height));
    return luminance(raster.rgba, (sy * raster.width + sx) * 4);
  };
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      let differing = 0;
      let total = 0;
      for (let y = row * CELL; y < Math.min(height, (row + 1) * CELL); y += 1) {
        for (let x = column * CELL; x < Math.min(width, (column + 1) * CELL); x += 1) {
          total += 1;
          if (Math.abs(pixel(before, x, y) - pixel(after, x, y)) > PIXEL) differing += 1;
        }
      }
      if (differing > 0 && differing >= SHARE * total) changed[row * columns + column] = 1;
    }
  }
  return merge(changed, columns, rows).map(([c0, r0, c1, r1]) => ({
    x: (c0 * CELL) / width,
    y: (r0 * CELL) / height,
    w: (Math.min(width, (c1 + 1) * CELL) - c0 * CELL) / width,
    h: (Math.min(height, (r1 + 1) * CELL) - r0 * CELL) / height,
  }));
}

/**
 * Changed cells gathered into the boxes around them: cells within one cell
 * of each other are one change, so a line of text reads as one box, not
 * as one per letter. Largest first.
 */
function merge(
  changed: Uint8Array,
  columns: number,
  rows: number,
): [number, number, number, number][] {
  const seen = new Uint8Array(changed.length);
  const boxes: [number, number, number, number][] = [];
  for (let start = 0; start < changed.length; start += 1) {
    if (!changed[start] || seen[start]) continue;
    let [c0, r0, c1, r1] = [
      start % columns,
      Math.floor(start / columns),
      start % columns,
      Math.floor(start / columns),
    ];
    const queue = [start];
    seen[start] = 1;
    while (queue.length > 0) {
      const at = queue.pop()!;
      const column = at % columns;
      const row = Math.floor(at / columns);
      c0 = Math.min(c0, column);
      c1 = Math.max(c1, column);
      r0 = Math.min(r0, row);
      r1 = Math.max(r1, row);
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const x = column + dx;
          const y = row + dy;
          if (x < 0 || y < 0 || x >= columns || y >= rows) continue;
          const next = y * columns + x;
          if (changed[next] && !seen[next]) {
            seen[next] = 1;
            queue.push(next);
          }
        }
      }
    }
    boxes.push([c0, r0, c1, r1]);
  }
  return boxes.sort(
    (a, b) => (b[2] - b[0] + 1) * (b[3] - b[1] + 1) - (a[2] - a[0] + 1) * (a[3] - a[1] + 1),
  );
}
