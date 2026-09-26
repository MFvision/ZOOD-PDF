/**
 * The read-aloud queue: paragraphs (reading units) → runs (one voice each) → sentence chunks,
 * spoken one utterance at a time with play / pause / resume / stop / next / previous.
 *
 * Every utterance carries a generation number; cancelling bumps it, so late `end`/`error`
 * events of a cancelled utterance (Chrome fires them after `cancel()`) never move the queue.
 */
import { chunkText } from './chunk';
import { candidateLangs, chooseVoice, type VoicePrefs } from './voices';
import type { ReadingUnit, SpeechBackend, SpeechVoice } from './types';

export type ReaderStatus = 'idle' | 'playing' | 'paused';

export interface ReaderState {
  status: ReaderStatus;
  /** Index into the loaded units of the paragraph being read, -1 when idle. */
  unit: number;
  total: number;
  /** Engine error that stopped reading. */
  error?: string;
}

export interface ReaderPrefs {
  voices: VoicePrefs;
  rate: number;
  pitch: number;
}

export interface ReaderOptions {
  backend: SpeechBackend;
  /** Installed on-device voices (update with `setVoices`). */
  voices: SpeechVoice[];
  /** Voice per language, rate, pitch (update with `setPrefs`). */
  prefs: ReaderPrefs;
  userRegion?: string;
}

interface Chunk {
  unit: number;
  text: string;
  langs: string[];
}

/** Consecutive engine errors before reading stops. */
const MAX_ERRORS = 3;

export class ReadAloudController {
  private chunks: Chunk[] = [];
  private firstChunk: number[] = [];
  private units: ReadingUnit[] = [];
  private pos = -1;
  private gen = 0;
  private errors = 0;
  /** An utterance has been handed to the engine and has not ended. */
  private active = false;
  private current: ReaderState = { status: 'idle', unit: -1, total: 0 };
  private listeners = new Set<(s: ReaderState) => void>();

  private voices: SpeechVoice[];
  private prefs: ReaderPrefs;

  constructor(private readonly opts: ReaderOptions) {
    this.voices = opts.voices;
    this.prefs = opts.prefs;
  }

  setVoices(voices: SpeechVoice[]): void {
    this.voices = voices;
  }

  /** New settings apply from the next sentence; call `refresh()` to restart the current one. */
  setPrefs(prefs: ReaderPrefs): void {
    this.prefs = prefs;
  }

  get state(): ReaderState {
    return this.current;
  }

