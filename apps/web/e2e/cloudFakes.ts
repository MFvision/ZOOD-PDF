import { createHash, randomBytes } from 'node:crypto';

/**
 * Stand-ins for the drives' own servers, written from their documentation
 * (docs/cloud.md links it): Microsoft's identity platform and Graph, Google's
 * OAuth endpoints and the Drive API v3. They check what the real ones check —
 * PKCE, the redirect URI, the state round trip, no secret from a public
 * client, bearer tokens, eTags and If-Match, upload ranges — and refuse the
 * way the real ones do, so the app is proven against the protocol and not
 * against a mock that says yes.
 *
 * They know nothing of Playwright: a request is a method, a URL, headers and
 * a body. `cloud.spec.ts` routes a browser's requests to them;
 * `cloud-desktop.spec.ts` sends them what the desktop host would.
 */

export interface FakeRequest {
  method: string;
  url: string;
  /** Lower-case names. */
  headers: Record<string, string>;
  body: Buffer | null;
}

export interface FakeResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

/** Where a browser is sent after the authorization page, or an error page it stays on. */
export type Authorized = { redirect: string } | { status: number; body: string };

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const token = (prefix: string) => `${prefix}.${randomBytes(18).toString('base64url')}`;

function json(status: number, body: unknown, headers: Record<string, string> = {}): FakeResponse {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

interface Grant {
  challenge: string;
  method: string;
  redirectUri: string;
  scope: string;
  used: boolean;
}

/** An OAuth server's part both providers share: codes for PKCE, refresh tokens, access tokens. */
class Authority {
  readonly grants = new Map<string, Grant>();
  readonly refreshTokens = new Map<string, { signedInAt: number }>();
  readonly accessTokens = new Set<string>();
  /** Every token request, as its form. */
  readonly tokenRequests: Record<string, string>[] = [];
  /** What the next person at the authorization page does. */
  consent: 'grant' | 'deny' = 'grant';

  protected issueCode(grant: Grant): string {
    const code = token('code');
    this.grants.set(code, grant);
    return code;
  }

  /** Validates a redemption as RFC 6749 §4.1.3 and RFC 7636 §4.6 say; `null` when it is good. */
  protected redeemProblem(form: URLSearchParams): { error: string; description: string } | null {
    const code = form.get('code') ?? '';
    const grant = this.grants.get(code);
    if (!grant) return { error: 'invalid_grant', description: 'the code is unknown' };
    if (grant.used) return { error: 'invalid_grant', description: 'the code was already redeemed' };
    grant.used = true;
    if (form.get('redirect_uri') !== grant.redirectUri) return { error: 'invalid_grant', description: 'redirect_uri does not match the authorization request' };
    const verifier = form.get('code_verifier') ?? '';
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return { error: 'invalid_grant', description: 'code_verifier is malformed' };
    if (grant.method !== 'S256' || s256(verifier) !== grant.challenge) {
      return { error: 'invalid_grant', description: 'the code_verifier does not match the code_challenge' };
    }
    return null;
  }

  protected issueTokens(offline: boolean, signedInAt = Date.now()): Record<string, unknown> {
    const access = token('access');
    this.accessTokens.add(access);
    const answer: Record<string, unknown> = { token_type: 'Bearer', expires_in: 3599, access_token: access };
    if (offline) {
      const refresh = token('refresh');
      this.refreshTokens.set(refresh, { signedInAt });
      answer.refresh_token = refresh;
    }
    return answer;
  }

  /** The bearer token of a request, if the server still honours it. */
  protected bearer(request: FakeRequest): string | null {
    const found = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
    return found && this.accessTokens.has(found) ? found : null;
  }

  /** Every access token expires at once: the next request is refused and the app must refresh. */
  expireAccessTokens(): void {
    this.accessTokens.clear();
  }
}

/* ============================================================ Microsoft */

export const MS_CLIENT_ID = '0b3f6a2e-1c1d-4c55-9d5e-2a9f5e0c1d22';
export const GRAPH = 'https://graph.microsoft.com/v1.0';
export const MS_DOWNLOADS = 'https://e2e-dl.files.1drv.com/';
export const MS_UPLOADS = 'https://e2e.up.1drv.com/';

export interface MsItem {
  id: string;
  name: string;
  parent: string | null;
  folder: boolean;
  bytes: Buffer;
  version: number;
  modified: string;
}

interface UploadSession {
  target: { kind: 'item'; id: string } | { kind: 'new'; parent: string; name: string };
  received: Buffer[];
  next: number;
  total: number | null;
}

const MS_CORS = (origin: string | undefined) => ({
  'access-control-allow-origin': origin ?? '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, if-match, content-range',
  'access-control-max-age': '600',
});

/**
 * Microsoft's identity platform (v2.0 endpoints) and Graph's OneDrive API,
 * for one app registered with a single-page-app redirect URI (the browser
 * build) and a loopback one (the desktop).
 */
export class FakeMicrosoft extends Authority {
  readonly driveId = 'e2edrive01';
  readonly items = new Map<string, MsItem>();
  readonly sessions = new Map<string, UploadSession>();
  /** Every Graph, download and upload request, in order. */
  readonly log: FakeRequest[] = [];
  /** Graph pages this many items at a time (it may return fewer than $top). */
  pageSize = 200;
  private readonly downloads = new Map<string, string>();

  constructor(
    /** The browser build's origin: its SPA redirect URI is `${origin}/oauth-callback.html`. */
    readonly appOrigin: string,
  ) {
    super();
    this.items.set('root', { id: 'root', name: 'root', parent: null, folder: true, bytes: Buffer.alloc(0), version: 1, modified: new Date().toISOString() });
  }

  private nextId(): string {
    return `01E2E${randomBytes(6).toString('hex').toUpperCase()}`;
  }

  addFolder(name: string, parent = 'root'): string {
    const id = this.nextId();
    this.items.set(id, { id, name, parent, folder: true, bytes: Buffer.alloc(0), version: 1, modified: new Date().toISOString() });
    return id;
  }

  addFile(name: string, bytes: Buffer, parent = 'root'): string {
    const id = this.nextId();
    this.items.set(id, { id, name, parent, folder: false, bytes, version: 1, modified: new Date().toISOString() });
    return id;
  }

  /** Someone else saves the file in OneDrive: other bytes, a new eTag. */
  touch(id: string, bytes?: Buffer): void {
    const item = this.items.get(id);
    if (!item) throw new Error(`no item ${id}`);
    item.bytes = bytes ?? Buffer.concat([item.bytes, Buffer.from('\n% edited elsewhere\n')]);
    item.version += 1;
    item.modified = new Date().toISOString();
  }

  eTag(item: MsItem): string {
    return `"{${item.id}},${item.version}"`;
  }

  childrenOf(parent: string): MsItem[] {
    return [...this.items.values()].filter((item) => item.parent === parent);
  }

  private pathOf(item: MsItem): string {
    const names: string[] = [];
    for (let at = item.parent; at && at !== 'root'; at = this.items.get(at)?.parent ?? null) names.unshift(this.items.get(at)?.name ?? '');
    return `/drive/root:${names.map((n) => `/${encodeURIComponent(n)}`).join('')}`;
  }

  /** An item as Graph writes a driveItem. */
  itemJson(item: MsItem, withDownload = false): Record<string, unknown> {
    const parent = item.parent ? this.items.get(item.parent) : undefined;
    const body: Record<string, unknown> = {
      id: item.id,
      name: item.name,
      eTag: this.eTag(item),
      cTag: `"c:{${item.id}},${item.version}"`,
      lastModifiedDateTime: item.modified,
      size: item.folder ? 0 : item.bytes.length,
      parentReference: item.parent
        ? { driveId: this.driveId, driveType: 'personal', id: item.parent, name: parent?.id === 'root' ? 'root' : parent?.name, path: this.pathOf(item) }
        : { driveId: this.driveId, driveType: 'personal' },
    };
    if (item.folder) body.folder = { childCount: this.childrenOf(item.id).length };
    else body.file = { mimeType: item.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream' };
    if (withDownload && !item.folder) {
      const nonce = randomBytes(12).toString('hex');
      this.downloads.set(nonce, item.id);
      body['@microsoft.graph.downloadUrl'] = `${MS_DOWNLOADS}download/${nonce}`;
    }
    return body;
  }

  /* ------------------------------------------------ the authorization page */

  /** The person at `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize?…`. */
  authorize(url: string, redirects: readonly string[]): Authorized {
    const request = new URL(url);
    const p = request.searchParams;
    if (!/^\/(common|consumers|organizations)\/oauth2\/v2\.0\/authorize$/.test(request.pathname)) return { status: 404, body: 'not found' };
    if (p.get('client_id') !== MS_CLIENT_ID) return { status: 400, body: 'AADSTS700016: Application not found in the directory' };
    const redirectUri = p.get('redirect_uri') ?? '';
    // Loopback redirect URIs match whatever their port (Microsoft ignores it for 127.0.0.1 and localhost).
    const matches = redirects.some((registered) =>
      registered === redirectUri || (registered.startsWith('http://127.0.0.1/') && redirectUri.replace(/^http:\/\/127\.0\.0\.1:\d+\//, 'http://127.0.0.1/') === registered),
    );
    if (!matches) return { status: 400, body: 'AADSTS50011: The redirect URI specified in the request does not match the redirect URIs configured for the application' };
    const state = p.get('state') ?? '';
    const back = (params: Record<string, string>) => {
      const target = new URL(redirectUri);
      for (const [name, value] of Object.entries(params)) target.searchParams.set(name, value);
      return { redirect: target.href };
    };
    if (p.get('response_type') !== 'code') return back({ error: 'unsupported_response_type', state });
    const challenge = p.get('code_challenge') ?? '';
    if (p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return back({ error: 'invalid_request', error_description: 'AADSTS9002325: Proof Key for Code Exchange is required for cross-origin authorization code redemption.', state });
    }
    const scope = p.get('scope') ?? '';
    if (!scope.split(' ').includes('Files.ReadWrite')) return back({ error: 'invalid_scope', state });
    if (this.consent === 'deny') return back({ error: 'access_denied', error_description: 'AADSTS65004: User declined to consent to access the app.', state });
    const code = this.issueCode({ challenge, method: 'S256', redirectUri, scope, used: false });
    return back({ code, state, session_state: randomBytes(8).toString('hex') });
  }

  /* ---------------------------------------------------- the token endpoint */

  /**
   * `POST /{tenant}/oauth2/v2.0/token`. A public client presents no secret
   * (AADSTS700025). A code for the SPA redirect URI is redeemed only
   * cross-origin, from that origin; a code for a desktop (loopback) one only
   * without an Origin at all (AADSTS9002326/9002327).
   */
  token(request: FakeRequest): FakeResponse {
    const cors = request.headers.origin ? MS_CORS(request.headers.origin) : {};
    if (request.method === 'OPTIONS') return { status: 204, headers: MS_CORS(request.headers.origin), body: '' };
    const form = new URLSearchParams(request.body?.toString('utf8') ?? '');
    this.tokenRequests.push(Object.fromEntries(form));
    const refuse = (status: number, error: string, description: string) => json(status, { error, error_description: description, error_codes: [] }, cors);
    if (request.method !== 'POST' || !/^\/(common|consumers|organizations)\/oauth2\/v2\.0\/token$/.test(new URL(request.url).pathname)) return refuse(404, 'invalid_request', 'not found');
    if (form.has('client_secret') || form.has('client_assertion')) {
      return refuse(401, 'invalid_client', "AADSTS700025: Client is public so neither 'client_assertion' nor 'client_secret' should be presented.");
    }
    if (form.get('client_id') !== MS_CLIENT_ID) return refuse(400, 'unauthorized_client', 'AADSTS700016: Application not found');
    const spa = (redirect: string) => redirect === `${this.appOrigin}/oauth-callback.html`;
    const originOk = (redirect: string) => (spa(redirect) ? request.headers.origin === this.appOrigin : request.headers.origin === undefined);
    switch (form.get('grant_type')) {
      case 'authorization_code': {
        const grant = this.grants.get(form.get('code') ?? '');
        if (grant && !originOk(grant.redirectUri)) {
          return refuse(400, 'invalid_request', "AADSTS9002326: Cross-origin token redemption is permitted only for the 'Single-Page Application' client-type.");
        }
        const problem = this.redeemProblem(form);
        if (problem) return refuse(400, problem.error, problem.description);
        return json(200, { ...this.issueTokens((grant?.scope ?? '').includes('offline_access')), scope: 'Files.ReadWrite User.Read' }, cors);
      }
      case 'refresh_token': {
        const kept = this.refreshTokens.get(form.get('refresh_token') ?? '');
        if (!kept) return refuse(400, 'invalid_grant', 'AADSTS700082: The refresh token has expired or was revoked.');
        // Rotated: the old one is spent, the new one keeps the sign-in's age.
        this.refreshTokens.delete(form.get('refresh_token') ?? '');
        return json(200, { ...this.issueTokens(true, kept.signedInAt), scope: 'Files.ReadWrite User.Read' }, cors);
      }
      default:
        return refuse(400, 'unsupported_grant_type', 'AADSTS70003');
    }
  }

  /* ------------------------------------------------------------- Graph */

  graph(request: FakeRequest): FakeResponse {
    this.log.push(request);
    const cors = MS_CORS(request.headers.origin);
    if (request.method === 'OPTIONS') return { status: 204, headers: cors, body: '' };
    const error = (status: number, code: string, message = code) => json(status, { error: { code, message } }, cors);
    if (!this.bearer(request)) return error(401, 'InvalidAuthenticationToken', 'Access token has expired or is not valid.');
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/v1\.0/, '');
    const drive = `/drives/${this.driveId}/items/`;
    const itemOf = (id: string) => this.items.get(id) ?? null;
    const page = (items: MsItem[], base: string) => {
      const from = Number(url.searchParams.get('$skiptoken') ?? 0);
      const top = Math.min(Number(url.searchParams.get('$top') ?? 200), this.pageSize);
      const value = items.slice(from, from + top).map((item) => this.itemJson(item));
      const body: Record<string, unknown> = { value };
      if (from + top < items.length) {
        const next = new URL(`${GRAPH}${base}`);
        for (const [name, v] of url.searchParams) if (name !== '$skiptoken') next.searchParams.set(name, v);
        next.searchParams.set('$skiptoken', String(from + top));
        body['@odata.nextLink'] = next.href;
      }
      return json(200, body, cors);
    };

    if (request.method === 'GET' && path === '/me') {
      return json(200, { displayName: 'سارة الأحمد', mail: 'sara@example.com', userPrincipalName: 'sara@example.com' }, cors);
    }
    if (request.method === 'GET' && path === '/me/drive/root/children') return page(this.childrenOf('root'), path);
    const children = new RegExp(`^${drive}([^/]+)/children$`).exec(path);
    if (request.method === 'GET' && children) {
      const folder = itemOf(decodeURIComponent(children[1] ?? ''));
      return folder?.folder ? page(this.childrenOf(folder.id), path) : error(404, 'itemNotFound');
    }
    const search = /^\/me\/drive\/root\/search\(q='(.*)'\)$/.exec(path);
    if (request.method === 'GET' && search) {
      const text = decodeURIComponent(search[1] ?? '').replace(/''/g, "'").toLowerCase();
      return page([...this.items.values()].filter((item) => item.id !== 'root' && item.name.toLowerCase().includes(text)), path);
    }
    const one = new RegExp(`^${drive}([^/:]+)$`).exec(path);
    if (request.method === 'GET' && one) {
      const item = itemOf(decodeURIComponent(one[1] ?? ''));
      return item ? json(200, this.itemJson(item, true), cors) : error(404, 'itemNotFound');
    }
    const revision = new RegExp(`^${drive}([^/:]+)/createUploadSession$`).exec(path);
    if (request.method === 'POST' && revision) {
      const item = itemOf(decodeURIComponent(revision[1] ?? ''));
      if (!item || item.folder) return error(404, 'itemNotFound');
      const ifMatch = request.headers['if-match'];
      if (ifMatch && ifMatch !== this.eTag(item) && ifMatch !== `"c:{${item.id}},${item.version}"`) {
        return error(412, 'resourceModified', 'ETag does not match current item’s value');
      }
      return this.openSession({ kind: 'item', id: item.id }, cors);
    }
    const named = new RegExp(`^(?:${drive}([^/:]+)|/me/drive/root):/([^/]+):/createUploadSession$`).exec(path);
    if (request.method === 'POST' && named) {
      const parent = named[1] ? decodeURIComponent(named[1]) : 'root';
      if (!itemOf(parent)?.folder) return error(404, 'itemNotFound');
      const name = decodeURIComponent(named[2] ?? '');
      const body = JSON.parse(request.body?.toString('utf8') || '{}') as { item?: { '@microsoft.graph.conflictBehavior'?: string; name?: string } };
      const behavior = body.item?.['@microsoft.graph.conflictBehavior'] ?? 'fail';
      if (body.item?.name && body.item.name !== name) return error(400, 'invalidRequest', 'the name in the body is not the one in the path');
      // OneDrive's names are case-insensitive.
      const taken = this.childrenOf(parent).find((item) => item.name.toLowerCase() === name.toLowerCase());
      if (taken && behavior === 'fail') return error(409, 'nameAlreadyExists', 'The specified item name already exists.');
      if (taken && behavior === 'replace') return this.openSession({ kind: 'item', id: taken.id }, cors);
      let unique = name;
      for (let n = 1; this.childrenOf(parent).some((item) => item.name.toLowerCase() === unique.toLowerCase()); n += 1) unique = name.replace(/(\.pdf)?$/i, ` ${n}$1`);
      return this.openSession({ kind: 'new', parent, name: unique }, cors);
    }
    return error(400, 'invalidRequest', `the fake knows no ${request.method} ${path}`);
  }

  private openSession(target: UploadSession['target'], cors: Record<string, string>): FakeResponse {
    const id = randomBytes(10).toString('hex');
    this.sessions.set(id, { target, received: [], next: 0, total: null });
    return json(200, { uploadUrl: `${MS_UPLOADS}up/${id}`, expirationDateTime: new Date(Date.now() + 3_600_000).toISOString(), nextExpectedRanges: ['0-'] }, cors);
  }

  /** A pre-authenticated download address: no token needed, none checked. */
  download(request: FakeRequest): FakeResponse {
    this.log.push(request);
    if (request.method === 'OPTIONS') return { status: 204, headers: MS_CORS(request.headers.origin), body: '' };
    const nonce = /\/download\/([0-9a-f]+)$/.exec(new URL(request.url).pathname)?.[1] ?? '';
    const item = this.items.get(this.downloads.get(nonce) ?? '');
    if (!item) return { status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' };
    return { status: 200, headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' }, body: item.bytes };
  }

  /**
   * An upload session's address. Graph's rules: no Authorization header,
   * ranges in order, each a multiple of 320 KiB but the last, one total
   * throughout; 202 until the last byte, then the item.
   */
  upload(request: FakeRequest): FakeResponse {
    this.log.push(request);
    const cors = MS_CORS(request.headers.origin);
    if (request.method === 'OPTIONS') return { status: 204, headers: cors, body: '' };
    const error = (status: number, code: string) => json(status, { error: { code, message: code } }, cors);
    const id = /\/up\/([0-9a-f]+)$/.exec(new URL(request.url).pathname)?.[1] ?? '';
    const session = this.sessions.get(id);
    if (!session) return error(404, 'itemNotFound');
    if (request.method === 'DELETE') {
      this.sessions.delete(id);
      return { status: 204, headers: cors, body: '' };
    }
    if (request.headers.authorization) return error(401, 'unauthenticated');
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(request.headers['content-range'] ?? '');
    const body = request.body ?? Buffer.alloc(0);
    if (!range) return error(400, 'invalidRange');
    const [start, end, total] = [Number(range[1]), Number(range[2]), Number(range[3])];
    if (start !== session.next || end - start + 1 !== body.length || (session.total !== null && session.total !== total) || body.length > 60 * 1024 * 1024) {
      return error(416, 'invalidRange');
    }
    if (end + 1 < total && body.length % (320 * 1024) !== 0) return error(400, 'invalidRange');
    session.total = total;
    session.received.push(body);
    session.next = end + 1;
    if (session.next < total) return json(202, { expirationDateTime: new Date().toISOString(), nextExpectedRanges: [`${session.next}-`] }, cors);
    this.sessions.delete(id);
    const bytes = Buffer.concat(session.received);
    if (session.target.kind === 'item') {
      const item = this.items.get(session.target.id);
      if (!item) return error(404, 'itemNotFound');
      item.bytes = bytes;
      item.version += 1;
      item.modified = new Date().toISOString();
      return json(200, this.itemJson(item), cors);
    }
    const taken = this.childrenOf(session.target.parent).find((item) => item.name.toLowerCase() === (session.target as { name: string }).name.toLowerCase());
    if (taken) return error(409, 'nameAlreadyExists');
    const created = this.addFile(session.target.name, bytes, session.target.parent);
    return json(201, this.itemJson(this.items.get(created) as MsItem), cors);
  }
}

/* =============================================================== Google */

export const GOOGLE_CLIENT_ID = '123456789012-e2etestclientid00.apps.googleusercontent.com';
export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export interface GoogleFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  bytes: Buffer;
  version: number;
  head: string;
  modified: string;
  /** Whether the app may see it (drive.file: picked in the picker, or made by the app). */
  granted: boolean;
}

/**
 * Google's OAuth endpoints for a "Desktop app" client (loopback redirect,
 * PKCE; its documentation lists the client secret as optional) and the
 * Drive API v3 with the drive.file scope: a file the person did not pick,
 * nor the app create, answers 404 as Drive does.
 */
export class FakeGoogle extends Authority {
  readonly files = new Map<string, GoogleFile>();
  readonly log: FakeRequest[] = [];
  readonly revoked: string[] = [];
  /** What the person picks in the picker the consent screen shows, by name. */
  pick: string | null = null;

  constructor() {
    super();
    this.addFolder('My Drive', 'root');
  }

  private nextId(): string {
    return `1E2e${randomBytes(12).toString('base64url')}`;
  }

  addFolder(name: string, id = this.nextId()): string {
    this.files.set(id, { id, name, mimeType: 'application/vnd.google-apps.folder', parents: [], bytes: Buffer.alloc(0), version: 1, head: '', modified: new Date().toISOString(), granted: false });
    return id;
  }

  addFile(name: string, bytes: Buffer, parent = 'root'): string {
    const id = this.nextId();
    this.files.set(id, { id, name, mimeType: 'application/pdf', parents: [parent], bytes, version: 1, head: `0B${randomBytes(8).toString('hex')}`, modified: new Date().toISOString(), granted: false });
    return id;
  }

  /** Someone else saves the file: new bytes, a new head revision. */
  touch(id: string): void {
    const file = this.files.get(id);
    if (!file) throw new Error(`no file ${id}`);
    file.bytes = Buffer.concat([file.bytes, Buffer.from('\n% edited elsewhere\n')]);
    file.version += 1;
    file.head = `0B${randomBytes(8).toString('hex')}`;
  }

  private fileJson(file: GoogleFile): Record<string, unknown> {
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      parents: file.parents,
      size: String(file.bytes.length),
      version: String(file.version),
      ...(file.mimeType === 'application/pdf' ? { headRevisionId: file.head } : {}),
      modifiedTime: file.modified,
      trashed: false,
    };
  }

  /** The person at `https://accounts.google.com/o/oauth2/v2/auth?…`, with the picker in the consent screen. */
  authorize(url: string): Authorized {
    const request = new URL(url);
    const p = request.searchParams;
    if (request.origin + request.pathname !== 'https://accounts.google.com/o/oauth2/v2/auth') return { status: 404, body: 'not found' };
    if (p.get('client_id') !== GOOGLE_CLIENT_ID) return { status: 401, body: 'Error 401: invalid_client' };
    const redirectUri = p.get('redirect_uri') ?? '';
    // A desktop client may be sent back to any loopback address and port.
    if (!/^http:\/\/127\.0\.0\.1:\d+(\/.*)?$/.test(redirectUri)) return { status: 400, body: 'Error 400: redirect_uri_mismatch' };
    const state = p.get('state') ?? '';
    const back = (params: Record<string, string>) => {
      const target = new URL(redirectUri);
      for (const [name, value] of Object.entries(params)) target.searchParams.set(name, value);
      return { redirect: target.href };
    };
    const challenge = p.get('code_challenge') ?? '';
    if (p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return back({ error: 'invalid_request', state });
    }
    const scope = p.get('scope') ?? '';
    if (scope !== 'https://www.googleapis.com/auth/drive.file') return back({ error: 'invalid_scope', state });
    if (this.consent === 'deny') return back({ error: 'access_denied', state });
    const params: Record<string, string> = { state, scope };
    // The picker in the consent screen: only with prompt=consent and drive.file.
    if (p.get('trigger_onepick') === 'true') {
      if (p.get('prompt') !== 'consent') return back({ error: 'invalid_request', state });
      const wanted = (p.get('mimetypes') ?? '').split(',');
      const picked = [...this.files.values()].find((file) => file.name === this.pick && wanted.includes(file.mimeType));
      if (picked) {
        picked.granted = true;
        params.picked_file_ids = picked.id;
      }
    }
    params.code = this.issueCode({ challenge, method: 'S256', redirectUri, scope, used: false });
    return back(params);
  }

  /** `POST https://oauth2.googleapis.com/token` and `/revoke`. */
  token(request: FakeRequest): FakeResponse {
    const form = new URLSearchParams(request.body?.toString('utf8') ?? '');
    const path = new URL(request.url).pathname;
    if (path === '/revoke') {
      const known = form.get('token') ?? '';
      this.revoked.push(known);
      const had = this.refreshTokens.delete(known) || this.accessTokens.delete(known);
      return had ? json(200, {}) : json(400, { error: 'invalid_token', error_description: 'Token expired or revoked' });
    }
    this.tokenRequests.push(Object.fromEntries(form));
    const refuse = (error: string, description: string) => json(400, { error, error_description: description });
    if (form.get('client_id') !== GOOGLE_CLIENT_ID) return json(401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' });
    switch (form.get('grant_type')) {
      case 'authorization_code': {
        const problem = this.redeemProblem(form);
        return problem ? refuse(problem.error, problem.description) : json(200, { ...this.issueTokens(true), scope: 'https://www.googleapis.com/auth/drive.file' });
      }
      case 'refresh_token':
        // Google does not rotate: the refresh token stays good.
        return this.refreshTokens.has(form.get('refresh_token') ?? '')
          ? json(200, { access_token: this.issueTokens(false).access_token, expires_in: 3599, token_type: 'Bearer' })
          : refuse('invalid_grant', 'Token has been expired or revoked.');
      default:
        return refuse('unsupported_grant_type', 'Invalid grant_type');
    }
  }

  /** The Drive API v3. drive.file: what the app may not see is "not found". */
  drive(request: FakeRequest): FakeResponse {
    this.log.push(request);
    const error = (status: number, reason: string) => json(status, { error: { code: status, message: reason, errors: [{ reason }] } });
    if (!this.bearer(request)) return error(401, 'authError');
    const url = new URL(request.url);
    const upload = url.pathname.startsWith('/upload/drive/v3');
    const path = url.pathname.replace(/^\/(upload\/)?drive\/v3/, '');
    if (!upload && request.method === 'GET' && path === '/about') return json(200, { user: { displayName: 'Sara', emailAddress: 'sara@example.org' } });
    if (!upload && request.method === 'GET' && path === '/files') {
      const q = url.searchParams.get('q') ?? '';
      const name = /name contains '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1');
      const found = [...this.files.values()].filter((file) => file.granted && file.mimeType === 'application/pdf' && (!name || file.name.includes(name)));
      return json(200, { files: found.map((file) => this.fileJson(file)) });
    }
    const one = /^\/files\/([^/]+)$/.exec(path);
    const file = one ? this.files.get(decodeURIComponent(one[1] ?? '')) : undefined;
    if (one && (!file || !file.granted)) return error(404, 'notFound');
    if (!upload && request.method === 'GET' && file) {
      if (url.searchParams.get('alt') === 'media') return { status: 200, headers: { 'content-type': file.mimeType }, body: file.bytes };
      return json(200, this.fileJson(file));
    }
    if (upload && request.method === 'PATCH' && file) {
      if (url.searchParams.get('uploadType') !== 'media') return error(400, 'badRequest');
      file.bytes = request.body ?? Buffer.alloc(0);
      file.version += 1;
      file.head = `0B${randomBytes(8).toString('hex')}`;
      file.modified = new Date().toISOString();
      return json(200, this.fileJson(file));
    }
    if (upload && request.method === 'POST' && path === '/files') {
      if (url.searchParams.get('uploadType') !== 'multipart') return error(400, 'badRequest');
      const boundary = /boundary=([^;]+)/.exec(request.headers['content-type'] ?? '')?.[1];
      const body = request.body ?? Buffer.alloc(0);
      if (!boundary) return error(400, 'badContent');
      const parts = splitMultipart(body, boundary);
      const metadata = JSON.parse(parts[0]?.toString('utf8') ?? '{}') as { name?: string; mimeType?: string; parents?: string[] };
      const parent = metadata.parents?.[0] ?? 'root';
      if (parent !== 'root' && !this.files.get(parent)?.granted) return error(404, 'notFound');
      const id = this.addFile(metadata.name ?? 'Untitled', parts[1] ?? Buffer.alloc(0), parent);
      const created = this.files.get(id) as GoogleFile;
      created.granted = true;
      return json(200, this.fileJson(created));
    }
    return error(400, `the fake knows no ${request.method} ${url.pathname}`);
  }
}

/** The parts of a multipart/related body, each without its headers. */
export function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const parts: Buffer[] = [];
  const marker = Buffer.from(`--${boundary}`);
  let at = body.indexOf(marker);
  while (at !== -1) {
    const next = body.indexOf(marker, at + marker.length);
    if (next === -1) break;
    const part = body.subarray(at + marker.length, next);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) parts.push(part.subarray(headerEnd + 4, part.length - 2));
    at = next;
  }
  return parts;
}
