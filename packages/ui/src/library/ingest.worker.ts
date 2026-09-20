import { doWork } from './work';
import type { WorkRequest, WorkReply } from './work';

/**
 * The Library's reader, off the interface's thread: it unzips Office files,
 * parses their XML, cleans scans up, measures how crooked they are, hashes
 * bytes and draws thumbnails — everything in `work.ts`. The core and
 * Tesseract have workers of their own; this one never speaks to either, so
 * it needs nothing but bytes and pixels.
 *
 * A job that never answers is the caller's to survive: it drops this worker
 * and starts another (`reader.ts`), and the file is skipped with a reason.
 */

export interface WorkerJob {
  id: number;
  request: WorkRequest;
}

export type WorkerAnswer =
  | { id: number; ok: true; reply: WorkReply }
  | { id: number; ok: false; message: string };

/** Minimal scope typing keeps the package on the DOM lib without lib conflicts. */
interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerJob>) => void) | null;
  postMessage(message: WorkerAnswer, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = async (event) => {
  const { id, request } = event.data;
  try {
    const { reply, transfer } = await doWork(request);
    scope.postMessage({ id, ok: true, reply }, transfer);
  } catch (error) {
    scope.postMessage({ id, ok: false, message: String((error as Error)?.message ?? error) });
  }
};
