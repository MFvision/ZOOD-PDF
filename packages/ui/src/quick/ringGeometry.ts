/**
 * The ring's shape (`Ring.tsx`): its size matches the window the host makes
 * (`src-tauri/src/ring.rs`, SIDE), segments run clockwise from the top, and
 * a point is on a segment only between the hub and the outer edge. Round
 * the ring there is room for a group's half circle (SUB_INNER to
 * SUB_OUTER), which opens behind the group's segment.
 */

export const RING_SIZE = 420;
export const RING_OUTER = 140;
export const RING_INNER = 54;
export const SUB_INNER = 150;
export const SUB_OUTER = 200;
/** Each of a half circle's tools, in radians: about 63 pixels along its middle. */
export const SUB_STEP = 0.36;

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

/** A band of the circle from `start` to `end` (radians, clockwise from the top), between two radii. */
function band(start: number, end: number, inner: number, outer: number): string {
  const large = end - start > Math.PI ? 1 : 0;
  const a = point(start, outer);
  const b = point(end, outer);
  const c = point(end, inner);
  const d = point(start, inner);
  return `M ${fixed(a.x)} ${fixed(a.y)} A ${outer} ${outer} 0 ${large} 1 ${fixed(b.x)} ${fixed(b.y)} L ${fixed(c.x)} ${fixed(c.y)} A ${inner} ${inner} 0 ${large} 0 ${fixed(d.x)} ${fixed(d.y)} Z`;
}

/** The middle angle of segment `index` of `count`. */
export function segmentAngle(index: number, count: number): number {
  return count > 0 ? (index * 2 * Math.PI) / count : 0;
}

/** How far to move a segment outward, along its middle, as a popped-out group is drawn. */
export function outward(index: number, count: number, by: number): { x: number; y: number } {
  const angle = segmentAngle(index, count);
  return { x: fixed(by * Math.sin(angle)), y: fixed(-by * Math.cos(angle)) };
}

/** Where a group's half circle sits: centred behind segment `index`, one SUB_STEP per tool. */
function subSpan(index: number, count: number, members: number): { start: number; step: number } {
  return { start: segmentAngle(index, count) - (members * SUB_STEP) / 2, step: SUB_STEP };
}

/** The half circle of a group's tools, behind its segment, in the ring's order (clockwise). */
export function subSegments(index: number, count: number, members: number): RingSegment[] {
  if (members <= 0 || count <= 0) return [];
  const { start, step } = subSpan(index, count, members);
  const gap = 0.012;
  return Array.from({ length: members }, (_, k) => {
    const from = start + k * step + gap;
    const to = start + (k + 1) * step - gap;
    const label = point(start + (k + 0.5) * step, (SUB_INNER + SUB_OUTER) / 2);
    return { path: band(from, to, SUB_INNER, SUB_OUTER), label: { x: fixed(label.x), y: fixed(label.y) } };
  });
}

/** A point's angle from the top, clockwise, from 0 to 2π. */
function angleAt(x: number, y: number): number {
  const center = RING_SIZE / 2;
  const angle = Math.atan2(x - center, -(y - center));
  return angle < 0 ? angle + 2 * Math.PI : angle;
}

/** What is under a point: the hub, a segment, a tool of the open group's half circle, or nothing. */
export type RingHit = { kind: 'hub' } | { kind: 'segment'; index: number } | { kind: 'sub'; index: number } | null;

/**
 * What is under a point of the window. With a group open (`open`: its
 * segment and how many tools it has), the half circle is reached by moving
 * outward past the ring's edge, anywhere across its width, and a little
 * beyond its outer edge, so the pointer need not land exactly.
 */
export function hitRing(x: number, y: number, count: number, open: { index: number; members: number } | null = null): RingHit {
  const distance = Math.hypot(x - RING_SIZE / 2, y - RING_SIZE / 2);
  if (distance < RING_INNER) return { kind: 'hub' };
  if (open && open.members > 0 && distance > RING_OUTER && distance <= SUB_OUTER + 14) {
    const { start, step } = subSpan(open.index, count, open.members);
    // The angle past the half circle's start, wrapped into -π…π first.
    let from = angleAt(x, y) - start;
    from = ((((from + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
    const k = Math.floor(from / step);
    if (k >= 0 && k < open.members) return { kind: 'sub', index: k };
  }
  const index = segmentAt(x, y, count);
  return index === null ? null : { kind: 'segment', index };
}

export function ringSegments(count: number): RingSegment[] {
  if (count <= 0) return [];
  const step = (2 * Math.PI) / count;
  const gap = count > 1 ? 0.02 : 0;
  return Array.from({ length: count }, (_, index) => {
    const start = index * step - step / 2 + gap;
    const end = index * step + step / 2 - gap;
    const path =
      count === 1
        ? `M ${fixed(RING_SIZE / 2)} ${fixed(RING_SIZE / 2 - RING_OUTER)} A ${RING_OUTER} ${RING_OUTER} 0 1 1 ${fixed(RING_SIZE / 2 - 0.01)} ${fixed(RING_SIZE / 2 - RING_OUTER)} Z`
        : band(start, end, RING_INNER, RING_OUTER);
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
