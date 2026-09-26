import { describe, expect, it } from 'vitest';
import { loadSpeechPrefs, saveSpeechPrefs, SPEECH_PREFS_KEY } from './prefs';

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('speech prefs', () => {
  it('round-trips the voice per language, rate and pitch', () => {
    const s = memory();
    saveSpeechPrefs({ voices: { ar: 'Maged', en: 'Ava' }, rate: 1.5, pitch: 1 }, s);
    expect(loadSpeechPrefs(s)).toEqual({ voices: { ar: 'Maged', en: 'Ava' }, rate: 1.5, pitch: 1 });
  });

  it('survives garbage and clamps values', () => {
    const s = memory();
    s.setItem(SPEECH_PREFS_KEY, '{nope');
    expect(loadSpeechPrefs(s)).toEqual({ voices: {}, rate: 1, pitch: 1 });
    s.setItem(SPEECH_PREFS_KEY, JSON.stringify({ voices: { ar: 5, 'x-bad': 'v', en: 'ok' }, rate: 40, pitch: 'x' }));
    expect(loadSpeechPrefs(s)).toEqual({ voices: { en: 'ok' }, rate: 2, pitch: 1 });
    expect(loadSpeechPrefs(undefined)).toEqual({ voices: {}, rate: 1, pitch: 1 });
  });
});
