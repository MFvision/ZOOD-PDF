import { invokeHost, onHostEvent } from '../core/host-tauri';

/**
 * The natural voices of the Windows app (`apps/desktop/src-tauri/src/neural/`):
 * small neural models the person downloads once, which the host runs on the
 * device and answers with a WAV file a sentence at a time. This file lists
 * and downloads them, and plays what the host speaks through Web Audio.
 */

export interface NeuralVoice {
  /** The host's id, without the `neural:` prefix the voice lists use. */
  id: string;
  name: string;
  lang: string;
  bytes: number;
  state: 'ready' | 'missing' | 'downloading';
  received?: number;
}

/** How a natural voice's id is written in the voice lists, beside the system's. */
export const NEURAL_PREFIX = 'neural:';

function isNeuralVoice(value: unknown): value is NeuralVoice {
  const voice = value as Partial<NeuralVoice> | null;
  return (
    typeof voice === 'object' &&
    voice !== null &&
    typeof voice.id === 'string' &&
    typeof voice.name === 'string' &&
    typeof voice.lang === 'string' &&
    typeof voice.bytes === 'number' &&
    (voice.state === 'ready' || voice.state === 'missing' || voice.state === 'downloading')
  );
}

export async function neuralVoices(): Promise<NeuralVoice[]> {
  const listed = await invokeHost('speech_neural_voices').catch(() => []);
  return Array.isArray(listed) ? listed.filter(isNeuralVoice) : [];
}

/** Downloads a voice, reporting its progress; resolves once it is kept. */
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

/** Plays the host's speech, one sentence at a time; pausing suspends it. */
export class NeuralPlayer {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private finish: (() => void) | null = null;
  /** Bumped by `cancel`, so a sentence still being spoken by the host is not played. */
  private generation = 0;
  private paused = false;

  async speak(voice: string, text: string, rate: number): Promise<void> {
    this.stopSource();
    const generation = ++this.generation;
    const wav = await invokeHost('speech_synthesize', { voice, text, rate });
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
