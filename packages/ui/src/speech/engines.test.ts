import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetSpeechEngine, speechEngine } from './engines';

afterEach(() => {
  vi.unstubAllGlobals();
  resetSpeechEngine();
});

function host(engine: string) {
  const calls: { cmd: string; args: unknown }[] = [];
  vi.stubGlobal('__TAURI_INTERNALS__', {
    invoke: async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      if (cmd === 'speech_engine') return engine;
      if (cmd === 'speech_voices')
        return [
          { id: 'com.apple.voice.premium.ar-001.Majed', name: 'Majed', lang: 'ar-001', quality: 'premium' },
          { id: 'bad', name: 3 },
        ];
      if (cmd === 'speech_speak') return 'done';
      if (cmd === 'speech_neural_voices')
        return [
          { id: 'ar-kareem', name: 'Kareem', lang: 'ar', bytes: 63206318, state: 'ready' },
          { id: 'en-later', name: 'Later', lang: 'en', bytes: 1, state: 'missing' },
        ];
      return null;
    },
    transformCallback: () => 0,
  });
  return calls;
}

describe('speech engines', () => {
  it('reads through Apple’s engine in the Mac app, with the voices and their quality from the host', async () => {
    const calls = host('apple');
    const engine = await speechEngine();
    expect(engine?.kind).toBe('apple');
    const voices = await engine!.voices();
    expect(voices).toEqual([{ id: 'com.apple.voice.premium.ar-001.Majed', name: 'Majed', lang: 'ar-001', quality: 'premium' }]);
    await engine!.speak('مرحبا.', voices[0]!, 'ar-SA', 1.25);
    expect(calls.at(-1)).toEqual({ cmd: 'speech_speak', args: { text: 'مرحبا.', voice: 'com.apple.voice.premium.ar-001.Majed', lang: 'ar-001', rate: 1.25 } });
  });

  it('keeps Web Speech where the host reads through the webview', async () => {
    host('web');
    vi.stubGlobal('speechSynthesis', { getVoices: () => [], speak: () => {}, cancel: () => {}, pause: () => {}, resume: () => {} });
    vi.stubGlobal('SpeechSynthesisUtterance', class {});
    expect((await speechEngine())?.kind).toBe('web');
  });

  it('lists the Windows app’s downloaded natural voices first, beside the system’s, and speaks with them through the host', async () => {
    const calls = host('neural');
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [{ voiceURI: 'hamed', name: 'Microsoft Hamed', lang: 'ar-SA', localService: true }],
      speak: () => {},
      cancel: () => {},
      pause: () => {},
      resume: () => {},
    });
    vi.stubGlobal('SpeechSynthesisUtterance', class {});
    const engine = await speechEngine();
    expect(engine?.kind).toBe('neural');
    const voices = await engine!.voices();
    expect(voices.map((voice) => voice.id)).toEqual(['neural:ar-kareem', 'hamed']);
    expect(voices[0]).toMatchObject({ name: 'Kareem', quality: 'premium', natural: true });
    // The host answers with a WAV; an empty one is a sentence with nothing to say.
    await engine!.speak('مرحبا.', voices[0]!, 'ar-SA', 1.5).catch(() => undefined);
    expect(calls.find((call) => call.cmd === 'speech_synthesize')).toEqual({
      cmd: 'speech_synthesize',
      args: { voice: 'ar-kareem', text: 'مرحبا.', rate: 1.5 },
    });
  });
});
