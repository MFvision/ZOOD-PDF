import { describe, expect, it, vi } from 'vitest';
import { webSpeechBackend, VOICE_WAIT_MS } from './web';

class FakeUtterance {
  voice: SpeechSynthesisVoice | null = null;
  lang = '';
  rate = 1;
  pitch = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}

const voice = (name: string, lang: string, localService: boolean) =>
  ({ name, lang, localService, voiceURI: `uri:${name}`, default: false }) as SpeechSynthesisVoice;

function fakeSynth(voices: SpeechSynthesisVoice[]) {
  const target = new EventTarget();
  const spoken: FakeUtterance[] = [];
  let list = voices;
  return {
    spoken,
    setVoices(v: SpeechSynthesisVoice[]) {
      list = v;
      target.dispatchEvent(new Event('voiceschanged'));
    },
    getVoices: () => list,
    speak: (u: SpeechSynthesisUtterance) => void spoken.push(u as unknown as FakeUtterance),
    cancel: vi.fn(),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
}

const Ctor = FakeUtterance as unknown as new (t: string) => SpeechSynthesisUtterance;

describe('web speech backend', () => {
  it('lists only local voices', async () => {
    const synth = fakeSynth([voice('Maged', 'ar-SA', true), voice('Google العربية', 'ar-SA', false), voice('Ava (Premium)', 'en-US', true)]);
    const b = webSpeechBackend(synth as never, Ctor)!;
    expect((await b.listVoices()).map((v) => [v.name, v.quality])).toEqual([
      ['Maged', 'default'],
      ['Ava (Premium)', 'premium'],
    ]);
  });

  it('waits for voiceschanged when the list starts empty', async () => {
    vi.useFakeTimers();
    try {
      const synth = fakeSynth([]);
      const b = webSpeechBackend(synth as never, Ctor)!;
      const p = b.listVoices();
      synth.setVoices([voice('Samantha', 'en-US', true)]);
      expect((await p).map((v) => v.name)).toEqual(['Samantha']);
      synth.setVoices([]);
      const q = b.listVoices();
      await vi.advanceTimersByTimeAsync(VOICE_WAIT_MS + 10);
      expect(await q).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('speaks with the chosen local voice and reports the end', () => {
    const synth = fakeSynth([voice('Maged', 'ar-SA', true)]);
    const b = webSpeechBackend(synth as never, Ctor)!;
    const on = { start: vi.fn(), end: vi.fn(), error: vi.fn() };
    b.speak({ text: 'مرحبا', voice: { id: 'uri:Maged', name: 'Maged', lang: 'ar-SA', quality: 'default' }, rate: 3, pitch: 1 }, on);
    const u = synth.spoken[0]!;
    expect(u.voice?.name).toBe('Maged');
    expect(u.lang).toBe('ar-SA');
    expect(u.rate).toBe(2);
    u.onstart?.();
    u.onend?.();
    expect(on.start).toHaveBeenCalledOnce();
    expect(on.end).toHaveBeenCalledOnce();
  });

  it('refuses to speak when the voice is gone or not local (no default-voice fallback)', async () => {
    const synth = fakeSynth([voice('Google US English', 'en-US', false)]);
    const b = webSpeechBackend(synth as never, Ctor)!;
    const on = { start: vi.fn(), end: vi.fn(), error: vi.fn() };
    b.speak({ text: 'hello', voice: { id: 'uri:Google US English', name: 'Google US English', lang: 'en-US', quality: 'default' }, rate: 1, pitch: 1 }, on);
    await new Promise((r) => setTimeout(r, 5));
    expect(synth.spoken).toHaveLength(0);
    expect(on.error).toHaveBeenCalledWith('voice-unavailable');
  });

  it('drops events of a cancelled utterance', () => {
    const synth = fakeSynth([voice('Samantha', 'en-US', true)]);
    const b = webSpeechBackend(synth as never, Ctor)!;
    const on = { start: vi.fn(), end: vi.fn(), error: vi.fn() };
    b.speak({ text: 'one', voice: { id: 'uri:Samantha', name: 'Samantha', lang: 'en-US', quality: 'default' }, rate: 1, pitch: 1 }, on);
    b.cancel();
    synth.spoken[0]!.onerror?.({ error: 'interrupted' });
    synth.spoken[0]!.onend?.();
    expect(on.end).not.toHaveBeenCalled();
    expect(on.error).not.toHaveBeenCalled();
    expect(synth.cancel).toHaveBeenCalled();
  });

  it('is unavailable without speechSynthesis', () => {
    expect(webSpeechBackend(undefined, Ctor)).toBeNull();
  });
});
