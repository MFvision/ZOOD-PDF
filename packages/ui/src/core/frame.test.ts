import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame } from './frame';

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

describe('the core_call frame', () => {
  it('round-trips JSON (Arabic included) and blobs', () => {
    const frame = encodeFrame('{"name":"وثيقة"}', [bytes(37, 80, 68, 70), bytes(), bytes(0, 255)]);
    const decoded = decodeFrame(frame);
    expect(decoded.json).toBe('{"name":"وثيقة"}');
    expect(decoded.blobs.map((b) => [...new Uint8Array(b)])).toEqual([[37, 80, 68, 70], [], [0, 255]]);
  });

  it('lays out exactly as the Rust side does: lengths are u32 little-endian', () => {
    const frame = new Uint8Array(encodeFrame('{}', [bytes(9)]));
    expect([...frame]).toEqual([2, 0, 0, 0, 123, 125, 1, 0, 0, 0, 1, 0, 0, 0, 9]);
  });

  it('refuses a frame cut short instead of reading past it', () => {
    const frame = encodeFrame('{}', [bytes(1, 2, 3)]);
    for (let cut = 0; cut < frame.byteLength; cut += 1) {
      expect(() => decodeFrame(frame.slice(0, cut))).toThrow(/E_ARGS/);
    }
  });
});
