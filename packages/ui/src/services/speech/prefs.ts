/**
 * Read-aloud preferences, remembered on this device only (localStorage): the chosen voice per
 * language, the speed and the pitch.
 */
export interface SpeechPrefs {
  /** Voice id per primary language (`ar`, `en`, …). */
  voices: Record<string, string>;
  rate: number;
  pitch: number;
}

export const SPEECH_PREFS_KEY = 'zood.readAloud';
export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

const defaults = (): SpeechPrefs => ({ voices: {}, rate: 1, pitch: 1 });
const clamp = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(2, Math.max(0.5, v)) : d);

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

export function loadSpeechPrefs(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): SpeechPrefs {
  try {
    const raw = storage?.getItem(SPEECH_PREFS_KEY);
    if (!raw) return defaults();
    const p = JSON.parse(raw) as Partial<SpeechPrefs>;
    const voices: Record<string, string> = {};
    if (p.voices && typeof p.voices === 'object') {
      for (const [k, v] of Object.entries(p.voices)) if (/^[a-z]{2,3}$/.test(k) && typeof v === 'string' && v.length < 512) voices[k] = v;
    }
    return { voices, rate: clamp(p.rate, 1), pitch: clamp(p.pitch, 1) };
  } catch {
    return defaults();
  }
}

export function saveSpeechPrefs(p: SpeechPrefs, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try {
    storage?.setItem(SPEECH_PREFS_KEY, JSON.stringify(p));
  } catch {
    /* private mode: not remembered */
  }
}
