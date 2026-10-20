/**
 * The voices the system has for reading aloud, through Web Speech. On a Mac
 * and an iPhone these are the system's voices — the enhanced and premium
 * ones once downloaded in the system's settings — and on Windows Microsoft's
 * offline voices (Hamed and Naayf for Arabic). Siri's voices are not offered
 * to any app, and the settings say so. Nothing here reaches the network: a
 * voice marked as not local is left out.
 */

export interface VoiceInfo {
  /** `voiceURI`, the one stable name. */
  id: string;
  name: string;
  lang: string;
  /** Marked by its name as a premium or enhanced voice: preferred. */
  quality: 'premium' | 'enhanced' | 'standard';
  /** One of the app's own natural voices (Windows), not the system's. */
  natural?: boolean;
}

export type VoiceLang = 'ar' | 'en';

const QUALITY = /premium|enhanced|neural|natural|محسّن|مميز/i;

function quality(name: string): VoiceInfo['quality'] {
  if (/premium/i.test(name)) return 'premium';
  return QUALITY.test(name) ? 'enhanced' : 'standard';
}

/** The system's local voices, as this app lists them. */
export function describeVoices(voices: readonly SpeechSynthesisVoice[]): VoiceInfo[] {
  return voices
    .filter((voice) => voice.localService)
    .map((voice) => ({ id: voice.voiceURI, name: voice.name, lang: voice.lang, quality: quality(voice.name) }));
}

const RANK: Record<VoiceInfo['quality'], number> = { premium: 0, enhanced: 1, standard: 2 };

/** The voices for `lang`, best first: premium, then enhanced, then the rest by name. */
export function voicesFor(voices: readonly VoiceInfo[], lang: VoiceLang): VoiceInfo[] {
  return voices
    .filter((voice) => voice.lang.toLowerCase().startsWith(lang))
    .sort((a, b) => RANK[a.quality] - RANK[b.quality] || a.name.localeCompare(b.name));
}

/**
 * The voice to read `lang` with: the one chosen in the settings when it is
 * still installed, else the best installed; null when the system has none
 * for that language.
 */
export function pickVoice(voices: readonly VoiceInfo[], lang: VoiceLang, chosen: string | null): VoiceInfo | null {
  const candidates = voicesFor(voices, lang);
  return candidates.find((voice) => voice.id === chosen) ?? candidates[0] ?? null;
}

/**
 * Whether the system has only basic voices for `lang`: none installed, or
 * none of them Enhanced or Premium. Where the
 * system can download better ones (Apple's), the interface says how.
 */
export function onlyBasicVoice(voices: readonly VoiceInfo[], lang: VoiceLang): boolean {
  return (voicesFor(voices, lang)[0]?.quality ?? 'standard') === 'standard';
}

/** A voice's name as the lists show it: with its quality, unless the name already says it. */
export function voiceLabel(voice: VoiceInfo, quality: { premium: string; enhanced: string; natural: string }): string {
  if (voice.natural) return `${voice.name} · ${quality.natural}`;
  if (voice.quality === 'standard' || QUALITY.test(voice.name)) return voice.name;
  return `${voice.name} · ${voice.quality === 'premium' ? quality.premium : quality.enhanced}`;
}
