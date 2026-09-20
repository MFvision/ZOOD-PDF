import { useSyncExternalStore } from 'react';
import { isTauriHost, openExternalUrl } from '../core/host-tauri';

/**
 * Opening a link a PDF names. A file is hostile input, and a link is one
 * click from sending the person somewhere they did not choose — so no view
 * opens one on its own. Every request lands here: EmbedPDF's link clicks
 * (its `onNavigate`), its outline's, anything else in the page that calls
 * `window.open`, and the Edit PDF view's own. The person sees the address
 * and decides; only then does it open, in the system's browser.
 *
 * Only web and e-mail addresses are ever opened. `javascript:`, `file:`,
 * `data:` and the rest are refused outright, with the dialog saying so.
 */

/** What a link asks to do, and what Warraq thinks of it. */
export interface LinkRequest {
  url: string;
  /** Web (`http`, `https`) or e-mail (`mailto`): the only kinds that open. */
  safe: boolean;
}

/** Whether an address is one Warraq will offer to open. Mirrors the core's `allowed_uri`. */
export function isOpenableUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 4096) return false;
  // Controls — a newline, say — can hide what an address really is.
  if ([...trimmed].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return false;
  return /^(https?:\/\/|mailto:)/i.test(trimmed);
}

let pending: LinkRequest | null = null;
const listeners = new Set<() => void>();

function set(next: LinkRequest | null): void {
  pending = next;
  for (const listener of listeners) listener();
}

/** Asks the person whether to open `url`. Nothing opens until they say yes. */
export function requestOpenLink(url: string): void {
  set({ url, safe: isOpenableUrl(url) });
}

export function dismissLink(): void {
  set(null);
}

/** The link waiting for an answer, for the dialog. */
export function useLinkRequest(): LinkRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pending,
    () => null,
  );
}

let nativeOpen: typeof window.open | null = null;

/** Opens an address the person confirmed, in the system's browser or mail app. */
export async function openConfirmed(url: string): Promise<void> {
  if (!isOpenableUrl(url)) return;
  if (isTauriHost()) {
    await openExternalUrl(url.trim());
    return;
  }
  const open = nativeOpen ?? window.open.bind(window);
  open(url.trim(), '_blank', 'noopener,noreferrer');
}

/**
 * A window the app opens itself, not an address a document names: the cloud
 * sign-in (`cloud/signin.ts`), which must reach the provider's own page. It
 * goes through the `window.open` the guard kept, since the guard's own stands
 * in the way of everything the page asks for — the point of it.
 */
export function openOwnWindow(name: string, features: string): Window | null {
  const open = nativeOpen ?? window.open.bind(window);
  return open('', name, features);
}

/**
 * Routes every `window.open` in the page through the question. EmbedPDF's
 * outline opens a bookmark's address with `window.open` directly, around its
 * own `autoOpenLinks` setting; this catches that and anything like it.
 * Installed once; the real `window.open` is kept for `openConfirmed` and for
 * the app's own windows (`openOwnWindow`).
 */
export function installLinkGuard(): void {
  if (nativeOpen || typeof window === 'undefined') return;
  nativeOpen = window.open.bind(window);
  window.open = ((url?: string | URL) => {
    if (url !== undefined && String(url).length > 0) requestOpenLink(String(url));
    return null;
  }) as typeof window.open;
}
