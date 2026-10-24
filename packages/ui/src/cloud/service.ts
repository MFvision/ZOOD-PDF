import type { CloudConfig, ProviderId } from './config';
import { offeredProviders } from './config';
import type { Account, Entry, Listing, Opened, Saved } from './drive';
import { CloudError } from './errors';
import { GoogleDrive } from './gdrive';
import { authorised, unauthorised } from './http';
import type { Transport } from './http';
import { googleServer, oneDriveServer, redeemForm, Session } from './oauth';
import type { AuthServer, TokenBroker } from './oauth';
import { OneDrive } from './onedrive';
import { browserSignIn, desktopSignIn } from './signin';
import type { HostSignIn, SignedIn } from './signin';

/**
 * One drive as the interface uses it, whichever it is. OneDrive is browsed
 * by folder; with drive.file, Google Drive shows the PDFs and folders the
 * app may open (picked in Google's picker, or saved from the app).
 */
export interface CloudDrive {
  /**
   * Whether the drive is walked from its top, folder by folder, with a place
   * to save at each (OneDrive). Google Drive's list starts from what the
   * person picked, and folders picked there open too.
   */
  readonly folders: boolean;
  account(): Promise<Account>;
  list(folderKey: string | null, next?: string | null): Promise<Listing>;
  search(text: string, next?: string | null): Promise<Listing>;
  open(key: string): Promise<Opened>;
  /** `expected` null replaces whatever is there now. */
  saveRevision(key: string, bytes: ArrayBuffer, expected: string | null): Promise<Saved>;
  saveNew(folderKey: string | null, name: string, bytes: ArrayBuffer, behavior: 'fail' | 'replace' | 'rename'): Promise<Saved>;
  /** What Google's picker gave back, as PDFs and folders (Google Drive only). */
  picked?(ids: readonly string[]): Promise<Entry[]>;
}

/** Where the service runs: the pieces that differ between a browser and the desktop app. */
export interface CloudHost {
  desktop: boolean;
  transport: Transport;
  broker: TokenBroker;
  /** The desktop's loopback sign-in; `null` in a browser, which signs in in a pop-up. */
  signIn: HostSignIn | null;
}

/** Google Drive has no names to collide: a second file of the same name is simply another file. */
function pdfName(name: string): string {
  const trimmed = name.trim() || 'document';
  return /\.pdf$/i.test(trimmed) ? trimmed : `${trimmed}.pdf`;
}

export class CloudService {
  readonly providers: readonly ProviderId[];
  private readonly servers = new Map<ProviderId, AuthServer>();
  private readonly sessions = new Map<ProviderId, Session>();

  constructor(
    config: CloudConfig,
    readonly host: CloudHost,
  ) {
    this.providers = offeredProviders(config, host.desktop);
    if (config.onedrive && this.providers.includes('onedrive')) this.servers.set('onedrive', oneDriveServer(config.onedrive));
    if (config.gdrive && this.providers.includes('gdrive')) this.servers.set('gdrive', googleServer(config.gdrive));
    for (const [provider, server] of this.servers) this.sessions.set(provider, new Session(server, host.broker));
  }

  private server(provider: ProviderId): AuthServer {
    const server = this.servers.get(provider);
    if (!server) throw new CloudError('denied', `${provider} is not offered by this build`);
    return server;
  }

  private session(provider: ProviderId): Session {
    this.server(provider);
    return this.sessions.get(provider) as Session;
  }

  drive(provider: ProviderId): CloudDrive {
    const api = authorised(this.session(provider), this.host.transport);
    if (provider === 'onedrive') {
      const drive = new OneDrive(api, unauthorised(provider, this.host.transport));
      return {
        folders: true,
        account: () => drive.account(),
        list: (folder, next) => drive.list(folder, next),
        search: (text, next) => drive.search(text, next),
        open: (key) => drive.open(key),
        saveRevision: (key, bytes, expected) => drive.saveRevision(key, bytes, expected),
        saveNew: (folder, name, bytes, behavior) => drive.saveNew(folder, name, bytes, behavior),
      };
    }
    const drive = new GoogleDrive(api);
    return {
      folders: false,
      account: () => drive.account(),
      list: (folder, next) => drive.list({ folder }, next),
      search: (text, next) => drive.list({ text }, next),
      picked: (ids) => drive.entries(ids),
      open: (key) => drive.open(key),
      saveRevision: (key, bytes, expected) => drive.saveRevision(key, bytes, expected),
      saveNew: (folder, name, bytes) => drive.saveNew(folder, pdfName(name), bytes),
    };
  }

  /**
   * Signs in: in `popup` in a browser (opened in the person's click), in the
   * system browser on the desktop. `extra` asks Google for its picker. The
   * code is redeemed, and the account read, before this answers; the
   * redirect's parameters come back too (Google's `picked_file_ids`).
   */
  async signIn(
    provider: ProviderId,
    options: { popup?: Window; extra?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<{ account: Account; params: Record<string, string> }> {
    const server = this.server(provider);
    let signed: SignedIn;
    if (this.host.signIn) signed = await desktopSignIn(this.host.signIn, server, options.extra);
    else if (options.popup) signed = await browserSignIn(options.popup, server, options.extra, options.signal);
    else throw new CloudError('popupBlocked');
    const token = await this.host.broker.redeem(server, redeemForm(server, signed.callback, signed.redirectUri, signed.verifier));
    const session = this.session(provider);
    session.accept(token);
    const account = await this.drive(provider).account();
    return { account, params: signed.callback.params };
  }

  /** Ends a desktop sign-in under way (the browser tab then finds nothing). */
  async cancelSignIn(): Promise<void> {
    await this.host.signIn?.cancel().catch(() => undefined);
  }

  /** Whether a request can be made without signing in: a token in hand, or one kept to refresh. */
  async ready(provider: ProviderId): Promise<boolean> {
    return this.session(provider).hasToken || (await this.host.broker.kept(provider));
  }

  /** Forgets the sign-in (revoking it where the provider can). Answers whether it was revoked. */
  async signOut(provider: ProviderId): Promise<boolean> {
    this.session(provider).clear();
    return this.host.broker.forget(this.server(provider));
  }
}
