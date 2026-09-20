import { CALLBACK_CHANNEL, CALLBACK_MESSAGE, CALLBACK_PAGE } from './callback';
import { openOwnWindow } from '../links/openLink';
import { CloudError, kindOf } from './errors';
import { authorizeUrl, paramsOf, readCallback } from './oauth';
import type { AuthServer, Callback } from './oauth';
import { newPkce, newState } from './pkce';

/**
 * Getting an authorization code: the person signs in on the provider's own
 * page — never in a form of this app's — and the provider sends the browser
 * back to the redirect URI with a code for this sign-in's state. What comes
 * back with it is checked against that state, and the code is redeemed with
 * the verifier only this sign-in knows (PKCE).
 */

export interface SignedIn {
  callback: Callback;
  redirectUri: string;
  verifier: string;
}

/* ----------------------------------------------------------- the browser */

export const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

/** The redirect URI of the browser build: the callback page beside the app. */
export function browserRedirectUri(base: string = globalThis.document.baseURI): string {
  return new URL(CALLBACK_PAGE, base).href;
}

/**
 * Opens the sign-in window, in the same click that asked for it — a pop-up
 * opened after anything asynchronous is blocked by the browser. Its address
 * is set once the request is ready.
 *
 * It is opened through `openOwnWindow`, because the app's own link guard
 * takes `window.open` away from the page: no document may open a window,
 * and this is the app opening one.
 */
export function openSignInWindow(): Window {
  const width = 520;
  const height = 680;
  const left = Math.max(0, Math.round(globalThis.screenX + (globalThis.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(globalThis.screenY + (globalThis.outerHeight - height) / 3));
  const popup = openOwnWindow('warraq-sign-in', `popup,width=${width},height=${height},left=${left},top=${top}`);
  if (!popup) throw new CloudError('popupBlocked');
  return popup;
}

/**
 * Signs in in `popup`: sends it to the provider, then waits for the callback
 * page to hand back its address — by message to its opener and on a
 * broadcast channel, since the provider's pages may cut the opener off. Only
 * an address on this app's origin carrying this sign-in's state is taken.
 * The window closing first is a cancellation; ten minutes without an answer
 * is a timeout.
 */
export async function browserSignIn(
  popup: Window,
  server: AuthServer,
  extra?: Record<string, string>,
  signal?: AbortSignal,
): Promise<SignedIn> {
  const redirectUri = browserRedirectUri();
  const { verifier, challenge } = await newPkce();
  const state = newState();
  const own = globalThis.location.origin;
  popup.location.href = authorizeUrl(server, { redirectUri, state, challenge, extra });
  const params = await new Promise<Record<string, string>>((resolve, reject) => {
    let done = false;
    let channel: BroadcastChannel | null = null;
    const finish = (error: CloudError | null, answer?: Record<string, string>) => {
      if (done) return;
      done = true;
      clearInterval(watch);
      clearTimeout(timer);
      globalThis.removeEventListener('message', onMessage);
      channel?.close();
      signal?.removeEventListener('abort', onAbort);
      try {
        if (!popup.closed) popup.close();
      } catch {
        /* already gone */
      }
      if (error) reject(error);
      else resolve(answer ?? {});
    };
    const take = (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const { type, url } = data as { type?: unknown; url?: unknown };
      if (type !== CALLBACK_MESSAGE || typeof url !== 'string') return;
      let answer: Record<string, string>;
      try {
        if (new URL(url).origin !== own) return;
        answer = paramsOf(url);
      } catch {
        return;
      }
      // Another tab's sign-in, or someone else's answer: not this one.
      if (answer.state !== state) return;
      finish(null, answer);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin === own) take(event.data);
    };
    const onAbort = () => finish(new CloudError('cancelled'));
    try {
      channel = new BroadcastChannel(CALLBACK_CHANNEL);
      channel.addEventListener('message', (event) => take(event.data));
    } catch {
      /* no BroadcastChannel: the opener's message still arrives */
    }
    globalThis.addEventListener('message', onMessage);
    signal?.addEventListener('abort', onAbort);
    // The callback page closes itself right after it speaks: a closed window
    // is only a cancellation if nothing arrives in the moment after.
    let closedAt = 0;
    const watch = setInterval(() => {
      if (!popup.closed) return;
      closedAt ||= Date.now();
      if (Date.now() - closedAt > 1000) finish(new CloudError('cancelled'));
    }, 250);
    const timer = setTimeout(() => finish(new CloudError('timeout')), SIGN_IN_TIMEOUT_MS);
  });
  return { callback: readCallback(params, state), redirectUri, verifier };
}

/* ----------------------------------------------------------- the desktop */

/** What the desktop host offers a sign-in (`core/host-tauri.ts`). */
export interface HostSignIn {
  listen(): Promise<number>;
  open(url: string): Promise<void>;
  wait(state: string): Promise<Record<string, string>>;
  cancel(): Promise<void>;
}

/**
 * Signs in in the system's browser (RFC 8252): the host listens on
 * 127.0.0.1 at a port of its choosing for exactly one answer with this
 * state, the browser is sent to the provider, and the redirect comes back
 * to `http://127.0.0.1:<port>/callback`.
 */
export async function desktopSignIn(host: HostSignIn, server: AuthServer, extra?: Record<string, string>): Promise<SignedIn> {
  const port = await host.listen();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const { verifier, challenge } = await newPkce();
  const state = newState();
  try {
    await host.open(authorizeUrl(server, { redirectUri, state, challenge, extra }));
  } catch (error) {
    await host.cancel().catch(() => undefined);
    throw new CloudError('server', `the browser could not be opened: ${String(error)}`);
  }
  let params: Record<string, string>;
  try {
    params = await host.wait(state);
  } catch (error) {
    const kind = kindOf(error);
    // A declined consent comes back as the provider's `access_denied`.
    throw new CloudError(kind === 'denied' && String(error).includes('access_denied') ? 'cancelled' : kind, String(error));
  }
  return { callback: readCallback(params, state), redirectUri, verifier };
}
