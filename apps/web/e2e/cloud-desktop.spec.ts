import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { build } from 'vite';
import { FakeGoogle, FakeMicrosoft, GOOGLE_CLIENT_ID, MS_CLIENT_ID } from './cloudFakes';
import type { FakeRequest, FakeResponse } from './cloudFakes';

/**
 * The desktop app's cloud path, in a real browser but without its interface:
 * the service, the broker that leaves the refresh token to the host, the
 * transport that sends every request through the host, and the loopback
 * sign-in — all the shipped code — driven against the same stand-ins for
 * Microsoft and Google that `cloud.spec.ts` uses.
 *
 * What answers the host's commands here is this file, written to do what
 * `src-tauri/src/cloud.rs` does (the Rust tests prove that side): a keychain
 * that the page never sees, a one-shot loopback listener that takes only its
 * own state, a token endpoint that refuses a secret or a refresh token from
 * the page, and requests that go only to the drive's own hosts, with no
 * Origin — which is why Microsoft redeems a desktop app's code at all.
 *
 * Google Drive lives here alone: a browser build ships none, because Google
 * redeems no web client's code without a secret (docs/cloud.md).
 */

const HARNESS = fileURLToPath(new URL('fixtures/cloudDesktop.ts', import.meta.url));
const CONFIG = { onedrive: { clientId: MS_CLIENT_ID, tenant: 'common' }, gdrive: { clientId: GOOGLE_CLIENT_ID } };
const LOOPBACK_PORT = 51234;

let bundle = '';

test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'error',
    build: { write: false, minify: false, lib: { entry: HARNESS, formats: ['iife'], name: 'WarraqCloudDesktop' } },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunk = outputs.flatMap((one) => ('output' in one ? one.output : [])).find((part) => part.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('the harness did not build');
  bundle = chunk.code;
});

/* ------------------------------------------------- the host, as Rust does it */

type Answer = Record<string, string>;

/** What `cloud.rs` does for the interface, in the test's own hands. */
class FakeHost {
  /** The system's credential store: the page never sees what is in here. */
  readonly secrets = new Map<string, string>();
  readonly opened: string[] = [];
  private port = 0;
  private answer: Answer | null = null;
  private error: string | null = null;

  constructor(
    readonly microsoft: FakeMicrosoft,
    readonly google: FakeGoogle,
  ) {}

  private provider(name: unknown): 'onedrive' | 'gdrive' {
    if (name !== 'onedrive' && name !== 'gdrive') throw new Error(`E_ARGS: there is no drive called ${String(name)}`);
    return name;
  }

  /** Only the drive's own hosts, over https, as `checked_uri` allows. */
  private checked(provider: 'onedrive' | 'gdrive', url: string): URL {
    const uri = new URL(url);
    const hosts =
      provider === 'onedrive'
        ? [/^login\.microsoftonline\.com$/, /^graph\.microsoft\.com$/, /\.1drv\.com$/, /\.sharepoint\.com$/, /\.microsoftpersonalcontent\.com$/]
        : [/^oauth2\.googleapis\.com$/, /^www\.googleapis\.com$/];
    if (uri.protocol !== 'https:' || !hosts.some((host) => host.test(uri.hostname))) {
      throw new Error(`E_CLOUD_HOST: ${uri.origin} is not one of ${provider}'s addresses`);
    }
    return uri;
  }

  private send(provider: 'onedrive' | 'gdrive', request: FakeRequest): FakeResponse {
    const url = this.checked(provider, request.url);
    if (provider === 'gdrive') return url.hostname === 'oauth2.googleapis.com' ? this.google.token(request) : this.google.drive(request);
    if (url.hostname === 'login.microsoftonline.com') return this.microsoft.token(request);
    if (url.hostname === 'graph.microsoft.com') return this.microsoft.graph(request);
    if (url.hostname.endsWith('.up.1drv.com')) return this.microsoft.upload(request);
    return this.microsoft.download(request);
  }

