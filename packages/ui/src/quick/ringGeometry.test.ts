import { describe, expect, it } from 'vitest';
import { RING_INNER, RING_OUTER, RING_SIZE, inHub, ringSegments, segmentAt, toRing } from './ringGeometry';

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
    // A screen at 150%: the window is 450 pixels, the drawing 300.
    expect(toRing({ x: 225, y: 225 }, 450)).toEqual({ x: c, y: c });
    expect(segmentAt(...Object.values(toRing({ x: 225 + middle * 1.5, y: 225 }, 450)) as [number, number], 8)).toBe(2);
    expect(toRing({ x: 10, y: 20 }, 0)).toEqual({ x: 10, y: 20 });
  });
});
