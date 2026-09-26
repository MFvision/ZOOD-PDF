/**
 * Host abstraction. The interface is the only thing the app knows about the platform it runs on:
 * the web/PWA and the extension use `webHost()` (files.ts); the desktop host (Tauri) installs its own
 * implementation as `window.__ZOOD_HOST__` before the app boots (native dialogs + fs write, because
 * WKWebView ignores `<input type=file>` and `<a download>`).
 */
import { webHost } from './files';
import type { SigningNetwork } from './signing';
import type { TrustStore } from './trust';

export interface OpenedFile {
  name: string;
  bytes: Uint8Array;
  /** Opaque handle for saving in place (FileSystemFileHandle on web, a path on desktop). */
  handle?: unknown;
}

export interface SaveOptions {
  /** Handle from `openFiles`/an earlier save: write in place when the host can. */
  handle?: unknown;
  /** Always ask for a location. */
  saveAs?: boolean;
  /** Content type when it is not a PDF (e.g. `application/zip` for Split on the web). */
  mimeType?: string;
}

export interface SaveResult {
  name: string;
  handle?: unknown;
}

export interface DropPoint {
  /** CSS pixels relative to the viewport. */
  x: number;
  y: number;
}

export interface HostBridge {
  readonly kind: 'web' | 'extension' | 'desktop';
  openFiles(opts?: { multiple?: boolean; accept?: string[] }): Promise<OpenedFile[]>;
  /** Resolves `null` when the user cancels. */
  saveFile(name: string, bytes: Uint8Array, opts?: SaveOptions): Promise<SaveResult | null>;
  /** Files dropped on the window (or re-emitted by a native host). Returns an unsubscribe function. */
  onHostDrop(cb: (files: OpenedFile[], point: DropPoint | null) => void): () => void;
  /**
   * Digital signatures. `network` exists on desktop only (timestamps and long-term validation,
   * SPEC: "timestamps + LTV desktop only"); `trust` replaces the IndexedDB trust list.
   */
  signing?: { network?: SigningNetwork; trust?: TrustStore };
}

let current: HostBridge | null = null;

/** Selects the host at runtime: a native host's `window.__ZOOD_HOST__` wins over the web one. */
export function getHost(): HostBridge {
  if (!current) current = (typeof window !== 'undefined' && window.__ZOOD_HOST__) || webHost();
  return current;
}

/** For tests and hosts that initialise late. */
export function setHost(host: HostBridge | null): void {
  current = host;
}
