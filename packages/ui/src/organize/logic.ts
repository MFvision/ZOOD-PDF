/** Pure helpers of the Organize tool: selection, keyboard focus, moves, crop geometry, drop halves. */

export interface Selection {
  selected: number[];
  anchor: number | null;
}

export function select(s: Selection, index: number, mods: { shift?: boolean; meta?: boolean }): Selection {
  if (mods.shift && s.anchor !== null) {
    const [a, b] = s.anchor <= index ? [s.anchor, index] : [index, s.anchor];
    return { selected: Array.from({ length: b - a + 1 }, (_, k) => a + k), anchor: s.anchor };
  }
  if (mods.meta) {
    const has = s.selected.includes(index);
    const selected = has ? s.selected.filter((i) => i !== index) : [...s.selected, index].sort((x, y) => x - y);
    return { selected, anchor: index };
  }
  return { selected: [index], anchor: index };
}

/** Focus movement in a grid laid out in reading order (`columns` per row). */
export function nextFocus(current: number, key: string, dir: 'ltr' | 'rtl', count: number, columns: number): number {
  const last = Math.max(0, count - 1);
  const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
  const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
  let n = current;
  if (key === forward) n = current + 1;
  else if (key === back) n = current - 1;
  else if (key === 'ArrowDown') n = current + Math.max(1, columns);
  else if (key === 'ArrowUp') n = current - Math.max(1, columns);
  else if (key === 'Home') n = 0;
  else if (key === 'End') n = last;
  return Math.min(last, Math.max(0, n));
}

/**
 * A drop "slot" is the gap before page `slot` (0 … count). The engine's `pages.move` takes the
 * position in the document WITHOUT the moved pages.
 */
export function moveTarget(moving: number[], slot: number): number {
  return slot - moving.filter((i) => i < slot).length;
}

/** The page order after moving `moving` (kept in order) to `to` — what `pages.move` does. */
export function orderAfterMove(count: number, moving: number[], to: number): number[] {
  const set = new Set(moving);
  const rest = Array.from({ length: count }, (_, i) => i).filter((i) => !set.has(i));
  const at = Math.min(Math.max(0, to), rest.length);
  return [...rest.slice(0, at), ...[...set].sort((a, b) => a - b), ...rest.slice(at)];
}

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

type Box = [number, number, number, number];

/**
 * Margins as the user sees the page (after /Rotate) → CropBox in page space, cut from `base`
 * (the current crop box or media box). /Rotate turns the page clockwise for display.
 */
export function cropBoxFromMargins(base: Box, rotate: number, m: Margins): Box | null {
  if ([m.top, m.right, m.bottom, m.left].some((v) => !Number.isFinite(v) || v < 0)) return null;
  const r = ((rotate % 360) + 360) % 360;
  // page-space margins: x0 side (left), y0 (bottom), x1 (right), y1 (top)
  let left: number, bottom: number, right: number, top: number;
  if (r === 90) {
    [left, top, right, bottom] = [m.top, m.right, m.bottom, m.left];
  } else if (r === 180) {
    [top, left, bottom, right] = [m.bottom, m.right, m.top, m.left];
  } else if (r === 270) {
    [right, bottom, left, top] = [m.top, m.right, m.bottom, m.left];
  } else {
    [top, right, bottom, left] = [m.top, m.right, m.bottom, m.left];
  }
  const box: Box = [base[0] + left, base[1] + bottom, base[2] - right, base[3] - top];
  if (box[2] - box[0] < 1 || box[3] - box[1] < 1) return null;
  return box;
}

/** A rectangle drawn on a preview (CSS pixels) → displayed margins in points. */
export function marginsFromRect(
  rect: { x: number; y: number; w: number; h: number },
  viewW: number,
  viewH: number,
  pageW: number,
  pageH: number,
): Margins {
  const sx = pageW / viewW;
  const sy = pageH / viewH;
  const round = (v: number) => Math.max(0, Math.round(v * 10) / 10);
  return {
    top: round(rect.y * sy),
    left: round(rect.x * sx),
    right: round((viewW - rect.x - rect.w) * sx),
    bottom: round((viewH - rect.y - rect.h) * sy),
  };
}

/** Which half of the split drop overlay a point falls in: the start half combines. */
export function dropChoice(x: number, width: number, dir: 'ltr' | 'rtl'): 'combine' | 'open' {
  const leftHalf = x < width / 2;
  return leftHalf === (dir === 'ltr') ? 'combine' : 'open';
}
