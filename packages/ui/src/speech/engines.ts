import { invokeHost, isTauriHost } from '../core/host-tauri';
import { NEURAL_PREFIX, NeuralPlayer, neuralVoices } from './neural';
import { describeVoices } from './voices';
import type { VoiceInfo } from './voices';

/**
 * The engines that read aloud. In a browser, Web Speech: the system's voices
 * as the browser offers them. In the desktop app on a Mac, the system's own
 * AVSpeechSynthesizer through the host (`apps/desktop/src-tauri/src/speech.rs`):
 * WebKit's Web Speech hides the Enhanced and Premium voices a Mac has
 * downloaded, which is why reading there sounded flat. In the Windows app,
 * the natural voices the app downloads and runs itself (`neural.ts`) beside
 * the system's through Web Speech. The host says which it is
 * (`speech_engine`); anything else, or an older host, keeps Web Speech.
 */

export type EngineKind = 'web' | 'apple' | 'neural';

export interface SpeechEngine {
  readonly kind: EngineKind;
  voices(): Promise<VoiceInfo[]>;
  /**
   * Reads `text` in `voice` (or the engine's own voice for `lang`, a BCP 47
   * tag) at `rate` (1 normal). Resolves when it has been read or was cut off
   * by `cancel`; rejects when the engine fails on it.
   */
  speak(text: string, voice: VoiceInfo | null, lang: string, rate: number): Promise<void>;
  cancel(): void;
  pause(): void;
  resume(): void;
  /** Calls `listener` when the installed voices change (Web Speech loads them late). */
  watchVoices(listener: () => void): void;
}

/** The speech engine of Web Speech, as this file uses it — so a test can hand in its own. */
interface WebSpeech {
  getVoices(): SpeechSynthesisVoice[];
  speak(utterance: SpeechSynthesisUtterance): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  addEventListener?(type: 'voiceschanged', listener: () => void): void;
}

function webSpeech(): WebSpeech | null {
  const synth = (globalThis as { speechSynthesis?: WebSpeech }).speechSynthesis;
  return synth && typeof SpeechSynthesisUtterance !== 'undefined' ? synth : null;
}

function webEngine(synth: WebSpeech): SpeechEngine {
  return {
    kind: 'web',
    voices: async () => describeVoices(synth.getVoices()),
    speak: (text, voice, lang, rate) =>
      new Promise((resolve, reject) => {
        const utterance = new SpeechSynthesisUtterance(text);
        const system = voice ? synth.getVoices().find((candidate) => candidate.voiceURI === voice.id) : undefined;
        if (system) utterance.voice = system;
        utterance.lang = voice?.lang ?? lang;
        utterance.rate = rate;
        utterance.onend = () => resolve();
        utterance.onerror = (event) => {
          // Stopping cancels the utterance, which the browser reports as an error of its own.
          if (event.error === 'interrupted' || event.error === 'canceled') resolve();
          else reject(new Error(event.error));
        };
        synth.speak(utterance);
      }),
    cancel: () => synth.cancel(),
    pause: () => synth.pause(),
    resume: () => synth.resume(),
    watchVoices: (listener) => synth.addEventListener?.('voiceschanged', listener),
  };
}

interface HostVoice {
  id: string;
  name: string;
  lang: string;
  quality: VoiceInfo['quality'];
}

function isHostVoice(value: unknown): value is HostVoice {
  const voice = value as Partial<HostVoice> | null;
  return (
    typeof voice === 'object' &&
    voice !== null &&
    typeof voice.id === 'string' &&
    typeof voice.name === 'string' &&
    typeof voice.lang === 'string' &&
    (voice.quality === 'premium' || voice.quality === 'enhanced' || voice.quality === 'standard')
  );
}

function hostEngine(kind: EngineKind): SpeechEngine {
  const quiet = () => undefined;
  return {
    kind,
    voices: async () => {
      const listed = await invokeHost('speech_voices');
      return Array.isArray(listed)
        ? listed.filter(isHostVoice).map((voice) => ({ id: voice.id, name: voice.name, lang: voice.lang, quality: voice.quality }))
        : [];
    },
    speak: async (text, voice, lang, rate) => {
      await invokeHost('speech_speak', { text, voice: voice?.id ?? null, lang: voice?.lang ?? lang, rate });
    },
    cancel: () => void invokeHost('speech_stop').catch(quiet),
    pause: () => void invokeHost('speech_pause').catch(quiet),
    resume: () => void invokeHost('speech_resume').catch(quiet),
    watchVoices: () => undefined,
  };
}

/** The Windows app's engine: its own natural voices first, the system's through Web Speech too. */
function neuralEngine(synth: WebSpeech | null): SpeechEngine {
  const web = synth ? webEngine(synth) : null;
  const player = new NeuralPlayer();
  const natural = (voice: VoiceInfo | null) => (voice?.id.startsWith(NEURAL_PREFIX) ? voice.id.slice(NEURAL_PREFIX.length) : null);
  return {
    kind: 'neural',
    voices: async () => {
      const own: VoiceInfo[] = (await neuralVoices())
        .filter((voice) => voice.state === 'ready')
        .map((voice) => ({ id: NEURAL_PREFIX + voice.id, name: voice.name, lang: voice.lang, quality: 'premium', natural: true }));
      return [...own, ...(web ? await web.voices() : [])];
    },
    speak: async (text, voice, lang, rate) => {
      const id = natural(voice);
      if (id) return player.speak(id, text, rate);
      if (!web) throw new Error('E_SPEECH: no voice for this text');
      return web.speak(text, voice, lang, rate);
    },
    cancel: () => {
      player.cancel();
      web?.cancel();
    },
    pause: () => {
      player.pause();
      web?.pause();
    },
    resume: () => {
      player.resume();
      web?.resume();
    },
    watchVoices: (listener) => web?.watchVoices(listener),
  };
}

let chosen: Promise<SpeechEngine | null> | null = null;
let known: SpeechEngine | null = null;

/** The engine that reads aloud here, or null where nothing can (a browser without Web Speech). */
export function speechEngine(): Promise<SpeechEngine | null> {
  if (known) return Promise.resolve(known);
  chosen ??= (async () => {
    if (isTauriHost()) {
      const kind = await invokeHost('speech_engine').catch(() => 'web');
      if (kind === 'apple') return hostEngine(kind);
      if (kind === 'neural') return neuralEngine(webSpeech());
    }
    const synth = webSpeech();
    return synth ? webEngine(synth) : null;
  })().then((engine) => {
    known = engine;
    if (!engine) chosen = null;
    return engine;
  });
  return chosen;
}

/** The engine once `speechEngine` has found it; null before, or where there is none. */
export function knownEngine(): SpeechEngine | null {
  return known;
}

/** Whether anything here can read aloud, without waiting: the host, or Web Speech. */
export function speechAvailable(): boolean {
  return known !== null || isTauriHost() || webSpeech() !== null;
}

/** Forgets the engine found, for tests that change what the page has. */
export function resetSpeechEngine(): void {
  chosen = null;
  known = null;
}

/** Opens the system's settings where better voices are downloaded (desktop app only). */
export function openVoiceSettings(): void {
  if (isTauriHost()) void invokeHost('speech_open_settings').catch(() => undefined);
}
