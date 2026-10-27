import { describe, expect, it } from 'vitest';
import { NeuralPlayer, wavSamples } from './neural';

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

  it('makes a sentence ahead once, after the one asked for now, and forgets it on stop', async () => {
    const made: string[] = [];
    let release: () => void = () => undefined;
    const first = new Promise<void>((resolve) => (release = resolve));
    const player = new NeuralPlayer(async (_voice, text) => {
      made.push(text);
      if (text === 'one') await first;
      return new ArrayBuffer(10); // not a WAV: playing it fails before any audio is needed
    });
    const one = player.speak('v', 'one', 1).catch(() => undefined);
    player.prepare('v', 'two', 1);
    player.prepare('v', 'two', 1);
    await Promise.resolve();
    // The one asked for is made first; the one ahead waits for it.
    expect(made).toEqual(['one']);
    release();
    await one;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(made).toEqual(['one', 'two']);
    // Asked for now, the sentence made ahead is not made again.
    await player.speak('v', 'two', 1).catch(() => undefined);
    expect(made).toEqual(['one', 'two']);
    player.prepare('v', 'three', 1);
    player.cancel();
    await player.speak('v', 'three', 1).catch(() => undefined);
    expect(made).toEqual(['one', 'two', 'three', 'three']);
  });
});
