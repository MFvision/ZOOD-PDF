import { describe, expect, it } from 'vitest';
import { challengeOf } from './pkce';
import { googlePicker, oneDriveAccountHint } from './oauth';
import { CloudService } from './service';
import type { CloudHost } from './service';
import type { HostSignIn } from './signin';
import { recording, reply } from './testing';

const APP = '0b3f6a2e-1c1d-4c55-9d5e-2a9f5e0c1d22';
const GOOGLE = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
const PICKED = '1AbCdEfGhIjKlMnOpQrStUv';

/**
 * A stand-in for the desktop host and the person at the browser: the
 * listener's port, the browser sent to the authorization URL, and the
 * provider sending it back — with the state it was given, or not.
 */
function desktop(answer: (params: URLSearchParams) => Record<string, string>) {
  const opened: string[] = [];
  let waitingFor = '';
  const signIn: HostSignIn = {
    listen: async () => 50123,
    open: async (url) => {
      opened.push(url);
    },
    // The browser comes back once the host waits for it.
    wait: async (state) => {
      waitingFor = state;
      return answer(new URL(opened.at(-1) ?? 'https://x').searchParams);
    },
    cancel: async () => undefined,
  };
  const redeemed: Record<string, string>[] = [];
  const broker: CloudHost['broker'] = {
    redeem: async (_server, form) => {
      redeemed.push(form);
      return { token: 'AT', expiresAt: Date.now() + 3_600_000 };
    },
    refresh: async () => ({ token: 'AT', expiresAt: Date.now() + 3_600_000 }),
    forget: async () => true,
    kept: async () => false,
  };
  const { transport, seen } = recording((request) =>
    request.url.includes('/me?')
      ? reply(200, { displayName: 'سارة', mail: 'sara@example.com' })
      : reply(200, { user: { displayName: 'Sara', emailAddress: 'sara@example.org' } }),
  );
  const service = new CloudService(
    { onedrive: { clientId: APP, tenant: 'common' }, gdrive: { clientId: GOOGLE } },
    { desktop: true, transport, broker, signIn },
  );
  return { service, opened, redeemed, seen, waitingFor: () => waitingFor };
}

describe('signing in on the desktop', () => {
  it('sends the browser to Microsoft with a loopback redirect and PKCE, and redeems the code with the verifier', async () => {
    const { service, opened, redeemed, seen, waitingFor } = desktop((params) => ({ code: 'CODE', state: params.get('state') ?? '' }));
    const { account } = await service.signIn('onedrive');
    expect(account).toEqual({ name: 'سارة', email: 'sara@example.com' });
    const request = new URL(opened[0] ?? '');
    expect(request.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:50123/callback');
    expect(request.searchParams.get('state')).toBe(waitingFor());
    const form = redeemed[0] ?? {};
    expect(form).toMatchObject({ grant_type: 'authorization_code', code: 'CODE', redirect_uri: 'http://127.0.0.1:50123/callback' });
    expect(await challengeOf(form.code_verifier ?? '')).toBe(request.searchParams.get('code_challenge'));
    expect(seen[0]?.headers?.authorization).toBe('Bearer AT');
  });

  it('sends Microsoft to the chosen kind of account, work or personal', async () => {
    for (const [kind, hint] of [['business', 'organizations'], ['personal', 'consumers']] as const) {
      const { service, opened } = desktop((params) => ({ code: 'CODE', state: params.get('state') ?? '' }));
      await service.signIn('onedrive', { extra: oneDriveAccountHint(kind) });
      expect(new URL(opened[0] ?? '').searchParams.get('domain_hint')).toBe(hint);
    }
  });

  it('asks Google for its picker in the consent screen and hands back the file picked', async () => {
    const { service, opened } = desktop((params) => ({
      code: 'G',
      state: params.get('state') ?? '',
      picked_file_ids: PICKED,
      scope: 'https://www.googleapis.com/auth/drive.file',
    }));
    const { account, params } = await service.signIn('gdrive', { extra: googlePicker('open') });
    expect(account.email).toBe('sara@example.org');
    expect(params.picked_file_ids).toBe(PICKED);
    const request = new URL(opened[0] ?? '');
    expect(request.origin + request.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(request.searchParams.get('trigger_onepick')).toBe('true');
  });

  it('refuses an answer with another state, and says a declined consent is a cancellation', async () => {
    await expect(desktop(() => ({ code: 'C', state: 'not-this-one' })).service.signIn('onedrive')).rejects.toMatchObject({ kind: 'state' });
    // The host's wait rejects the way `cloud_auth_wait` does.
    const declined = desktop(() => {
      throw new Error('E_CLOUD_DENIED: access_denied: the user declined');
    });
    await expect(declined.service.signIn('onedrive')).rejects.toMatchObject({ kind: 'cancelled' });
    const refused = desktop(() => {
      throw new Error('E_CLOUD_DENIED: unauthorized_client: the app is not registered');
    });
    await expect(refused.service.signIn('onedrive')).rejects.toMatchObject({ kind: 'denied' });
    const late = desktop(() => {
      throw new Error('E_CLOUD_TIMEOUT: the browser did not come back in time');
    });
    await expect(late.service.signIn('onedrive')).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('offers in a browser only what a browser can do', () => {
    const { transport } = recording(() => reply(200));
    const browser = new CloudService(
      { onedrive: { clientId: APP, tenant: 'common' }, gdrive: { clientId: GOOGLE } },
      { desktop: false, transport, broker: desktop(() => ({})).service.host.broker, signIn: null },
    );
    expect(browser.providers).toEqual(['onedrive']);
    expect(() => browser.drive('gdrive')).toThrow();
  });
});
