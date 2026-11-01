import type { ProviderId } from './config';
import { CloudError, kindOf, needsAdminConsent } from './errors';
import { jsonOf, ok } from './http';
import type { CloudResponse, Transport } from './http';
import { parseTokenAnswer, refreshForm } from './oauth';
import type { AccessToken, AuthServer, TokenBroker } from './oauth';
import { readKeptSession, writeKeptSession } from './store';
import type { KeptSession } from './store';

/**
 * The browser's token broker: the page calls the token endpoint itself
 * (Microsoft answers a registered single-page app's origin with CORS), and
 * the refresh token stays in memory — gone with the tab — unless the person
 * chose to stay signed in, when it is also kept in this browser's storage,
 * for as long as Microsoft honours it (24 hours).
 */
export class BrowserBroker implements TokenBroker {
  private readonly held = new Map<ProviderId, KeptSession>();
  private readonly staying = new Set<ProviderId>();

  constructor(
    private readonly transport: Transport,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether the next sign-in to `provider` is kept in this browser; turning it off forgets what was kept. */
  staySignedIn(provider: ProviderId, stay: boolean): void {
    if (stay) {
      this.staying.add(provider);
      const held = this.held.get(provider);
      if (held) writeKeptSession(provider, held);
    } else {
      this.staying.delete(provider);
      writeKeptSession(provider, null);
    }
  }

  isStaying(provider: ProviderId): boolean {
    return this.staying.has(provider) || readKeptSession(provider, this.now()) !== null;
  }

  private session(provider: ProviderId): KeptSession | null {
    const held = this.held.get(provider);
    if (held) return held;
    const kept = readKeptSession(provider, this.now());
    if (kept) {
      this.held.set(provider, kept);
      this.staying.add(provider);
    }
    return kept;
  }

  private keep(provider: ProviderId, session: KeptSession | null): void {
    if (session) this.held.set(provider, session);
    else this.held.delete(provider);
    if (this.staying.has(provider)) writeKeptSession(provider, session);
  }

  private async post(server: AuthServer, form: Record<string, string>): Promise<CloudResponse> {
    return this.transport(server.provider, {
      method: 'POST',
      url: server.tokenUrl,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  }

  async redeem(server: AuthServer, form: Record<string, string>): Promise<AccessToken> {
    const response = await this.post(server, form);
    if (!ok(response)) throw tokenFailure(response);
    const answer = parseTokenAnswer(jsonOf(response), this.now());
    this.keep(server.provider, answer.refreshToken ? { refreshToken: answer.refreshToken, signedInAt: this.now() } : null);
    return { token: answer.token, expiresAt: answer.expiresAt };
  }

  async refresh(server: AuthServer): Promise<AccessToken> {
    const kept = this.session(server.provider);
    if (!kept) throw new CloudError('signedOut', 'no sign-in in this browser');
    const response = await this.post(server, { ...refreshForm(server), refresh_token: kept.refreshToken });
    if (!ok(response)) {
      const error = tokenFailure(response);
      if (error.kind === 'signedOut') this.keep(server.provider, null);
      throw error;
    }
    const answer = parseTokenAnswer(jsonOf(response), this.now());
    // Microsoft rotates the refresh token; its 24 hours still run from the sign-in.
    if (answer.refreshToken) this.keep(server.provider, { refreshToken: answer.refreshToken, signedInAt: kept.signedInAt });
    return { token: answer.token, expiresAt: answer.expiresAt };
  }

  /** Microsoft offers a browser app no revocation: signing out forgets the token here. */
  async forget(server: AuthServer): Promise<boolean> {
    this.held.delete(server.provider);
    writeKeptSession(server.provider, null);
    return false;
  }

  async kept(provider: ProviderId): Promise<boolean> {
    return this.session(provider) !== null;
  }
}

/** A token endpoint's refusal: `invalid_grant` means the sign-in is over. */
function tokenFailure(response: CloudResponse): CloudError {
  let error = '';
  let description = '';
  try {
    const body = jsonOf<{ error?: unknown; error_description?: unknown }>(response);
    error = typeof body.error === 'string' ? body.error : '';
    description = typeof body.error_description === 'string' ? body.error_description : '';
  } catch {
    /* not JSON */
  }
  const kind = needsAdminConsent(description)
    ? 'adminConsent'
    : error === 'invalid_grant' || response.status === 401
      ? 'signedOut'
      : response.status >= 500
        ? 'server'
        : 'denied';
  return new CloudError(kind, `token ${response.status} ${error}: ${description}`);
}

/** What the desktop host offers the broker (`core/host-tauri.ts`). */
export interface HostTokens {
  token(provider: ProviderId, url: string, form: Record<string, string>): Promise<unknown>;
  hasSession(provider: ProviderId): Promise<boolean>;
  forget(provider: ProviderId, revokeUrl?: string): Promise<boolean>;
}

/**
 * The desktop's token broker: the host redeems and refreshes, keeps the
 * refresh token in the system keychain, and hands the page the access token
 * only.
 */
export class HostBroker implements TokenBroker {
  constructor(
    private readonly host: HostTokens,
    private readonly now: () => number = Date.now,
  ) {}

  private async call(server: AuthServer, form: Record<string, string>): Promise<AccessToken> {
    try {
      const answer = parseTokenAnswer(await this.host.token(server.provider, server.tokenUrl, form), this.now());
      return { token: answer.token, expiresAt: answer.expiresAt };
    } catch (error) {
      if (error instanceof CloudError) throw error;
      const kind = kindOf(error);
      throw new CloudError(kind === 'server' && String(error).includes('E_CLOUD_TOKEN') ? 'denied' : kind, String(error));
    }
  }

  redeem(server: AuthServer, form: Record<string, string>): Promise<AccessToken> {
    return this.call(server, form);
  }

  refresh(server: AuthServer): Promise<AccessToken> {
    return this.call(server, refreshForm(server));
  }

  async forget(server: AuthServer): Promise<boolean> {
    return this.host.forget(server.provider, server.revokeUrl);
  }

  kept(provider: ProviderId): Promise<boolean> {
    return this.host.hasSession(provider);
  }
}
