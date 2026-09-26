/**
 * Read aloud (local text-to-speech) — shared types. Everything runs on the device: the web
 * backend only ever uses `speechSynthesis` voices with `localService === true`, the desktop
 * backend the operating system's own voices (AVSpeechSynthesizer on macOS, Windows.Media
 * .SpeechSynthesis on Windows). See docs/decisions/0017-local-read-aloud.md.
 */

/** `ar`, `en` or `other` (then `script` says which writing system). */
export type ReadLang = 'ar' | 'en' | 'other';

/** ISO 15924-ish script codes the engine reports for runs. */
export type Script = 'Arab' | 'Latn' | 'Hebr' | 'Cyrl' | 'Grek' | 'Deva' | 'Thai' | 'Hani' | 'Jpan' | 'Hang' | 'Zyyy';

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ReadingRun {
  text: string;
  lang: ReadLang;
  script: Script;
}

/** One paragraph from the engine's `text.readingUnits` (page points, top-left origin). */
export interface ReadingUnit {
  page: number;
  index: number;
  text: string;
  lang: ReadLang;
  dir: 'ltr' | 'rtl';
  bbox: Rect;
  rects: Rect[];
  runs: ReadingRun[];
}

export type VoiceQuality = 'default' | 'enhanced' | 'premium';

export interface SpeechVoice {
  /** Stable id: voiceURI on the web, the OS identifier on desktop. */
  id: string;
  name: string;
  /** BCP-47 tag, e.g. `ar-SA`, `en-US`. */
  lang: string;
  quality: VoiceQuality;
}

export interface SpeakRequest {
  text: string;
  voice: SpeechVoice;
  /** 1 = the voice's normal speed; 0.5–2. */
  rate: number;
  /** 1 = normal; 0.5–2. */
  pitch: number;
}

export interface SpeakHandlers {
  start(): void;
  end(): void;
  error(reason: string): void;
}

export interface SpeechBackend {
  readonly kind: 'web' | 'native';
  /** On-device voices only. */
  listVoices(): Promise<SpeechVoice[]>;
  /** Fires when the installed voices change (or finish loading). */
  onVoicesChanged(cb: () => void): () => void;
  /** Speaks one utterance; exactly one of `end`/`error` follows unless `cancel` is called first. */
  speak(req: SpeakRequest, on: SpeakHandlers): void;
  /** Stops speaking and drops anything queued; no handler of the cancelled utterance fires afterwards. */
  cancel(): void;
  /** Reliable in-place pause (native engines). Without it, pausing cancels and resuming repeats the sentence. */
  pause?(): void;
  resume?(): void;
}
