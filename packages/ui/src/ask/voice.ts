import { readJson } from '../state/preferences';
import { speechEngine } from '../speech/engines';
import type { SpeechEngine } from '../speech/engines';
import { pickVoice } from '../speech/voices';
import type { VoiceInfo } from '../speech/voices';
import { languageOf } from './plan';
import type { TalkBack } from './settings';

/**
 * Ask ZOOD's answer, said aloud in the same voices Read aloud uses: on a
 * Mac the system's own AVSpeech voices through the host (the Premium and
 * Enhanced ones WebKit hides), in the Windows app its own natural voices
 * (Kareem for Arabic) beside the system's, and Web Speech elsewhere — the
 * voice chosen in Read aloud for the answer's language, or the best one
 * installed, at Read aloud's speed. All of them run on the computer.
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
  await engine.speak(words, voice, lang === 'ar' ? 'ar-SA' : 'en-US', rate).catch(() => undefined);
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
