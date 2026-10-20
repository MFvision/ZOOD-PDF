import { describe, expect, it } from 'vitest';
import { wavSamples } from './neural';

function wav(samples: number[], rate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  [0x52, 0x49, 0x46, 0x46].forEach((byte, i) => view.setUint8(i, byte));
  view.setUint32(24, rate, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
  return buffer;
}

describe('natural voices', () => {
  it('reads the host’s 16-bit WAV as Web Audio’s samples', () => {
    const { rate, samples } = wavSamples(wav([0, 16384, -32768], 22050));
    expect(rate).toBe(22050);
    expect(Array.from(samples)).toEqual([0, 0.5, -1]);
  });

  it('refuses what is not a WAV file', () => {
    expect(() => wavSamples(new ArrayBuffer(10))).toThrow();
    expect(() => wavSamples(new ArrayBuffer(64))).toThrow();
  });
});
