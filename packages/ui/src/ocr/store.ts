/** Opens the Scan & OCR sheet from anywhere (tool registry, "+" menu, tool gallery, ⌘K). */
import { useSyncExternalStore } from 'react';

export type ScanMode = 'searchable' | 'scan';
export interface ScanRequest {
  /** Preferred tab; `undefined` = "Make searchable" when a document is open, else "Scan". */
  mode?: ScanMode;
  nonce: number;
}

let current: ScanRequest | null = null;
let nonce = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openScan(mode?: ScanMode): void {
  current = { mode, nonce: ++nonce };
  emit();
}

export function closeScan(): void {
  current = null;
  emit();
}

export function useScanRequest(): ScanRequest | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}
