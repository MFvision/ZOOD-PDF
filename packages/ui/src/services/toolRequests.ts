/**
 * Tool requests for an open document window (a panel tool picked from Home, the More sheet or ⌘K while
 * the document view is already mounted). The document view subscribes; nothing is stored.
 */
import type { ToolId } from '../tools/registry';

type Listener = (docId: string, tool: ToolId) => void;
const listeners = new Set<Listener>();

export function requestTool(docId: string, tool: ToolId): void {
  for (const l of listeners) l(docId, tool);
}

export function onToolRequest(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
