import { describe, expect, it } from 'vitest';
import { intentAt, intentOfDrop } from './dropIntent';

const zone = (isConnected: boolean) => ({
  isConnected,
  // A detached element measures as all zeros.
  getBoundingClientRect: () => (isConnected ? { left: 900, right: 1300, top: 100, bottom: 900 } : { left: 0, right: 0, top: 0, bottom: 0 }),
});

describe('the split drop overlay', () => {
  it('lights Open only over its target', () => {
    expect(intentAt({ x: 1000, y: 500 }, zone(true))).toBe('open');
    expect(intentAt({ x: 400, y: 500 }, zone(true))).toBe('combine');
    expect(intentAt(null, zone(true))).toBe('combine');
  });

  it('in a browser, drops where the file lands', () => {
    expect(intentOfDrop({ x: 1000, y: 500 }, zone(true), 'combine')).toBe('open');
  });

  it('on desktop, where the drop comes after the overlay has gone, keeps the target last hovered', () => {
    // Over Open, then the host's "leave", then the drop: the zone is detached.
    expect(intentOfDrop({ x: 1000, y: 500 }, zone(false), 'open')).toBe('open');
    expect(intentOfDrop({ x: 1000, y: 500 }, null, 'open')).toBe('open');
    expect(intentOfDrop({ x: 1000, y: 500 }, zone(false), 'combine')).toBe('combine');
  });
});
