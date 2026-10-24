import { describe, expect, it } from 'vitest';
import { CloudError } from './errors';
import {
  EXPIRY_MARGIN_MS,
  Session,
  authorizeUrl,
  googlePicker,
  googleServer,
  oneDriveServer,
  paramsOf,
  parseTokenAnswer,
  readCallback,
  redeemForm,
  refreshForm,
} from './oauth';
import type { AccessToken, AuthServer, TokenBroker } from './oauth';

const onedrive = oneDriveServer({ clientId: '0b3f6a2e-1c1d-4c55-9d5e-2a9f5e0c1d22', tenant: 'common' });
const google = googleServer({ clientId: '123456789012-abcdefghijklmnop.apps.googleusercontent.com' });

describe('the authorization request', () => {
  it('asks Microsoft for a code with PKCE (S256), the Graph scopes and a refresh token, and no secret', () => {
    const url = new URL(
      authorizeUrl(onedrive, { redirectUri: 'https://pdf.example/oauth-callback.html', state: 'S'.repeat(32), challenge: 'C'.repeat(43) }),
    );
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    const params = Object.fromEntries(url.searchParams);
    expect(params).toEqual({
      client_id: '0b3f6a2e-1c1d-4c55-9d5e-2a9f5e0c1d22',
      response_type: 'code',
      redirect_uri: 'https://pdf.example/oauth-callback.html',
      scope: 'Files.ReadWrite User.Read offline_access',
      state: 'S'.repeat(32),
      code_challenge: 'C'.repeat(43),
      code_challenge_method: 'S256',
      response_mode: 'query',
      prompt: 'select_account',
    });
  });

  it('asks Google for drive.file only, offline, with its picker in the consent screen', () => {
    const open = Object.fromEntries(
      new URL(authorizeUrl(google, { redirectUri: 'http://127.0.0.1:50001/callback', state: 's', challenge: 'c', extra: googlePicker('open') }))
        .searchParams,
    );
    expect(open).toMatchObject({
      scope: 'https://www.googleapis.com/auth/drive.file',
      access_type: 'offline',
      prompt: 'consent',
      trigger_onepick: 'true',
      allow_multiple: 'true',
      allow_folder_selection: 'true',
      mimetypes: 'application/pdf,application/vnd.google-apps.folder',
      code_challenge_method: 'S256',
      redirect_uri: 'http://127.0.0.1:50001/callback',
    });
    expect(open).not.toHaveProperty('client_secret');
    expect(googlePicker('folder')).toEqual({
      trigger_onepick: 'true',
      allow_folder_selection: 'true',
      mimetypes: 'application/vnd.google-apps.folder',
    });
  });

  it('puts a tenant in Microsoft’s path encoded', () => {
    expect(oneDriveServer({ clientId: 'x', tenant: 'contoso.onmicrosoft.com' }).tokenUrl).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token',
    );
  });
});

describe('the answer to the redirect URI', () => {
  it('is taken only with this sign-in’s state', () => {
    expect(readCallback({ code: 'C', state: 'mine' }, 'mine')).toEqual({ code: 'C', params: { code: 'C', state: 'mine' } });
    expect(() => readCallback({ code: 'C', state: 'theirs' }, 'mine')).toThrow(CloudError);
    expect(() => readCallback({ code: 'C' }, 'mine')).toThrow(/state/);
  });

  it('says a declined consent is a cancellation, another error a refusal, no code neither', () => {
    const kind = (params: Record<string, string>) => {
      try {
        readCallback(params, 'mine');
        return 'none';
      } catch (error) {
        return (error as CloudError).kind;
      }
    };
    expect(kind({ state: 'mine', error: 'access_denied', error_description: 'the user cancelled' })).toBe('cancelled');
    expect(kind({ state: 'mine', error: 'unauthorized_client' })).toBe('denied');
    expect(kind({ state: 'mine' })).toBe('denied');
  });

  it('reads the query, and the fragment where a provider puts it there', () => {
    expect(paramsOf('https://pdf.example/oauth-callback.html?code=a%2Bb&state=s')).toEqual({ code: 'a+b', state: 's' });
    expect(paramsOf('https://pdf.example/cb#code=x&state=s')).toEqual({ code: 'x', state: 's' });
    expect(paramsOf('https://pdf.example/cb?state=q#state=f')).toEqual({ state: 'q' });
  });
});