  subscribe(cb: (s: ReaderState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  load(units: ReadingUnit[]): void {
    this.halt();
    this.units = units;
    this.chunks = [];
    this.firstChunk = [];
    units.forEach((u, i) => {
      this.firstChunk.push(this.chunks.length);
      for (const run of u.runs) {
        const langs = candidateLangs(run);
        for (const text of chunkText(run.text)) this.chunks.push({ unit: i, text, langs });
      }
    });
    this.emit({ status: 'idle', unit: -1, total: units.length });
  }

  /** Languages of the loaded document that no installed voice speaks. */
  missingLangs(): string[] {
    const voices = this.voices;
    const missing = new Set<string>();
    for (const c of this.chunks) {
      if (c.langs.length && !chooseVoice(voices, c.langs, {})) missing.add(c.langs[0]!);
    }
    return [...missing];
  }

  play(fromUnit = 0): void {
    const u = Math.max(0, Math.min(fromUnit, this.units.length - 1));
    if (this.units.length === 0) return;
    this.errors = 0;
    this.speakFrom(this.firstChunk[u] ?? 0);
  }

  pause(): void {
    if (this.current.status !== 'playing') return;
    const b = this.opts.backend;
    if (b.pause && b.resume) b.pause();
    else {
      this.gen++;
      this.cancelActive();
    }
    this.emit({ ...this.current, status: 'paused' });
  }

  resume(): void {
    if (this.current.status !== 'paused') return;
    const b = this.opts.backend;
    if (b.pause && b.resume) {
      b.resume();
      this.emit({ ...this.current, status: 'playing' });
    } else this.speakFrom(this.pos);
  }

  toggle(): void {
    if (this.current.status === 'playing') this.pause();
    else if (this.current.status === 'paused') this.resume();
    else this.play(0);
  }

  stop(): void {
    this.halt();
    this.emit({ status: 'idle', unit: -1, total: this.units.length });
  }

  next(): void {
    if (this.pos < 0) return;
    const u = (this.chunks[this.pos]?.unit ?? -1) + 1;
    if (u >= this.units.length) this.stop();
    else this.speakFrom(this.firstChunk[u] ?? 0);
  }

  previous(): void {
    if (this.pos < 0) return;
    const u = Math.max(0, (this.chunks[this.pos]?.unit ?? 0) - 1);
    this.speakFrom(this.firstChunk[u] ?? 0);
  }

  /** Settings changed (voice, rate, pitch): restart the current sentence with them. */
  refresh(): void {
    if (this.current.status === 'playing') this.speakFrom(this.pos);
  }

  dispose(): void {
    this.halt();
    this.listeners.clear();
  }

  private halt(): void {
    this.gen++;
    this.cancelActive();
    this.pos = -1;
  }

  private cancelActive(): void {
    if (!this.active) return;
    this.active = false;
    this.opts.backend.cancel();
  }

  private emit(s: ReaderState): void {
    this.current = s;
    for (const l of this.listeners) l(s);
  }

  private speakFrom(start: number): void {
    const b = this.opts.backend;
    const g = ++this.gen;
    this.cancelActive();
    const voices = this.voices;
    const prefs = this.prefs;
    // Chunks nobody can speak are skipped (bounded by the chunk count).
    let i = start;
    let voice: SpeechVoice | null = null;
    for (; i < this.chunks.length; i++) {
      const c = this.chunks[i]!;
      voice = c.langs.length ? chooseVoice(voices, c.langs, prefs.voices, this.opts.userRegion) : null;
      if (voice) break;
    }
    const chunk = this.chunks[i];
    if (!chunk || !voice) {
      this.pos = -1;
      this.emit({ status: 'idle', unit: -1, total: this.units.length });
      return;
    }
    this.pos = i;
    this.emit({ status: 'playing', unit: chunk.unit, total: this.units.length });
    this.active = true;
    b.speak(
      { text: chunk.text, voice, rate: prefs.rate, pitch: prefs.pitch },
      {
        start: () => {},
        end: () => {
          if (g !== this.gen) return;
          this.active = false;
          this.errors = 0;
          this.speakFrom(i + 1);
        },
        error: (reason) => {
          if (g !== this.gen) return;
          if (reason === 'interrupted' || reason === 'canceled') return;
          this.active = false;
          this.errors++;
          if (this.errors >= MAX_ERRORS) {
            this.gen++;
            this.pos = -1;
            this.emit({ status: 'idle', unit: -1, total: this.units.length, error: reason });
          } else this.speakFrom(i + 1);
        },
      },
    );
  }
}

/** Where to start: the paragraph under the selection, else the first one of the page. */
export function startUnitFor(units: ReadingUnit[], at: { page: number; point?: { x: number; y: number } }): number {
  const onPage = units.map((u, i) => [u, i] as const).filter(([u]) => u.page === at.page);
  if (at.point) {
    const { x, y } = at.point;
    const hit = onPage.find(([u]) => x >= u.bbox.x0 - 2 && x <= u.bbox.x1 + 2 && y >= u.bbox.y0 - 2 && y <= u.bbox.y1 + 2);
    if (hit) return hit[1];
    const below = onPage.find(([u]) => u.bbox.y0 >= y);
    if (below) return below[1];
    const after = units.findIndex((u) => u.page > at.page);
    if (after >= 0) return after;
  }
  if (onPage[0]) return onPage[0][1];
  const later = units.findIndex((u) => u.page >= at.page);
  return later >= 0 ? later : 0;
}
