import { describe, expect, it } from 'vitest';
import { RING_INNER, RING_OUTER, RING_SIZE, SUB_INNER, SUB_OUTER, hitRing, inHub, ringSegments, segmentAt, subSegments, toRing } from './ringGeometry';

const c = RING_SIZE / 2;
const middle = (RING_INNER + RING_OUTER) / 2;

describe('the ring', () => {
  it('has one segment a tool, the first at the top, going clockwise', () => {
    expect(ringSegments(8)).toHaveLength(8);
    expect(segmentAt(c, c - middle, 8)).toBe(0);
    expect(segmentAt(c + middle, c, 8)).toBe(2);
    expect(segmentAt(c, c + middle, 8)).toBe(4);
    expect(segmentAt(c - middle, c, 8)).toBe(6);
  });

  it('cancels in the hub and off the ring', () => {
    expect(segmentAt(c, c, 8)).toBeNull();
    expect(segmentAt(c + RING_INNER - 2, c, 8)).toBeNull();
    expect(segmentAt(2, 2, 8)).toBeNull();
    expect(segmentAt(c, c - middle, 0)).toBeNull();
  });

  it('puts each label inside its own segment', () => {
    const segments = ringSegments(9);
    segments.forEach((segment, index) => expect(segmentAt(segment.label.x, segment.label.y, 9)).toBe(index));
  });

  it('knows the hub, where files are let go to choose by click', () => {
    expect(inHub(c, c)).toBe(true);
    expect(inHub(c, c - middle)).toBe(false);
  });

  it('reads a point on a scaled window as the same point of the ring', () => {
    // A screen at 150%: the window is 1.5 times the drawing.
    const side = RING_SIZE * 1.5;
    expect(toRing({ x: side / 2, y: side / 2 }, side)).toEqual({ x: c, y: c });
    expect(segmentAt(...Object.values(toRing({ x: side / 2 + middle * 1.5, y: side / 2 }, side)) as [number, number], 8)).toBe(2);
    expect(toRing({ x: 10, y: 20 }, 0)).toEqual({ x: 10, y: 20 });
  });

  it('opens a group as a half circle behind its segment, reached by moving outward', () => {
    const sub = (SUB_INNER + SUB_OUTER) / 2;
    // Convert is the segment on the right (2 of 8), with 7 formats.
    const open = { index: 2, members: 7 };
    const halves = subSegments(2, 8, 7);
    expect(halves).toHaveLength(7);
    halves.forEach((half, k) => expect(hitRing(half.label.x, half.label.y, 8, open)).toEqual({ kind: 'sub', index: k }));
    // The middle format is straight out from the group, and the gap before the half circle reaches it too.
    expect(hitRing(c + sub, c, 8, open)).toEqual({ kind: 'sub', index: 3 });
    expect(hitRing(c + RING_OUTER + 4, c, 8, open)).toEqual({ kind: 'sub', index: 3 });
    // The ring itself still answers, and so does the hub; far behind the ring, nothing.
    expect(hitRing(c, c - middle, 8, open)).toEqual({ kind: 'segment', index: 0 });
    expect(hitRing(c, c, 8, open)).toEqual({ kind: 'hub' });
    expect(hitRing(c - sub, c, 8, open)).toBeNull();
    // With no group open, beyond the ring is nothing.
    expect(hitRing(c + sub, c, 8)).toBeNull();
  });

  it('keeps the half circle inside the window', () => {
    expect(SUB_OUTER).toBeLessThan(RING_SIZE / 2);
  });
});
