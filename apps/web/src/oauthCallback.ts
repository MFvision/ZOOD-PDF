import { CALLBACK_CHANNEL, CALLBACK_MESSAGE } from '@warraq/ui/src/cloud/callback';
import type { CallbackMessage } from '@warraq/ui/src/cloud/callback';

/**
 * The sign-in window's last page (the browser build's redirect URI). It hands
 * its own address — the authorization code and state, or the provider's
 * error — to the app window that opened it, on its own origin only, and
 * closes. It reads nothing else, and the app takes the address only with the
 * state it sent.
 *
 * It says it twice: to its opener, and on a broadcast channel of this origin,
 * because a provider's pages may cut a pop-up off from its opener.
 */
const message: CallbackMessage = { type: CALLBACK_MESSAGE, url: window.location.href };

try {
  const channel = new BroadcastChannel(CALLBACK_CHANNEL);
  channel.postMessage(message);
  channel.close();
} catch {
  /* no BroadcastChannel: the opener still hears it */
}
try {
  window.opener?.postMessage(message, window.location.origin);
} catch {
  /* the opener has gone */
}
// The code leaves the address bar and this page's history entry.
window.history.replaceState(null, '', window.location.pathname);
window.close();
