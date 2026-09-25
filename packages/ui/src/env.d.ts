/// <reference types="vite/client" />

/** wasm-pack output of warraq-core (resolved by the zoodEngine Vite plugin; build fails if missing). */
declare module 'virtual:warraq-core' {
  export default function init(input?: unknown): Promise<unknown>;
  export class WarraqDocument {
    static open(bytes: Uint8Array, password?: string): WarraqDocument;
    call(method: string, paramsJson: string, blobs: Uint8Array[]): unknown;
    free?(): void;
  }
  export function callStatic(method: string, paramsJson: string, blobs: Uint8Array[]): unknown;
}

interface Window {
  /** Host bridge injected by a native host (Tauri) before the app boots. */
  __ZOOD_HOST__?: import('./services/host').HostBridge;
  /** Cloud client IDs; the Clouds section stays hidden unless set. */
  __ZOOD_CLOUD__?: { onedrive?: string; gdrive?: string };
}