  /** `cloud_token`: the refresh token is added here and never leaves. */
  private token(args: { provider: unknown; url: unknown; form: Record<string, string> }): string {
    const provider = this.provider(args.provider);
    const form = { ...args.form };
    const refreshing = form.grant_type === 'refresh_token';
    if (!refreshing && form.grant_type !== 'authorization_code') throw new Error('E_ARGS: grant_type must be authorization_code or refresh_token');
    if ('client_secret' in form || 'refresh_token' in form) throw new Error('E_ARGS: refresh tokens and secrets are not sent by the interface');
    if (refreshing) {
      const kept = this.secrets.get(provider);
      if (!kept) throw new Error('E_CLOUD_SIGNED_OUT: no sign-in is kept on this computer');
      form.refresh_token = kept;
    }
    const url = this.checked(provider, String(args.url));
    const answer = this.send(provider, {
      method: 'POST',
      url: url.href,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: Buffer.from(new URLSearchParams(form).toString()),
    });
    const body = JSON.parse(String(answer.body)) as Record<string, unknown>;
    if (answer.status < 200 || answer.status >= 300) {
      if (refreshing && body.error === 'invalid_grant') {
        this.secrets.delete(provider);
        throw new Error(`E_CLOUD_SIGNED_OUT: ${String(body.error_description ?? '')}`);
      }
      throw new Error(`E_CLOUD_TOKEN ${answer.status}: ${String(body.error)}: ${String(body.error_description ?? '')}`);
    }
    if (typeof body.access_token !== 'string') throw new Error(`E_CLOUD_TOKEN ${answer.status}: the answer has no access token`);
    // A new sign-in replaces what was kept; a refresh keeps it unless a new one comes.
    if (!refreshing) this.secrets.delete(provider);
    if (typeof body.refresh_token === 'string') this.secrets.set(provider, body.refresh_token);
    delete body.refresh_token;
    return JSON.stringify(body);
  }

  async command(name: string, args: Record<string, unknown> | null): Promise<unknown> {
    switch (name) {
      case 'cloud_auth_listen':
        this.port = LOOPBACK_PORT;
        this.answer = null;
        this.error = null;
        return this.port;
      case 'open_url': {
        // The system browser: the person signs in, and the provider sends it
        // back to the listener — which takes only its own path and port.
        const url = String(args?.url);
        this.opened.push(url);
        const out = url.startsWith('https://accounts.google.com/') ? this.google.authorize(url) : this.microsoft.authorize(url, ['http://127.0.0.1/callback']);
        if (!('redirect' in out)) {
          this.error = `the provider showed an error page: ${out.status}`;
          return null;
        }
        const back = new URL(out.redirect);
        if (back.hostname !== '127.0.0.1' || Number(back.port) !== this.port || back.pathname !== '/callback') {
          this.error = 'the answer did not come back to this sign-in';
          return null;
        }
        this.answer = Object.fromEntries(back.searchParams);
        return null;
      }
      case 'cloud_auth_wait': {
        const expected = String(args?.expectedState);
        if (this.error || !this.answer) throw new Error(`E_CLOUD_TIMEOUT: ${this.error ?? 'the browser did not come back in time'}`);
        // A state that is not this sign-in's is refused, and none other comes.
        if (this.answer.state !== expected) throw new Error('E_CLOUD_TIMEOUT: the browser did not come back in time');
        if (this.answer.error) throw new Error(`E_CLOUD_DENIED: ${this.answer.error}: ${this.answer.error_description ?? ''}`);
        const answer = this.answer;
        this.answer = null;
        this.port = 0;
        return answer;
      }
      case 'cloud_auth_cancel':
        this.answer = null;
        this.port = 0;
        return null;
      case 'cloud_token':
        return this.token(args as { provider: unknown; url: unknown; form: Record<string, string> });
      case 'cloud_has_session':
        return this.secrets.has(this.provider(args?.provider));
      case 'cloud_forget': {
        const provider = this.provider(args?.provider);
        const kept = this.secrets.get(provider);
        let revoked = false;
        if (kept && args?.revokeUrl) {
          const url = this.checked(provider, String(args.revokeUrl));
          const answer = this.send(provider, {
            method: 'POST',
            url: url.href,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: Buffer.from(new URLSearchParams({ token: kept }).toString()),
          });
          revoked = answer.status >= 200 && answer.status < 300;
        }
        this.secrets.delete(provider);
        return revoked;
      }
      case 'cloud_http': {
        const frame = Buffer.from((args as unknown as { bytes: number[] }).bytes);
        const { json, blobs } = decodeFrame(frame);
        const call = JSON.parse(json) as { provider: string; method: string; url: string; headers: Record<string, string> };
        const provider = this.provider(call.provider);
        const answer = this.send(provider, {
          method: call.method,
          url: this.checked(provider, call.url).href,
          headers: call.headers,
          body: blobs[0] ?? null,
        });
        const body = Buffer.isBuffer(answer.body) ? answer.body : Buffer.from(answer.body);
        return { bytes: [...encodeFrame(JSON.stringify({ status: answer.status, headers: answer.headers }), body)] };
      }
      default:
        throw new Error(`the fake host knows no command ${name}`);
    }
  }
}

