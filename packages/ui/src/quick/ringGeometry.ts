/**
 * The ring's shape (`Ring.tsx`): its size matches the window the host makes
 * (`src-tauri/src/ring.rs`, SIDE), segments run clockwise from the top, and
 * a point is on a segment only between the hub and the outer edge.
 */

export const RING_SIZE = 300;
export const RING_OUTER = 140;
export const RING_INNER = 54;

export interface RingSegment {
  path: string;
  /** Where the segment's icon and name go. */
  label: { x: number; y: number };
}

const point = (angle: number, radius: number) => {
  const center = RING_SIZE / 2;
  // 0 is the top, angles grow clockwise.
  return { x: center + radius * Math.sin(angle), y: center - radius * Math.cos(angle) };
};

const fixed = (n: number) => Number(n.toFixed(2));

export function ringSegments(count: number): RingSegment[] {
  if (count <= 0) return [];
  const step = (2 * Math.PI) / count;
  const gap = count > 1 ? 0.02 : 0;
  return Array.from({ length: count }, (_, index) => {
    const start = index * step - step / 2 + gap;
    const end = index * step + step / 2 - gap;
    const large = end - start > Math.PI ? 1 : 0;
    const a = point(start, RING_OUTER);
    const b = point(end, RING_OUTER);
    const c = point(end, RING_INNER);
    const d = point(start, RING_INNER);
    const path =
      count === 1
        ? `M ${fixed(RING_SIZE / 2)} ${fixed(RING_SIZE / 2 - RING_OUTER)} A ${RING_OUTER} ${RING_OUTER} 0 1 1 ${fixed(RING_SIZE / 2 - 0.01)} ${fixed(RING_SIZE / 2 - RING_OUTER)} Z`
        : `M ${fixed(a.x)} ${fixed(a.y)} A ${RING_OUTER} ${RING_OUTER} 0 ${large} 1 ${fixed(b.x)} ${fixed(b.y)} L ${fixed(c.x)} ${fixed(c.y)} A ${RING_INNER} ${RING_INNER} 0 ${large} 0 ${fixed(d.x)} ${fixed(d.y)} Z`;
    const label = point(index * step, (RING_OUTER + RING_INNER) / 2);
    return { path, label: { x: fixed(label.x), y: fixed(label.y) } };
  });
}

/** The segment under a point of the window, or null in the hub or off the ring. */
export function segmentAt(x: number, y: number, count: number): number | null {
  if (count <= 0) return null;
  const center = RING_SIZE / 2;
  const dx = x - center;
  const dy = y - center;
  const distance = Math.hypot(dx, dy);
  if (distance < RING_INNER || distance > RING_OUTER) return null;
  const step = (2 * Math.PI) / count;
  let angle = Math.atan2(dx, -dy);
  if (angle < 0) angle += 2 * Math.PI;
  return Math.floor((angle + step / 2) / step) % count;
}

/** Whether a point of the window is in the hub, the ring's middle. */
export function inHub(x: number, y: number): boolean {
  return Math.hypot(x - RING_SIZE / 2, y - RING_SIZE / 2) < RING_INNER;
}

/**
 * A point the host gives, in the window's own pixels, as a point of the
 * ring's drawing: the drawing is scaled to fill the window, whatever size
 * the screen's scale made it.
 */
export function toRing(at: { x: number; y: number }, windowSide: number): { x: number; y: number } {
  const scale = windowSide > 0 ? RING_SIZE / windowSide : 1;
  return { x: at.x * scale, y: at.y * scale };
}
