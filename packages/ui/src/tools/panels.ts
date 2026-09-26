/**
 * Core-tool panels: a core-backed tool's `open(docId)` asks for its panel here, and the document
 * view that owns `docId` (or the active one when no id is given) renders it. Keeps the static
 * tool registry free of React state.
 */
import { useSyncExternalStore } from 'react';
import type { ToolId } from './registry';

export interface PanelRequest {
  tool: ToolId;
  /** Document the panel belongs to; undefined = the active document. */
  docId?: string;
  /** Changes on every request so re-opening the same panel re-mounts it. */
  nonce: number;
}

let current: PanelRequest | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function openToolPanel(tool: ToolId, docId?: string): void {
  current = { tool, docId, nonce: ++nonce };
  emit();
}

export function closeToolPanel(tool?: ToolId): void {
  if (tool && current?.tool !== tool) return;
  current = null;
  emit();
}

export function currentToolPanel(): PanelRequest | null {
  return current;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useToolPanel(): PanelRequest | null {
  return useSyncExternalStore(subscribe, currentToolPanel, currentToolPanel);
}

/** True when `req` targets the document `docId` (shown as active or not). */
export function panelFor(req: PanelRequest | null, docId: string, active: boolean): boolean {
  return !!req && (req.docId === docId || (req.docId === undefined && active));
}
