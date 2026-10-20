import { keyValueStore } from '../state/idb';
import type { Entry } from '../state/idb';
import { getSettings } from '../state/settings';

/**
 * Two kinds of copies, both kept on this device only, in the app's own store
 * (never beside the person's file):
 *
 * - **Versions**: each time a file is saved, the bytes it had before, so an
 *   earlier save can be opened or put back (File › Versions). As many as
 *   Settings › History says (off, 5 or 20 a file); the oldest go first.
 * - **Recovery**: while a document has changes not yet saved, a copy of it as
 *   it stands, every minute or five (Settings › History › Autosave). Taken
 *   away when the file is saved or closed; still there after a crash, when
 *   the next start offers to bring the work back.
 */

export interface Version {
  /** The file's name when this version was kept. */
  name: string;
  bytes: ArrayBuffer;
}

export interface VersionInfo {
  key: string;
  name: string;
  at: number;
  size: number;
}

export interface Recovery {
  name: string;
  bytes: ArrayBuffer;
  /** Where the file was on the computer, when the desktop app knows. */
  path?: string;
}

const versions = keyValueStore<Version>('zood-versions');
const recovery = keyValueStore<Recovery>('zood-recovery');

/** What a file is known by here: its path on the computer if there is one, else its name. */
export function fileKey(name: string, path?: string): string {
  return (path ?? name).toLowerCase();
}

/** Keeps `bytes` (the file before this save) as a version of `key`, if versions are on. */
export async function keepVersion(key: string, name: string, bytes: ArrayBuffer): Promise<void> {
  const limit = getSettings().versions;
  if (limit === 0 || bytes.byteLength === 0) return;
  await versions.put(`${key}\u0000${Date.now()}`, { name, bytes: bytes.slice(0) });
  const kept = await versions.list(`${key}\u0000`);
  for (const old of kept.slice(limit)) await versions.delete(old.key);
}

export async function listVersions(key: string): Promise<VersionInfo[]> {
  const kept: Entry<Version>[] = await versions.list(`${key}\u0000`);
  return kept.map((entry) => ({ key: entry.key, name: entry.value.name, at: entry.at, size: entry.value.bytes.byteLength }));
}

export function readVersion(versionKey: string): Promise<Version | null> {
  return versions.get(versionKey);
}

export function deleteVersion(versionKey: string): Promise<void> {
  return versions.delete(versionKey);
}

export function clearVersions(): Promise<void> {
  return versions.clear();
}

/** The copy of an unsaved document, under its tab's id, replaced each time. */
export function keepRecovery(tab: string, copy: Recovery): Promise<void> {
  return recovery.put(tab, { ...copy, bytes: copy.bytes.slice(0) });
}

export function dropRecovery(tab: string): Promise<void> {
  return recovery.delete(tab);
}

/** What a run that did not end well left behind, newest first. */
export async function pendingRecoveries(): Promise<(Recovery & { tab: string; at: number })[]> {
  const kept = await recovery.list();
  return kept.map((entry) => ({ ...entry.value, tab: entry.key, at: entry.at }));
}

export function clearRecovery(): Promise<void> {
  return recovery.clear();
}

/* ---- What this run saved, to tell unsaved work from saved ---------------- */

/** This run, so a tab's recovery copy is never taken for another run's same-numbered tab. */
export const RUN = Date.now().toString(36);

export function recoveryKey(tab: number): string {
  return `${RUN}:${tab}`;
}

const savedDigests = new Map<number, string>();

export async function digestOf(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!globalThis.crypto?.subtle) return `${view.byteLength}`;
  const hash = await crypto.subtle.digest('SHA-256', view as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The tab's file as it was just saved: no recovery copy is needed for it now. */
export async function noteSaved(tab: number, bytes: Uint8Array | ArrayBuffer): Promise<void> {
  savedDigests.set(tab, await digestOf(bytes));
  await dropRecovery(recoveryKey(tab));
}

/** Whether `bytes` are what the tab last saved. */
export async function isSaved(tab: number, bytes: Uint8Array | ArrayBuffer): Promise<boolean> {
  const saved = savedDigests.get(tab);
  return saved !== undefined && saved === (await digestOf(bytes));
}
