/**
 * The ZOOD iPhone app around this page (`apps/ios/PDFEditor/Remote/`), when
 * the page runs inside it rather than in Safari. A browser page on the local
 * network cannot read or write the phone's clipboard by itself; the app can,
 * so inside the app:
 *
 * - what the PC copies is put on the iPhone's clipboard at once (`copy`);
 * - "Paste on the computer" takes what the iPhone copied in one tap (`paste`);
 * - the pairing is handed to the app (`paired`), so it can bring it back when
 *   the PC's address changes and the page comes from a new place;
 * - the app hears when the PC can't be reached (`lost`), so it can look for
 *   the PC on the Wi-Fi by its name and open it at its new address.
 *
 * Outside the app every call here is a quiet no.
 */

interface Handler {
  postMessage: (message: unknown) => void;
}

type Pasted = { text: string } | { png: string } | null;

declare global {
  interface Window {
    webkit?: { messageHandlers?: { zood?: Handler } };
    /** Set by the app before the page runs; the app answers through `answer`. */
    zoodApp?: { version: number; answer?: (id: number, value: unknown) => void };
  }
}

function handler(): Handler | null {
  return typeof window !== 'undefined' && window.zoodApp && window.webkit?.messageHandlers?.zood ? window.webkit.messageHandlers.zood : null;
}

/** Inside the ZOOD iPhone app. */
export function inApp(): boolean {
  return handler() !== null;
}

let nextAsk = 1;
const waiting = new Map<number, (value: unknown) => void>();

if (typeof window !== 'undefined' && window.zoodApp) {
  window.zoodApp.answer = (id, value) => {
    waiting.get(id)?.(value);
    waiting.delete(id);
  };
}

function ask(kind: string, body: Record<string, unknown> = {}, wait = 8000): Promise<unknown> {
  const app = handler();
  if (!app) return Promise.resolve(null);
  const id = nextAsk++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    window.setTimeout(() => {
      if (waiting.delete(id)) resolve(null);
    }, wait);
    app.postMessage({ ...body, kind, id });
  });
}

/** Puts the PC's copy on the iPhone's clipboard; true when the app did. */
export async function copyToPhone(clip: { text: string } | { png: string }): Promise<boolean> {
  return (await ask('copy', clip)) === true;
}

/** What the iPhone copied: text, a picture as PNG base64, or nothing. */
export async function pasteFromPhone(): Promise<Pasted> {
  const value = (await ask('paste', {}, 20_000)) as Pasted | { none: true };
  if (!value || typeof value !== 'object') return null;
  if ('text' in value && typeof value.text === 'string' && value.text) return { text: value.text };
  if ('png' in value && typeof value.png === 'string' && value.png) return { png: value.png };
  return null;
}

/** The app keeps this phone's pairing with the PC, by the PC's name. */
export function tellPaired(pairing: { device: string; key: string }, pc: string): void {
  handler()?.postMessage({ kind: 'paired', device: pairing.device, key: pairing.key, pc });
}

/** The PC has not answered for a while: the app may find it somewhere new. */
export function tellLost(): void {
  handler()?.postMessage({ kind: 'lost' });
}