describe('tokens', () => {
  it('reads a token endpoint’s answer into a token and when it runs out', () => {
    expect(parseTokenAnswer({ access_token: 'AT', expires_in: 3599, refresh_token: 'RT' }, 1_000)).toEqual({
      token: 'AT',
      expiresAt: 1_000 + 3_599_000,
      refreshToken: 'RT',
    });
    expect(parseTokenAnswer({ access_token: 'AT', expires_in: '3600' }, 0).expiresAt).toBe(3_600_000);
    expect(parseTokenAnswer({ access_token: 'AT' }, 0).expiresAt).toBe(3_600_000);
    expect(() => parseTokenAnswer({ token_type: 'Bearer' }, 0)).toThrow(CloudError);
    expect(() => parseTokenAnswer(null, 0)).toThrow(CloudError);
  });

  it('redeems with the verifier and never a secret, and refreshes without the refresh token (the broker adds it)', () => {
    const form = redeemForm(onedrive, { code: 'C', params: {} }, 'https://pdf.example/oauth-callback.html', 'V');
    expect(form).toEqual({
      grant_type: 'authorization_code',
      client_id: onedrive.clientId,
      code: 'C',
      redirect_uri: 'https://pdf.example/oauth-callback.html',
      code_verifier: 'V',
      scope: onedrive.scope,
    });
    expect(redeemForm(google, { code: 'C', params: {} }, 'http://127.0.0.1:1/callback', 'V')).not.toHaveProperty('scope');
    expect(refreshForm(onedrive)).toEqual({ grant_type: 'refresh_token', client_id: onedrive.clientId, scope: onedrive.scope });
    for (const f of [form, refreshForm(google)]) {
      expect(f).not.toHaveProperty('client_secret');
      expect(f).not.toHaveProperty('refresh_token');
    }
  });
});

/** A broker whose refreshes are counted and answered when the test says. */
function slowBroker(now: () => number) {
  const calls: string[] = [];
  let release: (() => void) | null = null;
  const broker: TokenBroker = {
    redeem: async () => ({ token: 'first', expiresAt: now() + 3_600_000 }),
    refresh: async (server: AuthServer): Promise<AccessToken> => {
      calls.push(server.provider);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { token: `refreshed-${calls.length}`, expiresAt: now() + 3_600_000 };
    },
    forget: async () => false,
    kept: async () => true,
  };
  return { broker, calls, release: () => release?.() };
}

describe('a session’s access token', () => {
  it('is the one in hand while it is good, and a refreshed one once it is nearly out', async () => {
    let clock = 0;
    const { broker, calls, release } = slowBroker(() => clock);
    const session = new Session(onedrive, broker, () => clock);
    session.accept({ token: 'first', expiresAt: 3_600_000 });
    expect(await session.accessToken()).toBe('first');
    clock = 3_600_000 - EXPIRY_MARGIN_MS + 1;
    const next = session.accessToken();
    await Promise.resolve();
    release();
    expect(await next).toBe('refreshed-1');
    expect(calls).toEqual(['onedrive']);
  });

  it('is refreshed once however many requests wait for it', async () => {
    const { broker, calls, release } = slowBroker(() => 0);
    const session = new Session(onedrive, broker, () => 0);
    const waiting = [session.accessToken(), session.accessToken(), session.accessToken()];
    await Promise.resolve();
    release();
    expect(await Promise.all(waiting)).toEqual(['refreshed-1', 'refreshed-1', 'refreshed-1']);
    expect(calls).toHaveLength(1);
  });

  it('is refreshed after the drive refuses it, and not after it refuses an older one', async () => {
    const { broker, calls, release } = slowBroker(() => 0);
    const session = new Session(onedrive, broker, () => 0);
    session.accept({ token: 'first', expiresAt: 3_600_000 });
    session.invalidate('some other token');
    expect(await session.accessToken()).toBe('first');
    session.invalidate('first');
    const next = session.accessToken();
    await Promise.resolve();
    release();
    expect(await next).toBe('refreshed-1');
    expect(calls).toHaveLength(1);
  });
});
