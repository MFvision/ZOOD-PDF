import { describe, expect, it } from 'vitest';
import { RING_INNER, RING_OUTER, RING_SIZE, ringSegments, segmentAt } from './ringGeometry';

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
});
