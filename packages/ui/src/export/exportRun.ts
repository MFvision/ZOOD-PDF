import { useSyncExternalStore } from 'react';

/**
 * The export under way, kept outside the Export panel so it outlives it.
 *
 * Held in the panel, it was forgotten whenever the panel went away — back to
 * the tools list, the pane closed — while the export itself ran on: coming
 * back showed an idle panel, so a person pressed Export again, and again. A
 * 1,300-page file ended up exported four times at once, with no way to stop
 * any of them (break-zood, files-ui). One export at a time, its progress
 * shown wherever the panel is opened again, and Stop to end it.
 */

export type ExportOutcome =
  { kind: 'done'; name: string; reduced: boolean } | { kind: 'noText' } | { kind: 'stopped' };

export interface ExportRunState {
  /** The document it is for (`state.document.id`). */
  documentId: number | null;
  progress: { done: number; total: number } | null;
  outcome: ExportOutcome | null;
}

const IDLE: ExportRunState = { documentId: null, progress: null, outcome: null };
let current: ExportRunState = IDLE;
let controller: AbortController | null = null;
const listeners = new Set<() => void>();

function set(next: ExportRunState) {
  current = next;
  for (const listener of listeners) listener();
}

export function exportRunState(): ExportRunState {
  return current;
}

export function useExportRun(): ExportRunState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exportRunState,
    exportRunState,
  );
}

/** Starts an export for `documentId`, or null while another is under way. */
export function beginExport(documentId: number, total: number): AbortSignal | null {
  if (current.progress !== null) return null;
  controller = new AbortController();
  set({ documentId, progress: { done: 0, total }, outcome: null });
  return controller.signal;
}

export function exportProgress(signal: AbortSignal, done: number, total: number): void {
  if (controller?.signal === signal && !signal.aborted)
    set({ ...current, progress: { done, total } });
}

/** The run that `signal` started is over; `outcome` is what it came to (null: nothing to say). */
export function endExport(signal: AbortSignal, outcome: ExportOutcome | null): void {
  if (controller?.signal !== signal) return;
  controller = null;
  set({ ...current, progress: null, outcome: signal.aborted ? { kind: 'stopped' } : outcome });
}

/** Stop pressed, or the document it was for is no longer the one on screen. */
export function stopExport(): void {
  controller?.abort();
}

/** Tests only. */
export function resetExportRun(): void {
  controller?.abort();
  controller = null;
  set(IDLE);
}
