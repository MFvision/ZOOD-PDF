/**
 * Voice filtering, ranking and choice for read aloud. Pure functions (unit-tested); the
 * backends feed them what the platform reports.
 */
import type { ReadingRun, SpeechVoice, VoiceQuality } from './types';

/** Names of voices that stream audio from a server even if an engine calls them local. */
const NETWORK_NAME = /\bOnline\b|^Google\s/i;

/**
 * On-device voices only: `localService === true` (Chrome's "Google …" and Edge's "… Online
 * (Natural)" voices are network voices and are never used — the text would leave the device).
 */
export function isLocalWebVoice(v: Pick<SpeechSynthesisVoice, 'localService' | 'name'>): boolean {
  return v.localService === true && !NETWORK_NAME.test(v.name);
}

/** Apple names its downloadable higher-quality voices "Name (Enhanced)" / "Name (Premium)". */
export function qualityFromName(name: string): VoiceQuality {
  if (/premium/i.test(name)) return 'premium';
  if (/enhanced/i.test(name)) return 'enhanced';
  return 'default';
}

export function normaliseTag(lang: string): string {
  const parts = lang.replace(/_/g, '-').split('-').filter(Boolean);
  if (parts.length === 0) return '';
  return parts.map((p, i) => (i === 0 ? p.toLowerCase() : p.length === 2 ? p.toUpperCase() : p)).join('-');
}

export function primaryLang(lang: string): string {
  return normaliseTag(lang).split('-')[0] ?? '';
}

function region(lang: string): string {
  const parts = normaliseTag(lang).split('-');
  return parts.find((p, i) => i > 0 && /^[A-Z]{2}$/.test(p)) ?? '';
}

export function fromWebVoice(v: SpeechSynthesisVoice): SpeechVoice {
  return { id: v.voiceURI || v.name, name: v.name, lang: normaliseTag(v.lang), quality: qualityFromName(v.name) };
}

const QUALITY_RANK: Record<VoiceQuality, number> = { premium: 2, enhanced: 1, default: 0 };

/** Regions tried after the user's own, per language. */
const REGIONS: Record<string, string[]> = {
  ar: ['SA', 'AE', 'EG', 'JO', 'KW', 'QA', 'BH', 'OM'],
  en: ['US', 'GB', 'AU', 'CA', 'IE', 'IN', 'ZA'],
};

/** Voices of language `primary`, best first: Premium → Enhanced → default, then region, then name. */
export function rankVoices(voices: SpeechVoice[], primary: string, userRegion = ''): SpeechVoice[] {
  const order = [userRegion, ...(REGIONS[primary] ?? [])].filter(Boolean);
  const regionRank = (v: SpeechVoice) => {
    const i = order.indexOf(region(v.lang));
    return i < 0 ? order.length : i;
  };
  return voices
    .filter((v) => primaryLang(v.lang) === primary)
    .sort(
      (a, b) =>
        QUALITY_RANK[b.quality] - QUALITY_RANK[a.quality] || regionRank(a) - regionRank(b) || a.name.localeCompare(b.name, 'en'),
    );
}

/** Languages whose voices can read a run, most likely first. */
const SCRIPT_LANGS: Record<string, string[]> = {
  Arab: ['ar'],
  Latn: ['en'],
  Hebr: ['he'],
  Cyrl: ['ru', 'uk', 'bg', 'sr', 'kk'],
  Grek: ['el'],
  Deva: ['hi', 'mr', 'ne'],
  Thai: ['th'],
  Hani: ['zh', 'ja'],
  Jpan: ['ja'],
  Hang: ['ko'],
};

export function candidateLangs(run: Pick<ReadingRun, 'lang' | 'script'>): string[] {
  if (run.lang === 'ar') return ['ar'];
  if (run.lang === 'en') return ['en'];
  return SCRIPT_LANGS[run.script] ?? [];
}

/** User's remembered voice per language (`{ ar: id, en: id }`). */
export type VoicePrefs = Record<string, string | undefined>;

/** The voice to read a run with, or null when no installed voice speaks its language. */
export function chooseVoice(voices: SpeechVoice[], langs: string[], prefs: VoicePrefs, userRegion = ''): SpeechVoice | null {
  for (const lang of langs) {
    const chosen = prefs[lang];
    const pick = chosen ? voices.find((v) => v.id === chosen && primaryLang(v.lang) === lang) : undefined;
    if (pick) return pick;
    const best = rankVoices(voices, lang, lang === 'en' ? userRegion : '')[0];
    if (best) return best;
  }
  return null;
}

/** Voices grouped by primary language, each group best first. */
export function groupVoices(voices: SpeechVoice[], userRegion = ''): Map<string, SpeechVoice[]> {
  const out = new Map<string, SpeechVoice[]>();
  for (const lang of new Set(voices.map((v) => primaryLang(v.lang)).filter(Boolean))) {
    out.set(lang, rankVoices(voices, lang, lang === 'en' ? userRegion : ''));
  }
  return out;
}
