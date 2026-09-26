import { describe, expect, it } from 'vitest';
import { resolveSpeech } from './index';
import type { NativeSpeech } from './native';
import type { SpeechBackend, SpeechVoice } from './types';

const V: SpeechVoice = { id: 'v', name: 'V', lang: 'ar-SA', quality: 'default' };

const webWith = (voices: SpeechVoice[]): (() => SpeechBackend) => () => ({
  kind: 'web',
  listVoices: async () => voices,
  onVoicesChanged: () => () => {},
  speak: () => {},
  cancel: () => {},
});

const native = (voices: SpeechVoice[] | Error): NativeSpeech => ({
  voices: async () => {
    if (voices instanceof Error) throw voices;
    return voices;
  },
  speak: async () => {},
  pause: async () => {},
  resume: async () => {},
  stop: async () => {},
  onEvent: () => () => {},
});

describe('choosing the speech backend', () => {
  it('prefers the native engine when it has voices', async () => {
    const s = await resolveSpeech({ speech: native([V]) }, webWith([V]));
    expect(s?.backend.kind).toBe('native');
  });

  it('falls back to local web voices (Linux desktop, native failure)', async () => {
    expect((await resolveSpeech({ speech: native([]) }, webWith([V])))?.backend.kind).toBe('web');
    expect((await resolveSpeech({ speech: native(new Error('x')) }, webWith([V])))?.backend.kind).toBe('web');
    expect((await resolveSpeech({}, webWith([V])))?.backend.kind).toBe('web');
  });

  it('is unavailable without any on-device voice', async () => {
    expect(await resolveSpeech({}, webWith([]))).toBeNull();
    expect(await resolveSpeech({}, () => null)).toBeNull();
  });
});
