import {
  cloudAuthCancel,
  cloudAuthListen,
  cloudAuthWait,
  cloudForget,
  cloudHasSession,
  cloudHttp,
  cloudToken,
  isTauriHost,
  openExternalUrl,
} from '../core/host-tauri';
import { BrowserBroker, HostBroker } from './brokers';
import { fetchTransport, hostTransport } from './http';
import type { CloudHost } from './service';

/**
 * Where the cloud code runs. On the desktop the host does what a webview
 * cannot: the loopback sign-in, the keychain, and every request to a drive
 * (`src-tauri/src/cloud.rs`). In a browser the page signs in in a pop-up,
 * keeps tokens in memory (or, if the person chooses, in this browser) and
 * fetches within its security policy.
 */
export function desktopHost(): CloudHost {
  return {
    desktop: true,
    transport: hostTransport(cloudHttp),
    broker: new HostBroker({ token: cloudToken, hasSession: cloudHasSession, forget: cloudForget }),
    signIn: { listen: cloudAuthListen, open: openExternalUrl, wait: cloudAuthWait, cancel: cloudAuthCancel },
  };
}

export function browserHost(): CloudHost {
  return { desktop: false, transport: fetchTransport, broker: new BrowserBroker(fetchTransport), signIn: null };
}

export function currentHost(): CloudHost {
  return isTauriHost() ? desktopHost() : browserHost();
}
