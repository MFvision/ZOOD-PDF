/**
 * Tool sheets: core tools that need their own dialog (Create PDF, …) are opened through this tiny
 * bus, so `tools/registry.ts` can stay free of React. `App` subscribes and renders the sheet; a
 * sheet that is open can claim files dropped on the window.
 */
import type { OpenedFile } from './host';

export interface ToolSheetRequest {
  tool: string;
  /** Files to start with (e.g. dropped on the window). */
  files?: OpenedFile[];
}

type Listener = (req: ToolSheetRequest) => void;
const listeners = new Set<Listener>();

/** Ask the app to open a tool's sheet. */
export function requestToolSheet(req: ToolSheetRequest): void {
  for (const l of listeners) l(req);
}

/** Subscribe to sheet requests; returns an unsubscribe function. */
export function onToolSheet(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

type DropClaim = (files: OpenedFile[]) => boolean;
let dropClaim: DropClaim | null = null;

/** While set, window drops go to this handler first (it returns true when it took them). */
export function setDropClaim(fn: DropClaim | null): void {
  dropClaim = fn;
}

export function claimDrop(files: OpenedFile[]): boolean {
  return dropClaim ? dropClaim(files) : false;
}
