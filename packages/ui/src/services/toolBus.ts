/**
 * Core-backed tools (Organize, Combine, Compress…) are opened by id: the registry's `core.open()`
 * emits here, and the view that owns the tool (the active document view, or the app for Combine)
 * listens. Keeps `tools/registry.ts` free of React.
 */
import type { ToolId } from '../tools/registry';

/** `docId`: the document the tool was started for (set by `withToolTarget`), if any. */
type Listener = (id: ToolId, docId: string | undefined) => void;
const listeners = new Set<Listener>();
let target: string | undefined;

export function emitTool(id: ToolId): void {
  for (const l of [...listeners]) l(id, target);
}

/** Runs `fn` (which may call a tool's `core.open()`) with `docId` as the tool's target document. */
export function withToolTarget<T>(docId: string | undefined, fn: () => T): T {
  const prev = target;
  target = docId;
  try {
    return fn();
  } finally {
    target = prev;
  }
}

export function onTool(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
