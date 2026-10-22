import { invokeHost, isTauriHost } from '../core/host-tauri';

/**
 * ZOOD within reach without its window (`src-tauri/src/presence.rs`): the
 * tray icon, which a click turns into Ask ZOOD, and the ZOOD bubble.
 */
export interface Presence {
  bubble: boolean;
  lang: string;
}

/** The bubble and the tray's language; null outside the desktop. */
export async function presenceSettings(): Promise<Presence | null> {
  if (!isTauriHost()) return null;
  return ((await invokeHost('presence_settings').catch(() => null)) as Presence | null) ?? null;
}

/** Turns the bubble on or off, or tells the tray the app's language. */
export async function configurePresence(change: { bubble?: boolean; lang?: string }): Promise<Presence | null> {
  if (!isTauriHost()) return null;
  return ((await invokeHost('presence_configure', change).catch(() => null)) as Presence | null) ?? null;
}
