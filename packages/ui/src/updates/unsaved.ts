import { invokeHost, isTauriHost } from '../core/host-tauri';
import type { DocTab } from '../state/tabs';

/**
 * Unsaved work, for "Update now": the update restarts the app, which closes
 * every window. Each window tells the host how many of its documents have
 * unsaved changes (`updates.rs`, `unsaved_report`), so the window where the
 * person presses the button can count them all before anything restarts.
 */

/** This window's documents with unsaved changes: edited parked tabs, and the live one. */
export function unsavedHere(tabs: readonly DocTab[], activeTab: number | null, liveEdited: boolean): number {
  return tabs.filter((tab) => (tab.key === activeTab ? liveEdited || tab.edited : tab.edited)).length;
}

let reported = 0;

/** Tells the host this window's number; only when it changes. */
export function reportUnsaved(count: number): void {
  if (!isTauriHost() || count === reported) return;
  reported = count;
  void invokeHost('unsaved_report', { count }).catch(() => undefined);
}

/** Documents with unsaved changes in every open window; 0 when the host cannot say. */
export async function unsavedEverywhere(): Promise<number> {
  if (!isTauriHost()) return 0;
  try {
    const total = await invokeHost('unsaved_total');
    return typeof total === 'number' && total > 0 ? total : 0;
  } catch {
    return 0;
  }
}
