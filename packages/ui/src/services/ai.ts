/**
 * Seam for the AI tool. The AI Assistant card and action card are shown only when the `ai` tool is
 * ready AND a handler is registered here (by the agent that implements AI: bring-your-own-key or a
 * local model; the exact text is shown before Send). Nothing is sent before the user presses Send.
 */
export type AiHandler = (prompt: string, context: { documentId?: string }) => void | Promise<void>;

let handler: AiHandler | null = null;

export function setAiHandler(h: AiHandler | null): void {
  handler = h;
}

export function getAiHandler(): AiHandler | null {
  return handler;
}

/** Cloud drives stay hidden until client IDs are configured and a cloud provider registers itself. */
export function cloudsConfigured(): boolean {
  const ids = typeof window !== 'undefined' ? window.__ZOOD_CLOUD__ : undefined;
  return !!(ids && (ids.onedrive || ids.gdrive) && cloudOpener);
}

let cloudOpener: (() => void) | null = null;
export function setCloudOpener(open: (() => void) | null): void {
  cloudOpener = open;
}
export function openClouds(): void {
  cloudOpener?.();
}
