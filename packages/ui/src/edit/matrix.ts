/**
 * Edit PDF's geometry: where a picture lands, as the core reports it — the
 * matrix that takes its unit square onto the page as shown, in points from
 * the top-left corner, y down (`images.list`) — and what a drag does to it.
 *
 * Matrices are PDF's `[a b c d e f]`, applied to a row vector: a point
 * (x, y) lands at (a·x + c·y + e, b·x + d·y + f). `compose(m, n)` is m first,
 * then n. Handles work in the picture's own unit square, so a turned or
 * slanted picture resizes along its own sides, as in a drawing program.
 */
export type Matrix = [number, number, number, number, number, number];
export type Point = { x: number; y: number };
/** The part of the unit square that shows: `[u0, v0, u1, v1]`. */
export type Clip = [number, number, number, number];
export type Rect = { x: number; y: number; width: number; height: number };

export const FULL: Clip = [0, 0, 1, 1];

export function apply(m: Matrix, x: number, y: number): Point {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function compose(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-9) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/** The corners of the part that shows, on the page. */
export function corners(m: Matrix, clip: Clip = FULL): Point[] {
  const [u0, v0, u1, v1] = clip;
  return [apply(m, u0, v0), apply(m, u1, v0), apply(m, u1, v1), apply(m, u0, v1)];
}

export function bounds(points: readonly Point[]): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function translate(m: Matrix, dx: number, dy: number): Matrix {
  return [m[0], m[1], m[2], m[3], m[4] + dx, m[5] + dy];
}

/** A picture upright in `rect`: its bottom row at the bottom, as PDF draws it. */
export function uprightIn(rect: Rect): Matrix {
  return [rect.width, 0, 0, -rect.height, rect.x, rect.y + rect.height];
}

/** The largest rectangle of `aspect` (width / height) inside `rect`, centred. */
export function fitAspect(rect: Rect, aspect: number): Rect {
  if (!(aspect > 0)) return rect;
  const width = Math.min(rect.width, rect.height * aspect);
  const height = width / aspect;
  return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height };
}

/** Turned a quarter clockwise, as it looks on screen, about the centre of the part that shows. */
export function quarterTurn(m: Matrix, clip: Clip = FULL): Matrix {
  const box = bounds(corners(m, clip));
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // y grows down, so (x, y) → (−y, x) turns clockwise.
  return compose(compose(compose(m, [1, 0, 0, 1, -cx, -cy]), [0, 1, -1, 0, 0, 0]), [1, 0, 0, 1, cx, cy]);
}

/**
 * A handle of the part that shows, at `(hu, hv)` in its own box — 0, ½ or 1
 * on each side — dragged to `pointer`. The opposite side stays where it is.
 * With `keepAspect` (Shift) both sides scale alike.
 */
export function resize(m: Matrix, clip: Clip, handle: [number, number], pointer: Point, keepAspect: boolean): Matrix {
  const inverse = invert(m);
  if (!inverse) return m;
  const [u0, v0, u1, v1] = clip;
  const hu = u0 + (u1 - u0) * handle[0];
  const hv = v0 + (v1 - v0) * handle[1];
  const fu = handle[0] === 0 ? u1 : u0;
  const fv = handle[1] === 0 ? v1 : v0;
  const p = apply(inverse, pointer.x, pointer.y);
  const movesU = handle[0] !== 0.5;
  const movesV = handle[1] !== 0.5;
  const MIN = 0.05;
  let sx = movesU ? (p.x - fu) / (hu - fu) : 1;
  let sy = movesV ? (p.y - fv) / (hv - fv) : 1;
  if (keepAspect) {
    const s = movesU && movesV ? Math.max(sx, sy) : movesU ? sx : sy;
    sx = s;
    sy = s;
  }
  sx = Math.max(MIN, sx);
  sy = Math.max(MIN, sy);
  // Scale the unit square about the fixed side, then place it as before.
  const cu = movesU || keepAspect ? fu : 0;
  const cv = movesV || keepAspect ? fv : 0;
  return compose([sx, 0, 0, sy, cu * (1 - sx), cv * (1 - sy)], m);
}

/** A crop handle dragged to `pointer`: that side of the part that shows moves. */
export function crop(m: Matrix, clip: Clip, handle: [number, number], pointer: Point): Clip {
  const inverse = invert(m);
  if (!inverse) return clip;
  const p = apply(inverse, pointer.x, pointer.y);
  const MIN = 0.02;
  let [u0, v0, u1, v1] = clip;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  if (handle[0] === 0) u0 = Math.min(clamp(p.x), u1 - MIN);
  if (handle[0] === 1) u1 = Math.max(clamp(p.x), u0 + MIN);
  if (handle[1] === 0) v0 = Math.min(clamp(p.y), v1 - MIN);
  if (handle[1] === 1) v1 = Math.max(clamp(p.y), v0 + MIN);
  return [u0, v0, u1, v1];
}

/** A link rectangle, `[x, y, width, height]`, moved or with one edge or corner dragged. */
export function dragRect(rect: Rect, handle: [number, number] | null, dx: number, dy: number): Rect {
  if (!handle) return { ...rect, x: rect.x + dx, y: rect.y + dy };
  let { x, y, width, height } = rect;
  const MIN = 4;
  if (handle[0] === 0) {
    const right = x + width;
    x = Math.min(x + dx, right - MIN);
    width = right - x;
  } else if (handle[0] === 1) {
    width = Math.max(MIN, width + dx);
  }
  if (handle[1] === 0) {
    const bottom = y + height;
    y = Math.min(y + dy, bottom - MIN);
    height = bottom - y;
  } else if (handle[1] === 1) {
    height = Math.max(MIN, height + dy);
  }
  return { x, y, width, height };
}

/** The rectangle between two points, however they were dragged. */
export function between(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** The eight handles of a box, as fractions of it: corners and edge midpoints. */
export const HANDLES: readonly [number, number][] = [
  [0, 0],
  [0.5, 0],
  [1, 0],
  [1, 0.5],
  [1, 1],
  [0.5, 1],
  [0, 1],
  [0, 0.5],
];
