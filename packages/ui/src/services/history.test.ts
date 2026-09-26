import { describe, expect, it } from 'vitest';
import { EditHistory, extendsBytes } from './history';

const bytes = (...xs: number[]) => new Uint8Array(xs);
const append = (a: Uint8Array, ...xs: number[]) => {
  const out = new Uint8Array(a.length + xs.length);
  out.set(a);
  out.set(xs, a.length);
  return out;
};

describe('EditHistory', () => {
  it('undoes and redoes appended versions sharing one buffer', () => {
    const h = new EditHistory();
    const v0 = bytes(1, 2, 3);
    h.reset(v0);
    const v1 = append(v0, 4);
    const v2 = append(v1, 5, 6);
    h.push(v1);
    h.push(v2);
    expect(h.state()).toEqual({ canUndo: true, canRedo: false, depth: 2 });
    // Every version now lives in v2's buffer.
    expect(h.heldBytes()).toBe(v2.byteLength);
    expect([...h.undo()!]).toEqual([1, 2, 3, 4]);
    expect([...h.undo()!]).toEqual([1, 2, 3]);
    expect(h.undo()).toBeUndefined();
    expect([...h.redo()!]).toEqual([1, 2, 3, 4]);
    expect(h.state().canRedo).toBe(true);
    // A new edit drops the redo branch.
    h.push(append(h.current()!, 9));
    expect(h.state()).toEqual({ canUndo: true, canRedo: false, depth: 2 });
    expect(h.redo()).toBeUndefined();
  });

  it('keeps separate chains for non-incremental versions within the memory cap', () => {
    const h = new EditHistory(10);
    h.reset(bytes(1, 2, 3, 4));
    h.push(bytes(9, 9, 9, 9, 9)); // not an extension: new chain
    expect(h.heldBytes()).toBe(9);
    h.push(bytes(7, 7, 7)); // 12 > 10: the oldest chain is dropped
    expect(h.heldBytes()).toBeLessThanOrEqual(10);
    expect([...h.undo()!]).toEqual([9, 9, 9, 9, 9]);
    expect(h.undo()).toBeUndefined();
  });

  it('extendsBytes checks length and prefix', () => {
    expect(extendsBytes(bytes(1, 2), bytes(1, 2, 3))).toBe(true);
    expect(extendsBytes(bytes(1, 2), bytes(1, 3, 3))).toBe(false);
    expect(extendsBytes(bytes(1, 2), bytes(1, 2))).toBe(false);
  });
});
