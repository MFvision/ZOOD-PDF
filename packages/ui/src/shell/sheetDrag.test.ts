import { describe, expect, it } from 'vitest';
import { project, releaseVelocity, rubberband, sheetOutcome, springStep } from './sheetDrag';

describe('dragging the phone’s inspector sheet by its grabber', () => {
  it('projects a flick forward, as scrolling decelerates', () => {
    expect(project(0)).toBe(0);
    // 1000 pt/s at the normal rate lands about half a metre of pixels on.
    expect(project(1000)).toBeCloseTo(499, 0);
    expect(project(-1000)).toBeCloseTo(-499, 0);
  });

  it('resists more the further it is pulled past its top, and never passes the pull', () => {
    const height = 500;
    expect(rubberband(0, height)).toBe(0);
    const small = rubberband(20, height);
    const large = rubberband(200, height);
    expect(small).toBeLessThan(20);
    expect(large).toBeLessThan(200);
    expect(large / 200).toBeLessThan(small / 20);
  });

  it('measures the finger’s speed over its last moments, and a finger held still has none', () => {
    const samples = [
      { t: 0, y: 0 },
      { t: 50, y: 20 },
      { t: 100, y: 60 },
      { t: 116, y: 80 },
    ];
    expect(releaseVelocity(samples, 120)).toBeGreaterThan(900);
    expect(releaseVelocity(samples, 300)).toBe(0);
    expect(releaseVelocity([{ t: 0, y: 0 }], 5)).toBe(0);
  });

  it('closes when the drag, carried on by its speed, would pass half the sheet — and not when thrown back up', () => {
    const height = 400;
    expect(sheetOutcome(40, 0, height)).toBe('stay');
    expect(sheetOutcome(260, 0, height)).toBe('dismiss');
    // A short, fast flick down closes it; a long drag thrown back up does not.
    expect(sheetOutcome(60, 1200, height)).toBe('dismiss');
    expect(sheetOutcome(260, -600, height)).toBe('stay');
  });

  it('settles with a spring from where it is, at the speed it had', () => {
    const settle = (dampingRatio: number) => {
      let state = { x: 200, v: -1500 };
      let lowest = state.x;
      for (let frame = 0; frame < 120; frame += 1) {
        state = springStep(state, 0, 1 / 60, { dampingRatio, response: 0.3 });
        lowest = Math.min(lowest, state.x);
      }
      return { state, lowest };
    };
    const critical = settle(1);
    expect(Math.abs(critical.state.x)).toBeLessThan(0.5);
    expect(critical.lowest).toBeGreaterThan(-1);
    // Under-damped, a thrown sheet passes its rest a little and comes back.
    const bouncy = settle(0.8);
    expect(Math.abs(bouncy.state.x)).toBeLessThan(0.5);
    expect(bouncy.lowest).toBeLessThan(-1);
  });
});
