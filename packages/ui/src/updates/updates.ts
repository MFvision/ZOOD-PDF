import { useSyncExternalStore } from 'react';
import { currentWindowLabel, invokeHost, isTauriHost, onHostEvent } from '../core/host-tauri';
import { getSettings } from '../state/settings';

/**
 * Updates of the desktop app from GitHub (apps/desktop/src-tauri/src/updates.rs,
 * docs/updates.md). The host asks the stable channel and installs only what is
 * signed with the project's key; this side decides when to ask and shows what
 * there is. One state per window, read by the banner and by Settings › About.
 * Browsers never get here: the web app updates itself on reload.
 */

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
}

export type UpdatePhase = 'idle' | 'checking' | 'latest' | 'available' | 'installing' | 'failed';

export interface UpdateState {
  phase: UpdatePhase;
  info: UpdateInfo | null;
  /** 0–1 while installing, null when the size is not known. */
  progress: number | null;
  /** "Later" on the banner: hidden until the next launch or the next check from About. */
  dismissed: boolean;
}

let state: UpdateState = { phase: 'idle', info: null, progress: null, dismissed: false };
const listeners = new Set<() => void>();

function put(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getUpdateState(): UpdateState {
  return state;
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getUpdateState,
    getUpdateState,
  );
}

/** Whether this app can update itself: the desktop app only. */
export function canUpdate(): boolean {
  return isTauriHost();
}

function parseInfo(raw: unknown): UpdateInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== 'string') return null;
  return {
    version: r.version,
    currentVersion: typeof r.currentVersion === 'string' ? r.currentVersion : '',
    notes: typeof r.notes === 'string' && r.notes.trim() ? r.notes.trim() : null,
  };
}

/** Asks the stable channel now. Never throws: a failure is the `failed` phase. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!canUpdate() || state.phase === 'checking' || state.phase === 'installing') return state.info;
  put({ phase: 'checking', dismissed: false });
  try {
    const info = parseInfo(await invokeHost('update_check'));
    put({ phase: info ? 'available' : 'latest', info });
    return info;
  } catch {
    put({ phase: 'failed', info: null });
    return null;
  }
}

/** Downloads and installs what the last check found; the app restarts into it. */
export async function installUpdate(): Promise<void> {
  if (state.phase !== 'available') return;
  put({ phase: 'installing', progress: 0 });
  const stop = onHostEvent<{ downloaded: number; total: number | null }>(
    'update-progress',
    ({ downloaded, total }) => {
      put({ progress: total ? Math.min(1, downloaded / total) : null });
    },
  );
  try {
    await invokeHost('update_install');
  } catch {
    put({ phase: 'failed', progress: null });
  } finally {
    stop();
  }
}

export function dismissUpdate(): void {
  put({ dismissed: true });
}

/** The version of the installed app (the host's, not the interface package's). */
export async function appVersion(): Promise<string | null> {
  if (!isTauriHost()) return null;
  try {
    const version = await invokeHost('plugin:app|version');
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** How long after launch the first check waits, so it never slows the start. */
export const STARTUP_DELAY_MS = 8000;

let startupChecked = false;

/**
 * Once per launch, in the main window only, when the person left automatic
 * checks on. Returns the timer's cancel.
 */
export function scheduleStartupCheck(delay = STARTUP_DELAY_MS): () => void {
  if (startupChecked || !canUpdate() || currentWindowLabel() !== 'main') return () => {};
  const timer = setTimeout(() => {
    startupChecked = true;
    if (getSettings().checkUpdates) void checkForUpdate();
  }, delay);
  return () => clearTimeout(timer);
}

/** For tests: back to a fresh launch. */
export function resetUpdateState(): void {
  startupChecked = false;
  state = { phase: 'idle', info: null, progress: null, dismissed: false };
  for (const listener of listeners) listener();
}
