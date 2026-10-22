import type { Ask } from './chat/answer';

/**
 * A request handed to the AI tool's chat from outside it — the home screen's
 * assistant card: one of its chips, or a typed question. It goes into the
 * chat of the document that is open (or of the one about to be opened) as
 * the person's message. On this device that is all: nothing leaves. For
 * Claude and a local server the chat's own rule holds — the first message
 * about a document waits at "What will be sent" for its Send button.
 */
export interface AiRequest {
  kind: Ask['kind'];
  /** The words of the message. */
  text: string;
  /** What it is asked about, when not the open document: "Ask about all my documents" asks the Library; with no document, the general chat. */
  scope?: 'chat' | 'document' | 'open' | 'library';
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
