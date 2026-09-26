/**
 * Create PDF plumbing next to `tools/panels.ts` (which opens the sheet): files handed to the sheet
 * when it opens (dropped on the window), and a drop claim so later drops go to the open sheet.
 */
import type { OpenedFile } from './host';

let pending: OpenedFile[] = [];

/** Files the next Create PDF sheet starts with. */
export function setPendingCreateFiles(files: OpenedFile[]): void {
  pending = files;
}

/** Take (and clear) the files waiting for the Create PDF sheet. */
export function takePendingCreateFiles(): OpenedFile[] {
  const out = pending;
  pending = [];
  return out;
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
