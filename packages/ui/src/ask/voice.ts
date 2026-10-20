import { readJson } from '../state/preferences';
import { describeVoices, pickVoice } from '../speech/voices';
import { languageOf } from './plan';

/**
 * Ask ZOOD's answer, said aloud in the system's own voice for its language
 * — the one chosen for Read aloud, or the best installed — through Web
 * Speech, local voices only. Without a voice for the language the answer is
 * only shown.
 */
export function speak(text: string): void {
  const synth = globalThis.speechSynthesis;
  if (!synth || !text.trim()) return;
  synth.cancel();
  const lang = languageOf(text);
  const chosen = readJson<{ voiceAr?: string | null; voiceEn?: string | null }>('warraq.readAloud', {});
  const voices = describeVoices(synth.getVoices());
  const voice = pickVoice(voices, lang, (lang === 'ar' ? chosen.voiceAr : chosen.voiceEn) ?? null);
  if (!voice) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = synth.getVoices().find((one) => one.voiceURI === voice.id) ?? null;
  utterance.lang = voice.lang;
  synth.speak(utterance);
}

export function stopSpeaking(): void {
  globalThis.speechSynthesis?.cancel();
}
