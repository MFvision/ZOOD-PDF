import { MAX_STREAM_BYTES, STREAM_PART, STREAM_WINDOW, fromBase64 } from '../protocol';
import type { HostMessage, PhoneToHost } from '../protocol';
import { bytesToBase64 } from './seal';

/**
 * Files between the phone and the PC in parts (the PC's side is
 * `remote/stream.rs`). A part is read from the file only when it is about to
 * go, and no more than `STREAM_WINDOW` are ever unanswered, so a file of a
 * gigabyte takes no more memory on the phone than one of a megabyte.
 */

type Say = (message: PhoneToHost) => boolean;
type Answer = Extract<HostMessage, { t: 'putOk' | 'putNo' | 'putGot' | 'landed' }>;

/** How long the PC has to answer before a file is given up. */
const ANSWER_WAIT = 30_000;

export interface Progress {
  /** 0–1. */
  done: number;
}

export type SendResult = { ok: true; name: string } | { ok: false; why: 'tooBig' | 'refused' | 'lost' };

/** One file going to the PC's Desktop. */
export class Upload {
  private answers: Answer[] = [];
  private wake: (() => void) | null = null;
  private stopped = false;

  constructor(
    readonly id: string,
    private readonly file: Blob & { name: string; type: string },
    private readonly say: Say,
    private readonly onProgress: (progress: Progress) => void,
  ) {}

  /** The PC's answer about this file. */
  hear(answer: Answer): void {
    this.answers.push(answer);
    this.wake?.();
  }

  stop(): void {
    this.stopped = true;
    this.say({ t: 'putStop', id: this.id });
    this.wake?.();
  }

  private next(): Promise<Answer | null> {
    const ready = this.answers.shift();
    if (ready) return Promise.resolve(ready);
    if (this.stopped) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.wake = null;
        resolve(null);
      }, ANSWER_WAIT);
      this.wake = () => {
        window.clearTimeout(timer);
        this.wake = null;
        resolve(this.answers.shift() ?? null);
      };
    });
  }

  async run(): Promise<SendResult> {
    const { file } = this;
    if (file.size > MAX_STREAM_BYTES) return { ok: false, why: 'tooBig' };
    const sent = this.say({ t: 'putStart', id: this.id, name: file.name, mime: file.type || 'application/octet-stream', size: file.size });
    if (!sent) return { ok: false, why: 'lost' };
    const first = await this.next();
    if (!first || first.t !== 'putOk') return { ok: false, why: first?.t === 'putNo' ? 'refused' : 'lost' };

    const parts = Math.ceil(file.size / STREAM_PART);
    let answered = 0;
    for (let n = 0; n < parts; n += 1) {
      while (n >= answered + STREAM_WINDOW) {
        const answer = await this.next();
        if (!answer || answer.t !== 'putGot') return this.lost(answer);
        answered = Math.max(answered, answer.n + 1);
        this.onProgress({ done: answered / parts });
      }
      if (this.stopped) return { ok: false, why: 'lost' };
      const bytes = new Uint8Array(await file.slice(n * STREAM_PART, (n + 1) * STREAM_PART).arrayBuffer());
      if (!this.say({ t: 'putPart', id: this.id, n, data: bytesToBase64(bytes) })) return { ok: false, why: 'lost' };
    }
    while (answered < parts) {
      const answer = await this.next();
      if (!answer || answer.t !== 'putGot') return this.lost(answer);
      answered = Math.max(answered, answer.n + 1);
      this.onProgress({ done: answered / parts });
    }
    if (!this.say({ t: 'putEnd', id: this.id })) return { ok: false, why: 'lost' };
    const landed = await this.next();
    if (landed?.t === 'landed' && landed.ok) return { ok: true, name: landed.name };
    return { ok: false, why: 'lost' };
  }

  private lost(answer: Answer | null): SendResult {
    if (!answer) this.say({ t: 'putStop', id: this.id });
    return { ok: false, why: answer?.t === 'putNo' ? 'refused' : 'lost' };
  }
}

/** A file coming from the PC, part by part. */
export class Download {
  private readonly parts: Uint8Array<ArrayBuffer>[] = [];
  private got = 0;
  private next = 0;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly mime: string,
    readonly size: number,
  ) {}

  /** Takes part `n`; false when it is out of order or more than the file. */
  take(n: number, data: string): boolean {
    if (n !== this.next) return false;
    const bytes = fromBase64(data);
    if (!bytes || this.got + bytes.length > this.size) return false;
    this.parts.push(bytes);
    this.got += bytes.length;
    this.next += 1;
    return true;
  }

  get done(): number {
    return this.size === 0 ? 1 : this.got / this.size;
  }

  /** The whole file, once every byte came. */
  finish(): Blob | null {
    if (this.got !== this.size) return null;
    return new Blob(this.parts, { type: this.mime });
  }
}

/** A short id for a transfer, safe in a file name on the PC. */
export function transferId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
