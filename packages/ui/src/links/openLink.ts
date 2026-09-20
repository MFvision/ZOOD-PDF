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
  /** Refused for characters that would disguise it, whatever its kind. */
  disguised: boolean;
}

/** The longest address offered, in UTF-8 bytes once trimmed, as the core measures it. */
const MAX_URI_BYTES = 4096;

/**
 * Characters that change how an address shows, not where it goes: controls
 * (a newline, say), invisible format characters — the bidi embeddings,
 * overrides, isolates and marks, zero-width characters, the byte-order mark
 * — and line and paragraph separators. `https://www.bank.com` + RLO +
 * `@oi.live/` reads as a bank's address and opens `oi.live`. The core's
 * `hides_itself` refuses the same.
 */
const HIDES_ITSELF = /[\p{Cc}\p{Cf}\u{2028}\u{2029}]/u;

/** Whether an address is one Warraq will offer to open. Mirrors the core's `allowed_uri`. */
export function isOpenableUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0 || new TextEncoder().encode(trimmed).length > MAX_URI_BYTES) return false;
  if (HIDES_ITSELF.test(url)) return false;
  return /^(https?:\/\/|mailto:)/i.test(trimmed);
}

/**
 * An address as a person reads it — `https://example.org/دليل`, not
 * `%D8%AF%D9%84…` — for showing only: what opens is the address itself.
 * Escapes that stand for reserved characters stay as they are (`decodeURI`),
 * and anything that would hide itself is shown percent-encoded, visibly.
 */
export function displayUrl(url: string): string {
  let shown = url;
  try {
    shown = decodeURI(url);
  } catch {
    // A malformed escape: shown as it is written.
  }
  return [...shown].map((c) => (HIDES_ITSELF.test(c) ? encodeURIComponent(c) : c)).join('');
}

/**
 * Where a web address really goes: its host as the browser will ask for it
 * — an Arabic domain in its ASCII (punycode) form, which no bidi can
 * reorder. `null` for an e-mail address or one that does not parse.
 */
export function urlHost(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : null;
  } catch {
    return null;
  }
}

let pending: LinkRequest | null = null;
const listeners = new Set<() => void>();

function set(next: LinkRequest | null): void {
  pending = next;
  for (const listener of listeners) listener();
}

/** Asks the person whether to open `url`. Nothing opens until they say yes. */
export function requestOpenLink(url: string): void {
  set({ url, safe: isOpenableUrl(url), disguised: HIDES_ITSELF.test(url) });
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
 * Routes every `window.open` in the page through the question. EmbedPDF's
 * outline opens a bookmark's address with `window.open` directly, around its
 * own `autoOpenLinks` setting; this catches that and anything like it.
 * Installed once; the real `window.open` is kept for `openConfirmed`.
 */
export function installLinkGuard(): void {
  if (nativeOpen || typeof window === 'undefined') return;
  nativeOpen = window.open.bind(window);
  window.open = ((url?: string | URL) => {
    if (url !== undefined && String(url).length > 0) requestOpenLink(String(url));
    return null;
  }) as typeof window.open;
}
