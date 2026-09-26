/** Client for `preprocess.worker.ts` (image preprocessing off the UI thread). */
import type { Point } from './preprocess';

export interface PrepOptions {
  /** Straighten the page image of a new scan (recognition always reads a straightened copy). */
  deskew: boolean;
  /** Divide out uneven lighting (shadows). */
  flatten: boolean;
  /** Clean up: black-and-white page (Sauvola) for new scans. */
  clean: boolean;
  /** Remove specks from the black-and-white image. */
  despeckle: boolean;
}

export interface PrepRequest {
  id: number;
  kind: 'prepare';
  /** Encoded image (PNG, JPEG, WebP, GIF, BMP). */
  image: Uint8Array;
  options: PrepOptions;
  /** Perspective correction corners in image pixels (clockwise from top-left). */
  quad?: Point[];
  /** Known resolution (rendered PDF pages); estimated from an A4 width otherwise. */
  dpi?: number;
  /** Also produce the page image of a new scan. */
  page?: boolean;
  /** Produce a preview no larger than this many pixels a side. */
  preview?: number;
}

export interface InfoRequest {
  id: number;
  kind: 'info';
  image: Uint8Array;
  maxSide: number;
}

export interface PrepResult {
  width: number;
  height: number;
  dpi: number;
  /** Detected skew of the content, degrees counter-clockwise. */
  angle: number;
  /** Rotation applied to the image the recogniser reads (−angle, stored as the skew it removed). */
  ocrRotation: number;
  /** Binary PGM for the recogniser. */
  pgm: Uint8Array;
  /** Skew removed from the new page image (0 when kept crooked). */
  pageRotation?: number;
  pageImage?: { format: 'gray' | 'jpeg'; data: Uint8Array; width: number; height: number };
  preview?: Uint8Array;
}

export interface ImageInfo {
  width: number;
  height: number;
  preview: Uint8Array;
}

export type PrepResponse =
  | { id: number; ok: true; result?: PrepResult; info?: ImageInfo }
  | { id: number; ok: false; error: { code: string; message: string } };

export class PrepError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PrepError';
    this.code = code;
  }
}

type Pending = { resolve: (r: PrepResponse & { ok: true }) => void; reject: (e: Error) => void };

export interface PrepClient {
  prepare(image: Uint8Array, opts: Omit<PrepRequest, 'id' | 'kind' | 'image'>): Promise<PrepResult>;
  info(image: Uint8Array, maxSide: number): Promise<ImageInfo>;
  terminate(): void;
}

export function createPrepClient(spawn: () => Worker = () => new Worker(new URL('./preprocess.worker.ts', import.meta.url), { type: 'module', name: 'zood-preprocess' })): PrepClient {
  let worker: Worker | null = null;
  let next = 1;
  const pending = new Map<number, Pending>();
  const ensure = () => {
    if (worker) return worker;
    const w = spawn();
    w.onmessage = (ev: MessageEvent<PrepResponse>) => {
      const p = pending.get(ev.data.id);
      if (!p) return;
      pending.delete(ev.data.id);
      if (ev.data.ok) p.resolve(ev.data);
      else p.reject(new PrepError(ev.data.error.code, ev.data.error.message));
    };
    w.onerror = (ev) => {
      worker = null;
      w.terminate();
      for (const p of pending.values()) p.reject(new PrepError('worker_crashed', ev.message || 'preprocessing stopped'));
      pending.clear();
    };
    worker = w;
    return w;
  };
  const send = (msg: Omit<PrepRequest, 'id'> | Omit<InfoRequest, 'id'>) =>
    new Promise<PrepResponse & { ok: true }>((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      const copy = msg.image.slice();
      ensure().postMessage({ ...msg, image: copy, id }, [copy.buffer]);
    });
  return {
    async prepare(image, opts) {
      const r = await send({ kind: 'prepare', image, ...opts });
      if (!r.result) throw new PrepError('preprocess_failed', 'no result');
      return r.result;
    },
    async info(image, maxSide) {
      const r = await send({ kind: 'info', image, maxSide });
      if (!r.info) throw new PrepError('preprocess_failed', 'no result');
      return r.info;
    },
    terminate() {
      worker?.terminate();
      worker = null;
      for (const p of pending.values()) p.reject(new PrepError('cancelled', 'cancelled'));
      pending.clear();
    },
  };
}
