import type { Lang } from '../i18n/messages';
import type { TaskKind } from './budget';

/**
 * A request handed to the AI panel from outside it — the home screen's
 * suggestion chips. It only chooses the panel's action and fills in its
 * question; the panel then shows what would be sent, and nothing goes
 * anywhere until the person presses Send there, as always.
 */
export interface AiRequest {
  task: TaskKind;
  question?: string;
  /** For a translation: the language to translate into. */
  to?: Lang;
}

let pending: AiRequest | null = null;
const listeners = new Set<(request: AiRequest) => void>();

/** Leaves a request for the panel: taken when it mounts, or at once if it is open. */
export function postAiRequest(request: AiRequest): void {
  pending = request;
  for (const listener of listeners) listener(request);
}

/** The request left for the panel, once. */
export function takeAiRequest(): AiRequest | null {
  const request = pending;
  pending = null;
  return request;
}

export function onAiRequest(listener: (request: AiRequest) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
