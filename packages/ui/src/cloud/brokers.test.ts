import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserBroker, HostBroker } from './brokers';
import { googleServer, oneDriveServer } from './oauth';
import { BROWSER_SESSION_MS, readKeptSession } from './store';
import { recording, reply } from './testing';

const onedrive = oneDriveServer({ clientId: '0b3f6a2e-1c1d-4c55-9d5e-2a9f5e0c1d22', tenant: 'common' });
const google = googleServer({ clientId: '123456789012-abcdefghijklmnop.apps.googleusercontent.com' });

/** This browser's storage, for the tests (vitest runs in Node). */
class MemoryStorage {
  private readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  get keys() {
    return [...this.items.keys()];
  }
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

const form = (body: unknown) => Object.fromEntries(new URLSearchParams(body as string));

function tokenEndpoint() {
  let issued = 0;
  return recording((request) => {
    const sent = form(request.body);
    if (sent.grant_type === 'refresh_token' && sent.refresh_token === 'refused') return reply(400, { error: 'invalid_grant', error_description: 'AADSTS700084' });
    issued += 1;
    return reply(200, { access_token: `AT${issued}`, expires_in: 3599, refresh_token: `RT${issued}` });
  });
}

describe('the browser’s tokens', () => {
  it('keeps the refresh token in memory only, unless the person chose to stay signed in', async () => {
    let now = 1_000_000;
    const { transport, seen } = tokenEndpoint();
    const broker = new BrowserBroker(transport, () => now);
    await broker.redeem(onedrive, { grant_type: 'authorization_code', code: 'C' });
    expect(storage.keys).toEqual([]);
    expect(await broker.kept('onedrive')).toBe(true);

    const token = await broker.refresh(onedrive);
    expect(token.token).toBe('AT2');
    expect(form(seen[1]?.body)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'RT1', client_id: onedrive.clientId });
    expect(seen[1]?.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });

    // A new tab knows nothing of it.
    expect(await new BrowserBroker(transport, () => now).kept('onedrive')).toBe(false);

    broker.staySignedIn('onedrive', true);
    expect(readKeptSession('onedrive', now)?.refreshToken).toBe('RT2');
    expect(await new BrowserBroker(transport, () => now).kept('onedrive')).toBe(true);

    // Microsoft ends a browser app's sign-in 24 hours after it began, refreshed or not.
    now += 60_000;
    await broker.refresh(onedrive);
    expect(readKeptSession('onedrive', now)?.signedInAt).toBe(1_000_000);
    now = 1_000_000 + BROWSER_SESSION_MS;
    expect(await new BrowserBroker(transport, () => now).kept('onedrive')).toBe(false);
    expect(storage.keys).toEqual([]);
  });

  it('forgets what it kept when staying signed in is turned off, or on signing out', async () => {
    const { transport } = tokenEndpoint();
    const broker = new BrowserBroker(transport);
    broker.staySignedIn('onedrive', true);
    await broker.redeem(onedrive, { grant_type: 'authorization_code', code: 'C' });
    expect(storage.keys).toEqual(['warraq.cloud.session.onedrive']);
    broker.staySignedIn('onedrive', false);
    expect(storage.keys).toEqual([]);
    broker.staySignedIn('onedrive', true);
    expect(storage.keys).toHaveLength(1);
    expect(await broker.forget(onedrive)).toBe(false);
    expect(storage.keys).toEqual([]);
    expect(await broker.kept('onedrive')).toBe(false);
  });

  it('is signed out when the refresh is refused, and cannot refresh what it never had', async () => {
    const { transport, seen } = recording(() => reply(400, { error: 'invalid_grant' }));
    const broker = new BrowserBroker(transport);
    await expect(broker.refresh(onedrive)).rejects.toMatchObject({ kind: 'signedOut' });
    expect(seen).toHaveLength(0);
    storage.setItem('warraq.cloud.session.onedrive', JSON.stringify({ refreshToken: 'refused', signedInAt: Date.now() }));
    await expect(broker.refresh(onedrive)).rejects.toMatchObject({ kind: 'signedOut' });
    expect(storage.keys).toEqual([]);
  });

  it('ignores storage that is not a session it wrote', async () => {
    storage.setItem('warraq.cloud.session.onedrive', '{"refreshToken":5}');
    expect(readKeptSession('onedrive')).toBeNull();
    storage.setItem('warraq.cloud.session.onedrive', 'not json');
    expect(readKeptSession('onedrive')).toBeNull();
    storage.setItem('warraq.cloud.session.onedrive', JSON.stringify({ refreshToken: 'x', signedInAt: Date.now() + 10 * 60_000 }));
    expect(readKeptSession('onedrive')).toBeNull();
  });
});

describe('the desktop’s tokens', () => {
  it('leaves the refresh token to the host and takes the access token it answers', async () => {
    const calls: unknown[][] = [];
    const broker = new HostBroker(
      {
        token: async (...args) => {
          calls.push(args);
          return { access_token: 'AT', expires_in: 3599 };
        },
        hasSession: async () => true,
        forget: async (...args) => {
          calls.push(args);
          return true;
        },
      },
      () => 0,
    );
    expect(await broker.refresh(google)).toEqual({ token: 'AT', expiresAt: 3_599_000 });
    expect(calls[0]).toEqual(['gdrive', 'https://oauth2.googleapis.com/token', { grant_type: 'refresh_token', client_id: google.clientId }]);
    expect(await broker.forget(google)).toBe(true);
    expect(calls[1]).toEqual(['gdrive', 'https://oauth2.googleapis.com/revoke']);
  });

  it('turns the host’s errors into what the interface says', async () => {
    const failing = (message: string) =>
      new HostBroker({
        token: async () => {
          throw new Error(message);
        },
        hasSession: async () => false,
        forget: async () => false,
      });
    await expect(failing('E_CLOUD_SIGNED_OUT: expired').refresh(onedrive)).rejects.toMatchObject({ kind: 'signedOut' });
    await expect(failing('E_NET: offline').refresh(onedrive)).rejects.toMatchObject({ kind: 'network' });
    await expect(failing('E_CLOUD_TOKEN 400: invalid_request: client_secret is missing.').redeem(google, {})).rejects.toMatchObject({
      kind: 'denied',
    });
  });
});
