import type { GoogleConfig, OneDriveConfig, ProviderId } from './config';
import { CloudError } from './errors';

/**
 * OAuth 2.0 authorization code grant with PKCE (RFC 6749 §4.1, RFC 7636),
 * for a public client: what is the same for both drives and both hosts. The
 * browser build signs in through a pop-up (`web.ts`), the desktop through
 * the system browser and a loopback listener (`desktop.ts`); both then call
 * the token endpoint through a `TokenBroker`, which is where they differ in
 * what they keep.
 */

/** One drive's authorization server and the app registered there. */
export interface AuthServer {
  provider: ProviderId;
  authorizeUrl: string;
  tokenUrl: string;
  /** Where a token is revoked on sign-out; Microsoft offers a public client none. */
  revokeUrl?: string;
  clientId: string;
  scope: string;
  /** Always sent with the authorization request. */
  extra: Record<string, string>;
}

/**
 * Microsoft identity platform v2: Files.ReadWrite to open and save the
 * person's files (AppFolder would reach only a folder of the app's own, not
 * the PDFs they already have), User.Read for their name, offline_access for
 * a refresh token.
 */
export function oneDriveServer(config: OneDriveConfig): AuthServer {
  const base = `https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}/oauth2/v2.0`;
  return {
    provider: 'onedrive',
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    clientId: config.clientId,
    scope: 'Files.ReadWrite User.Read offline_access',
    // The account picker every time: the person may have several.
    extra: { response_mode: 'query', prompt: 'select_account' },
  };
}

/**
 * Google, drive.file only: the app sees the files the person picks in
 * Google's picker or saves from the app, nothing else. The picker is part of
 * the consent screen (`trigger_onepick`, Google's picker for desktop apps),
 * so each open is a sign-in; `access_type=offline` asks for a refresh token.
 */
export function googleServer(config: GoogleConfig): AuthServer {
  return {
    provider: 'gdrive',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    clientId: config.clientId,
    scope: 'https://www.googleapis.com/auth/drive.file',
    extra: { access_type: 'offline', prompt: 'consent' },
  };
}

/**
 * Microsoft's page for one kind of account. One e-mail can be both a
 * personal Microsoft account and a work account, each with its own OneDrive
 * (owner, 2026-11-01: ZOOD showed his personal OneDrive, not his work one).
 */
export function oneDriveAccountHint(kind: 'business' | 'personal'): Record<string, string> {
  return { domain_hint: kind === 'business' ? 'organizations' : 'consumers' };
}

/**
 * Google's picker in the consent screen: PDFs and folders to open, as many
 * as the person likes, or one folder to save into.
 */
export function googlePicker(purpose: 'open' | 'folder'): Record<string, string> {
  return purpose === 'open'
    ? { trigger_onepick: 'true', allow_multiple: 'true', allow_folder_selection: 'true', mimetypes: 'application/pdf,application/vnd.google-apps.folder' }
    : { trigger_onepick: 'true', allow_folder_selection: 'true', mimetypes: 'application/vnd.google-apps.folder' };
}

export interface AuthorizeRequest {
  redirectUri: string;
  state: string;
  challenge: string;
  /** Parameters of this request only (Google's picker). */
  extra?: Record<string, string>;
}

/** The authorization request the person's browser is sent to. */
export function authorizeUrl(server: AuthServer, request: AuthorizeRequest): string {
  const url = new URL(server.authorizeUrl);
  const params: Record<string, string> = {
    client_id: server.clientId,
    response_type: 'code',
    redirect_uri: request.redirectUri,
    scope: server.scope,
    state: request.state,
    code_challenge: request.challenge,
    code_challenge_method: 'S256',
    ...server.extra,
    ...request.extra,
  };
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.href;
}

/** What came back to the redirect URI, once it is known to be this sign-in's answer. */
export interface Callback {
  code: string;
  params: Record<string, string>;
}

/**
 * The redirect's parameters, checked: the state must be exactly the one sent
 * (anything else is someone else's answer and is refused), an `error` is the
 * provider's refusal, and there must be a code.
 */
export function readCallback(params: Record<string, string>, expectedState: string): Callback {
  if (params.state !== expectedState) throw new CloudError('state');
  if (params.error) {
    const detail = [params.error, params.error_description].filter(Boolean).join(': ');
    throw new CloudError(params.error === 'access_denied' ? 'cancelled' : 'denied', detail);
  }
  if (!params.code) throw new CloudError('denied', 'the answer carried no code');
  return { code: params.code, params };
}