/** The frame `core_bridge.rs` and `core/frame.ts` share, on the host's side. */
function encodeFrame(json: string, body: Buffer): Buffer {
  const text = Buffer.from(json, 'utf8');
  const head = Buffer.alloc(8);
  head.writeUInt32LE(text.length, 0);
  head.writeUInt32LE(1, 4);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length, 0);
  return Buffer.concat([head.subarray(0, 4), text, head.subarray(4), length, body]);
}

function decodeFrame(frame: Buffer): { json: string; blobs: Buffer[] } {
  let at = 0;
  const take = (n: number) => {
    const slice = frame.subarray(at, at + n);
    at += n;
    return slice;
  };
  const length = () => take(4).readUInt32LE(0);
  const json = take(length()).toString('utf8');
  const count = length();
  const blobs: Buffer[] = [];
  for (let index = 0; index < count; index += 1) blobs.push(take(length()));
  return { json, blobs };
}

/* ----------------------------------------------------------------- the page */

interface Harness {
  signIn(provider: string, purpose?: 'open' | 'folder'): Promise<{ account?: { name: string; email: string }; picked?: string[]; error?: string }>;
  ready(provider: string): Promise<boolean | { error: string }>;
  list(provider: string, folder: string | null, query?: string): Promise<{ key: string; name: string; kind: string }[] | { error: string }>;
  open(provider: string, key: string): Promise<{ key: string; name: string; version: string; parentKey: string | null; text: string } | { error: string }>;
  saveRevision(provider: string, key: string, version: string | null, body: string): Promise<{ version: string } | { error: string }>;
  saveNew(provider: string, folder: string | null, name: string, body: string): Promise<{ key: string; name: string; parentKey: string | null } | { error: string }>;
  signOut(provider: string): Promise<boolean | { error: string }>;
}



/**
 * Runs one step of the harness in the page. The step travels as its own
 * source, so it takes what it needs as `args` rather than closing over the
 * test's variables.
 */
function run<T, A = undefined>(page: Page, step: (cloud: Harness, args: A) => Promise<T>, args?: A): Promise<T> {
  return page.evaluate(`(${step.toString()})(window.cloudDesktop, ${JSON.stringify(args ?? null)})`) as Promise<T>;
}

