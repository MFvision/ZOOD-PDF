import type { DropPoint } from '../core/host-tauri';
import type { DropIntent } from '../state/AppContext';

/** The part of an element the split overlay needs: where it is, and whether it still is. */
export interface DropZone {
  readonly isConnected: boolean;
  getBoundingClientRect(): { left: number; right: number; top: number; bottom: number };
}

/** Which target of the split overlay a point is over: Combine unless it is on Open. */
export function intentAt(at: DropPoint | null, openZone: DropZone | null): DropIntent {
  const box = openZone?.getBoundingClientRect();
  if (!at || !box) return 'combine';
  const inside = at.x >= box.left && at.x <= box.right && at.y >= box.top && at.y <= box.bottom;
  return inside ? 'open' : 'combine';
}

/**
 * What a drop is for. A browser drops while the overlay is still up, so the
 * point is measured against it; the desktop host reports the drop only after
 * the overlay has gone — its Open target is detached and measures as nothing —
 * so there the target last hovered decides.
 */
export function intentOfDrop(at: DropPoint | null, openZone: DropZone | null, lastHovered: DropIntent): DropIntent {
  return at && openZone?.isConnected ? intentAt(at, openZone) : lastHovered;
}
