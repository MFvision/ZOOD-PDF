import { invokeHost, onHostEvent } from '../core/host-tauri';

/**
 * The natural voices of the desktop app (`apps/desktop/src-tauri/src/neural/`),
 * on Windows and on a Mac: packs of small neural models the person
 * downloads once — Supertonic 3's ten voices, each reading Arabic and
 * English, and Kareem for Arabic — which the host runs on the device and
 * answers with a WAV file a sentence at a time. This file lists and
 * downloads them, and plays what the host speaks through Web Audio, the
 * next sentence made while the one before is still being heard.
 */

/** One voice of a pack in one language. */
export interface NeuralVoice {
  /** The host's id, without the `neural:` prefix the voice lists use. */
  id: string;
  name: string;
  lang: string;
}

/** What one download brings. */
export interface NeuralPack {
  id: string;
  name: string;
  bytes: number;
  state: 'ready' | 'missing' | 'downloading';
  received?: number;
  voices: NeuralVoice[];
}

/** How a natural voice's id is written in the voice lists, beside the system's. */
export const NEURAL_PREFIX = 'neural:';

function isNeuralVoice(value: unknown): value is NeuralVoice {
  const voice = value as Partial<NeuralVoice> | null;
  return typeof voice === 'object' && voice !== null && typeof voice.id === 'string' && typeof voice.name === 'string' && typeof voice.lang === 'string';
}

function isNeuralPack(value: unknown): value is NeuralPack {
  const pack = value as Partial<NeuralPack> | null;
  return (
    typeof pack === 'object' &&
    pack !== null &&
    typeof pack.id === 'string' &&
    typeof pack.name === 'string' &&
    typeof pack.bytes === 'number' &&
    (pack.state === 'ready' || pack.state === 'missing' || pack.state === 'downloading') &&
    Array.isArray(pack.voices) &&
    pack.voices.every(isNeuralVoice)
  );
}

/** The packs this build can use, the one offered first first; none where the host has none. */
export async function neuralPacks(): Promise<NeuralPack[]> {
  const listed = await invokeHost('speech_neural_voices').catch(() => []);
  return Array.isArray(listed) ? listed.filter(isNeuralPack) : [];
}

/** The voices of the downloaded packs, in the packs' order. */
export async function neuralVoices(): Promise<NeuralVoice[]> {
  return (await neuralPacks()).filter((pack) => pack.state === 'ready').flatMap((pack) => pack.voices);
}

/** Downloads a pack, reporting its progress; resolves once it is kept. */
export async function downloadNeuralVoice(id: string, onProgress: (received: number, total: number) => void): Promise<void> {
  const stop = onHostEvent<{ id: string; received: number; total: number }>('warraq://speech-download', (progress) => {
    if (progress.id === id) onProgress(progress.received, progress.total);
  });
  try {
    await invokeHost('speech_neural_download', { id });
  } finally {
    stop();
  }
}

export function cancelNeuralDownload(id: string): void {
  void invokeHost('speech_neural_cancel_download', { id }).catch(() => undefined);
}

export async function deleteNeuralVoice(id: string): Promise<void> {
  await invokeHost('speech_neural_delete', { id });
}

/** A 16-bit mono WAV as the host writes it, as Web Audio plays it. */
export function wavSamples(wav: ArrayBuffer): { rate: number; samples: Float32Array<ArrayBuffer> } {
  const view = new DataView(wav);
  if (wav.byteLength < 44 || view.getUint32(0, false) !== 0x52494646 /* RIFF */) {
    throw new Error('E_SPEECH: not a WAV file');
  }
  const rate = view.getUint32(24, true);
  const count = (wav.byteLength - 44) >> 1;
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(44 + 2 * i, true) / 32768;
  return { rate, samples };
}

/** How many sentences are made ahead of the one being heard. */
const AHEAD = 2;

/**
 * Plays the host's speech, one sentence at a time; pausing suspends it.
 * `prepare` has the host make a sentence before it is asked for, so the
 * next one is ready when the one before ends instead of a pause while it
 * is made.
 */
export class NeuralPlayer {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private finish: (() => void) | null = null;
  /** Bumped by `cancel`, so a sentence still being spoken by the host is not played. */
  private generation = 0;
  private paused = false;
  private ready = new Map<string, Promise<unknown>>();
  /** The sentence the host is making last: one made ahead waits for it, so the one asked for now comes first. */
  private making: Promise<unknown> = Promise.resolve();

  constructor(private readonly synthesize: (voice: string, text: string, rate: number) => Promise<unknown> = (voice, text, rate) => invokeHost('speech_synthesize', { voice, text, rate })) {}

  private made(voice: string, text: string, rate: number): Promise<unknown> {
    const key = `${voice}\u0000${rate}\u0000${text}`;
    const kept = this.ready.get(key);
    if (kept) {
      this.ready.delete(key);
      return kept;
    }
    const made = this.synthesize(voice, text, rate);
    this.making = made.catch(() => undefined);
    return made;
  }

  /** Starts making a sentence that will be asked for soon. */
  prepare(voice: string, text: string, rate: number): void {
    const key = `${voice}\u0000${rate}\u0000${text}`;
    if (this.ready.has(key)) return;
    while (this.ready.size >= AHEAD) {
      const oldest = this.ready.keys().next().value;
      if (oldest === undefined) break;
      this.ready.delete(oldest);
    }
    const making = this.making.then(() => this.synthesize(voice, text, rate));
    // A sentence made ahead and never heard fails quietly.
    this.making = making.catch(() => undefined);
    this.ready.set(key, making);
  }

  async speak(voice: string, text: string, rate: number): Promise<void> {
    this.stopSource();
    const generation = ++this.generation;
    const wav = await this.made(voice, text, rate);
    if (generation !== this.generation) return;
    if (!(wav instanceof ArrayBuffer)) throw new Error('E_SPEECH: the voice answered nothing');
    const { rate: sampleRate, samples } = wavSamples(wav);
    if (samples.length === 0) return;
    this.context ??= new AudioContext();
    const buffer = this.context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    if (!this.paused) await this.context.resume();
    await new Promise<void>((resolve) => {
      this.finish = resolve;
      this.source = source;
      source.onended = () => {
        if (this.source === source) this.source = null;
        resolve();
      };
      source.start();
    });
  }

  private stopSource(): void {
    const source = this.source;
    this.source = null;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.finish?.();
    this.finish = null;
  }

  cancel(): void {
    this.generation++;
    this.ready.clear();
    this.stopSource();
    this.paused = false;
    void this.context?.resume();
  }

  pause(): void {
    this.paused = true;
    void this.context?.suspend();
  }

  resume(): void {
    this.paused = false;
    void this.context?.resume();
  }
}