/** A page with the desktop's cloud code and this host behind it. */
async function install(page: Page, host: FakeHost, meddle?: (name: string, args: Record<string, unknown> | null) => Record<string, unknown> | null): Promise<void> {
  await page.exposeFunction('hostCommand', (name: string, args: Record<string, unknown> | null) => host.command(name, meddle ? meddle(name, args) : args));
  // A page of the test server's own origin: WebCrypto, which PKCE needs, is
  // there only in a secure context, which `about:blank` is not.
  await page.route('**/cloud-desktop-harness', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>cloud desktop</title><body></body>' }),
  );
  await page.goto('/cloud-desktop-harness');
  await page.evaluate(() => {
    const send = (window as unknown as { hostCommand(name: string, args: unknown): Promise<unknown> }).hostCommand;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      transformCallback: () => 0,
      invoke: async (name: string, args: unknown) => {
        const payload = args instanceof ArrayBuffer ? { bytes: [...new Uint8Array(args)] } : ((args as Record<string, unknown>) ?? null);
        const reply = await send(name, payload);
        if (reply && typeof reply === 'object' && 'bytes' in (reply as Record<string, unknown>)) {
          return new Uint8Array((reply as { bytes: number[] }).bytes).buffer;
        }
        return reply;
      },
    };
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate((config) => {
    (window as unknown as { WarraqCloudDesktop: { install(config: unknown): void } }).WarraqCloudDesktop.install(config);
  }, CONFIG);
}

/* ------------------------------------------------------------------- tests */

test.describe('Google Drive on the desktop', () => {
  test('signing in is choosing the file: the picker in Google’s consent screen, then opening and saving it', async ({ page }) => {
    const google = new FakeGoogle();
    const contract = google.addFile('عقد.pdf', Buffer.from('%PDF-1.7 the contract'));
    google.addFile('unseen.pdf', Buffer.from('%PDF-1.7 not picked'));
    google.pick = 'عقد.pdf';
    const host = new FakeHost(new FakeMicrosoft('http://127.0.0.1'), google);
    await install(page, host);

    const signedIn = await run(page, (cloud) => cloud.signIn('gdrive', 'open'));
    expect(signedIn.error).toBeUndefined();
    expect(signedIn.account).toEqual({ name: 'Sara', email: 'sara@example.org' });
    expect(signedIn.picked).toEqual([contract]);

    // The browser was sent to Google with its picker, drive.file only, PKCE, and a loopback address.
    const asked = new URL(host.opened[0] ?? '');
    expect(asked.origin + asked.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({
      trigger_onepick: 'true',
      allow_multiple: 'true',
      allow_folder_selection: 'true',
      prompt: 'consent',
      mimetypes: 'application/pdf,application/vnd.google-apps.folder',
      scope: 'https://www.googleapis.com/auth/drive.file',
      access_type: 'offline',
      code_challenge_method: 'S256',
      redirect_uri: `http://127.0.0.1:${LOOPBACK_PORT}/callback`,
    });
    const redeemed = google.tokenRequests[0] ?? {};
    expect(redeemed).toMatchObject({ grant_type: 'authorization_code', client_id: GOOGLE_CLIENT_ID });
    expect(redeemed.code_verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(redeemed).not.toHaveProperty('client_secret');

    // The refresh token stayed with the host; the page keeps nothing of it.
    expect(host.secrets.get('gdrive')).toMatch(/^refresh\./);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).toBe('{}');

    const opened = (await run(page, (cloud, id: string) => cloud.open('gdrive', id), contract)) as { key: string; name: string; version: string; text: string };
    expect(opened).toMatchObject({ key: contract, name: 'عقد.pdf', text: '%PDF-1.7 the contract' });

    const saved = (await run(
      page,
      (cloud, args: { id: string; version: string }) => cloud.saveRevision('gdrive', args.id, args.version, '%PDF-1.7 edited here'),
      { id: contract, version: opened.version },
    )) as { version: string };
    expect(saved.version).not.toBe(opened.version);
    expect(google.files.get(contract)?.bytes.toString()).toBe('%PDF-1.7 edited here');

    // Only the file picked — and what the app saves — is the app's to see.
    expect(await run(page, (cloud) => cloud.list('gdrive', null))).toEqual([{ key: contract, name: 'عقد.pdf', kind: 'pdf' }]);
  });

  test('several files and a folder are picked at once, and the folder lists what the app may see in it', async ({ page }) => {
    const google = new FakeGoogle();
    const contract = google.addFile('عقد.pdf', Buffer.from('%PDF-1.7 the contract'));
    const invoice = google.addFile('invoice.pdf', Buffer.from('%PDF-1.7 the invoice'));
    const folder = google.addFolder('زود 2025');
    const inside = google.addFile('brochure.pdf', Buffer.from('%PDF-1.7 inside'), folder);
    google.addFile('unseen.pdf', Buffer.from('%PDF-1.7 not picked'), folder);
    google.pick = ['عقد.pdf', 'invoice.pdf', 'زود 2025', 'brochure.pdf'];
    const host = new FakeHost(new FakeMicrosoft('http://127.0.0.1'), google);
    await install(page, host);

    const signedIn = await run(page, (cloud) => cloud.signIn('gdrive', 'open'));
    expect(signedIn.picked).toEqual([contract, invoice, folder, inside]);
    expect(await run(page, (cloud, id: string) => cloud.list('gdrive', id), folder)).toEqual([{ key: inside, name: 'brochure.pdf', kind: 'pdf' }]);
    const everything = (await run(page, (cloud) => cloud.list('gdrive', null))) as { key: string; kind: string }[];
    expect(everything.map((entry) => entry.key).sort()).toEqual([contract, invoice, folder, inside].sort());
    expect(everything.find((entry) => entry.key === folder)?.kind).toBe('folder');
  });

  test('a file someone else saved meanwhile is a conflict, and nothing is written until the person says so', async ({ page }) => {
    const google = new FakeGoogle();
    const contract = google.addFile('عقد.pdf', Buffer.from('%PDF-1.7 theirs'));
    google.pick = 'عقد.pdf';
    const host = new FakeHost(new FakeMicrosoft('http://127.0.0.1'), google);
    await install(page, host);
    await run(page, (cloud) => cloud.signIn('gdrive', 'open'));
    const opened = (await run(page, (cloud, id: string) => cloud.open('gdrive', id), contract)) as { version: string };

    google.touch(contract);
    const theirs = google.files.get(contract)?.bytes.toString();
    const refused = await run(page, (cloud, args: { id: string; version: string }) => cloud.saveRevision('gdrive', args.id, args.version, 'mine'), {
      id: contract,
      version: opened.version,
    });
    expect(refused).toMatchObject({ error: 'conflict' });
    expect(google.files.get(contract)?.bytes.toString()).toBe(theirs);

    // Replacing on purpose writes over it.
    const replaced = (await run(page, (cloud, id: string) => cloud.saveRevision('gdrive', id, null, '%PDF-1.7 mine'), contract)) as { version: string };
    expect(replaced.version).toEqual(expect.any(String));
    expect(google.files.get(contract)?.bytes.toString()).toBe('%PDF-1.7 mine');
  });

  test('a new file is created in My Drive, an expired token is refreshed without asking, and signing out revokes it at Google', async ({ page }) => {
    const google = new FakeGoogle();
    google.addFile('عقد.pdf', Buffer.from('%PDF-1.7 x'));
    google.pick = 'عقد.pdf';
    const host = new FakeHost(new FakeMicrosoft('http://127.0.0.1'), google);
    await install(page, host);
    await run(page, (cloud) => cloud.signIn('gdrive', 'open'));

    const created = (await run(page, (cloud) => cloud.saveNew('gdrive', null, 'تقرير.pdf', '%PDF-1.7 new'))) as { key: string; name: string };
    expect(created.name).toBe('تقرير.pdf');
    expect(google.files.get(created.key)?.mimeType).toBe('application/pdf');
    expect(google.files.get(created.key)?.bytes.toString()).toBe('%PDF-1.7 new');

    // An access token lasts an hour; the kept refresh token brings another, with no browser.
    google.expireAccessTokens();
    expect(await run(page, (cloud, id: string) => cloud.open('gdrive', id), created.key)).toMatchObject({ name: 'تقرير.pdf' });
    expect(google.tokenRequests.map((form) => form.grant_type)).toEqual(['authorization_code', 'refresh_token']);
    expect(host.opened).toHaveLength(1);

    const kept = host.secrets.get('gdrive') ?? '';
    expect(await run(page, (cloud) => cloud.signOut('gdrive'))).toBe(true);
    expect(google.revoked).toEqual([kept]);
    expect(host.secrets.has('gdrive')).toBe(false);
    expect(await run(page, (cloud) => cloud.ready('gdrive'))).toBe(false);
    expect(await run(page, (cloud, id: string) => cloud.open('gdrive', id), created.key)).toMatchObject({ error: 'signedOut' });
  });
});

test.describe('OneDrive on the desktop', () => {
  test('the code comes back to the loopback listener and is redeemed by the host, with no Origin and no secret', async ({ page }) => {
    const microsoft = new FakeMicrosoft('http://127.0.0.1');
    const report = microsoft.addFile('report.pdf', Buffer.from('%PDF-1.7 report'));
    const host = new FakeHost(microsoft, new FakeGoogle());
    await install(page, host);

    const signedIn = await run(page, (cloud) => cloud.signIn('onedrive'));
    expect(signedIn.error).toBeUndefined();
    expect(signedIn.account).toEqual({ name: 'سارة الأحمد', email: 'sara@example.com' });
    const asked = new URL(host.opened[0] ?? '');
    expect(asked.origin + asked.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(asked.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${LOOPBACK_PORT}/callback`);
    expect(microsoft.tokenRequests[0]).not.toHaveProperty('client_secret');
    expect(host.secrets.get('onedrive')).toMatch(/^refresh\./);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).toBe('{}');

    const listed = (await run(page, (cloud) => cloud.list('onedrive', null))) as { name: string }[];
    expect(listed.map((entry) => entry.name)).toEqual(['report.pdf']);

    const key = `${microsoft.driveId}!${report}`;
    const opened = (await run(page, (cloud, item: string) => cloud.open('onedrive', item), key)) as { version: string; text: string };
    expect(opened.text).toBe('%PDF-1.7 report');
    const saved = (await run(
      page,
      (cloud, args: { key: string; version: string }) => cloud.saveRevision('onedrive', args.key, args.version, '%PDF-1.7 edited'),
      { key, version: opened.version },
    )) as { version: string };
    expect(saved.version).toBe(microsoft.eTag(microsoft.items.get(report)!));
    expect(microsoft.items.get(report)?.bytes.toString()).toBe('%PDF-1.7 edited');

    // Someone else saves it: the next save is refused, not quietly applied.
    microsoft.touch(report);
    const refused = await run(page, (cloud, args: { key: string; version: string }) => cloud.saveRevision('onedrive', args.key, args.version, 'mine'), {
      key,
      version: saved.version,
    });
    expect(refused).toMatchObject({ error: 'conflict' });
  });

  test('an answer that is not this sign-in’s is never taken for it', async ({ page }) => {
    const microsoft = new FakeMicrosoft('http://127.0.0.1');
    const host = new FakeHost(microsoft, new FakeGoogle());
    // The listener is asked for a state other than the one the browser carries:
    // what a page elsewhere calling 127.0.0.1 would amount to.
    await install(page, host, (name, args) => (name === 'cloud_auth_wait' ? { expectedState: 'not-this-sign-ins-state' } : args));
    expect(await run(page, (cloud) => cloud.signIn('onedrive'))).toMatchObject({ error: 'timeout' });
    expect(host.secrets.has('onedrive')).toBe(false);
    expect(microsoft.tokenRequests).toHaveLength(0);
  });
});
