import { readJson } from '../state/preferences';
import { speechEngine } from '../speech/engines';
import type { SpeechEngine } from '../speech/engines';
import { pickVoice } from '../speech/voices';
import { splitSentences } from '../speech/sentences';
import type { VoiceInfo } from '../speech/voices';
import { languageOf } from './plan';
import type { TalkBack } from './settings';

/**
 * Ask ZOOD's answer, said aloud in the same voices Read aloud uses: the
 * app's own natural voices once downloaded (Supertonic's, reading Arabic
 * and English), then on a Mac the system's own AVSpeech voices through the
 * host (the Premium and Enhanced ones WebKit hides), on Windows the
 * system's through Web Speech — the voice chosen in Read aloud for the
 * answer's language, or the best one installed, at Read aloud's speed. All
 * of them run on the computer. A long answer is said a sentence at a time,
 * the next made while one is heard, so the first words come quickly.
 * Without a voice for the language the answer is only shown.
 */

/** Whether an answer is said aloud: after a spoken question, always, or never. */
export function shouldTalk(talkBack: TalkBack, spoken: boolean): boolean {
  return talkBack === 'always' || (talkBack === 'spoken' && spoken);
}

/** Counts what was said, so a later answer or a stop cuts off the one before. */
let turn = 0;
let voices: { engine: SpeechEngine; list: Promise<VoiceInfo[]> } | null = null;

function voicesOf(engine: SpeechEngine): Promise<VoiceInfo[]> {
  if (voices?.engine !== engine) {
    const list = engine.voices().catch(() => []);
    voices = { engine, list };
    // Web Speech names its voices late: asked again once they are in.
    engine.watchVoices(() => {
      if (voices?.engine === engine) voices = null;
    });
  }
  return voices.list;
}

/**
 * Says `text`, and resolves once it has been said, cut off, or could not
 * be (no engine, no voice for its language, the engine failed): an answer
 * that cannot be heard is still shown, so this never rejects.
 */
export async function talk(text: string): Promise<void> {
  const words = text.trim();
  if (!words) return;
  const mine = (turn += 1);
  const engine = await speechEngine().catch(() => null);
  if (!engine || mine !== turn) return;
  engine.cancel();
  const lang = languageOf(words);
  const chosen = readJson<{ voiceAr?: string | null; voiceEn?: string | null; rate?: number }>(
    'warraq.readAloud',
    {},
  );
  const voice = pickVoice(
    await voicesOf(engine),
    lang,
    (lang === 'ar' ? chosen.voiceAr : chosen.voiceEn) ?? null,
  );
  // The host's Apple engine speaks for a language without a named voice; the others need one.
  if (mine !== turn || (!voice && engine.kind !== 'apple')) return;
  const rate =
    typeof chosen.rate === 'number' && Number.isFinite(chosen.rate)
      ? Math.min(2, Math.max(0.5, chosen.rate))
      : 1;
  const tag = lang === 'ar' ? 'ar-SA' : 'en-US';
  // A natural voice is made a sentence at a time; the system's say it whole.
  const parts = voice?.natural ? splitSentences(words).map((sentence) => sentence.text) : [words];
  for (const [index, part] of parts.entries()) {
    if (mine !== turn) return;
    const said = engine.speak(part, voice, tag, rate);
    const after = parts[index + 1];
    if (after !== undefined) engine.prepare?.(after, voice, tag, rate);
    try {
      await said;
    } catch {
      return;
    }
  }
}

/** Says `text` without waiting for it. */
export function speak(text: string): void {
  void talk(text);
}

/** Stops whatever Ask ZOOD is saying, at once. */
export function stopSpeaking(): void {
  turn += 1;
  void speechEngine()
    .then((engine) => engine?.cancel())
    .catch(() => undefined);
}