/** A redirect URL's query and fragment as one set of parameters (the query wins). */
export function paramsOf(url: string): Record<string, string> {
  const parsed = new URL(url);
  const params: Record<string, string> = {};
  const add = (search: string) => {
    for (const [name, value] of new URLSearchParams(search)) if (!(name in params)) params[name] = value;
  };
  add(parsed.search);
  add(parsed.hash.replace(/^#/, ''));
  return params;
}

/** An access token, and until when it is good. */
export interface AccessToken {
  token: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

/** A token endpoint's answer, with its refresh token when the broker hands it on (the browser's). */
export interface TokenAnswer extends AccessToken {
  refreshToken?: string;
}

/** Reads a token endpoint's JSON; `now` in milliseconds. */
export function parseTokenAnswer(json: unknown, now: number): TokenAnswer {
  const fields = (json ?? {}) as Record<string, unknown>;
  if (typeof fields.access_token !== 'string' || fields.access_token.length === 0) {
    throw new CloudError('server', 'the token endpoint sent no access token');
  }
  const seconds = typeof fields.expires_in === 'number' ? fields.expires_in : Number(fields.expires_in ?? 3600);
  const lifetime = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 24 * 3600) : 3600;
  return {
    token: fields.access_token,
    expiresAt: now + lifetime * 1000,
    refreshToken: typeof fields.refresh_token === 'string' ? fields.refresh_token : undefined,
  };
}

/** The form that redeems a code (no secret: this is a public client). */
export function redeemForm(server: AuthServer, callback: Callback, redirectUri: string, verifier: string): Record<string, string> {
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: server.clientId,
    code: callback.code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  };
  // Microsoft names the resource the token is for; Google takes the scope from the grant.
  if (server.provider === 'onedrive') form.scope = server.scope;
  return form;
}

/** The form that refreshes, without the refresh token itself: the broker adds it. */
export function refreshForm(server: AuthServer): Record<string, string> {
  const form: Record<string, string> = { grant_type: 'refresh_token', client_id: server.clientId };
  if (server.provider === 'onedrive') form.scope = server.scope;
  return form;
}

/**
 * Where a host keeps the refresh token and how it reaches the token
 * endpoint: the browser holds it in memory (or, if the person chose to stay
 * signed in, in this browser's storage); the desktop app keeps it in the
 * system keychain and never hands it to the page.
 */
export interface TokenBroker {
  /** Redeems a code, keeping the refresh token the host's way. */
  redeem(server: AuthServer, form: Record<string, string>): Promise<AccessToken>;
  /** A new access token from the kept refresh token; `CloudError('signedOut')` when there is none or it is refused. */
  refresh(server: AuthServer): Promise<AccessToken>;
  /** Signs out: revokes where the provider can, and forgets. Answers whether the provider confirmed. */
  forget(server: AuthServer): Promise<boolean>;
  /** Whether a refresh token is kept, without using it. */
  kept(provider: ProviderId): Promise<boolean>;
}

/** How long before it runs out an access token is replaced: a request must not outlive it. */
export const EXPIRY_MARGIN_MS = 2 * 60 * 1000;

/**
 * The access token of one drive: the one in hand while it is good, else one
 * refresh — never two at once, however many requests wait for it.
 */
export class Session {
  private current: AccessToken | null = null;
  private refreshing: Promise<AccessToken> | null = null;

  constructor(
    readonly server: AuthServer,
    private readonly broker: TokenBroker,
    private readonly now: () => number = Date.now,
  ) {}

  /** After a sign-in: the token it brought. */
  accept(token: AccessToken): void {
    this.current = token;
  }

  get hasToken(): boolean {
    return this.current !== null;
  }

  async accessToken(): Promise<string> {
    if (this.current && this.current.expiresAt - EXPIRY_MARGIN_MS > this.now()) return this.current.token;
    if (!this.refreshing) {
      this.refreshing = this.broker
        .refresh(this.server)
        .then((token) => {
          this.current = token;
          return token;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return (await this.refreshing).token;
  }

  /** The drive refused `token` (401): the next request refreshes. */
  invalidate(token: string): void {
    if (this.current?.token === token) this.current = null;
  }

  clear(): void {
    this.current = null;
  }
}
