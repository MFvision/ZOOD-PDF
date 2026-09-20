import type { ProviderId } from './config';
import { CloudError, kindOf, kindOfStatus } from './errors';
import type { Session } from './oauth';

/**
 * How a request reaches a drive. In a browser it is the page's own `fetch`,
 * limited by its `connect-src` to the drive's hosts; on the desktop it is
 * the host (`cloud_http` in `src-tauri/src/cloud.rs`), which sends only to
 * those hosts, from Rust — the webview's own policy reaches none of them.
 * The drive code above this never knows which.
 */

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CloudRequest {
  method: Method;
  url: string;
  /** Lower-case names. */
  headers?: Record<string, string>;
  body?: ArrayBuffer | string;
}

export interface CloudResponse {
  status: number;
  /** Lower-case names; in a browser, only those the drive lets a page read. */
  headers: Record<string, string>;
  body: ArrayBuffer;
}

export type Transport = (provider: ProviderId, request: CloudRequest) => Promise<CloudResponse>;

/**
 * How long one request to a drive may take before it is given up on. Long
 * enough for a range of an upload on a slow line; short enough that a
 * connection that has died does not leave the person waiting for ever (the
 * desktop host bounds its own requests the same way).
 */
export const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/** The browser's: no cookies, no referrer, nothing cached, and never endless. */
export const fetchTransport: Transport = async (_provider, request) => {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Offline, a host the policy refuses, a drive that sent no CORS headers,
    // or a request that took longer than the time above.
    throw new CloudError('network', String(error));
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return { status: response.status, headers, body: await response.arrayBuffer() };
};

/** What the desktop host answers for one request (`cloudHttp` in `core/host-tauri.ts`). */
export type HostHttp = (
  provider: ProviderId,
  method: Method,
  url: string,
  headers: Record<string, string>,
  body?: ArrayBuffer,
) => Promise<CloudResponse>;

const REDIRECTS = 3;

/**
 * The desktop's: the host sends each request and follows no redirect, so it
 * is followed here, up to three times, back through the host — which again
 * sends it only to the drive's own hosts. The bearer token is dropped when a
 * redirect leaves the host it was meant for.
 */
export function hostTransport(http: HostHttp): Transport {
  return async (provider, request) => {
    let { method, url, body } = request;
    const headers: Record<string, string> = { ...request.headers };
    for (let hop = 0; ; hop += 1) {
      let answer: CloudResponse;
      try {
        const bytes = typeof body === 'string' ? (new TextEncoder().encode(body).buffer as ArrayBuffer) : body;
        answer = await http(provider, method, url, headers, bytes);
      } catch (error) {
        throw new CloudError(kindOf(error), String(error));
      }
      const location = answer.headers.location;
      if (answer.status < 300 || answer.status >= 400 || !location || hop >= REDIRECTS) return answer;
      const next = new URL(location, url);
      if (next.host !== new URL(url).host) delete headers.authorization;
      // 303, and 301/302 after a POST, become a GET without a body (as browsers do).
      if (answer.status === 303 || ((answer.status === 301 || answer.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        delete headers['content-type'];
      }
      url = next.href;
    }
  };
}

/** A drive's API, with the session's bearer token: a 401 refreshes the token once and tries again. */
export type Api = (request: CloudRequest) => Promise<CloudResponse>;

export function authorised(session: Session, transport: Transport): Api {
  return async (request) => {
    for (let attempt = 0; ; attempt += 1) {
      const token = await session.accessToken();
      const response = await transport(session.server.provider, {
        ...request,
        headers: { ...request.headers, authorization: `Bearer ${token}` },
      });
      if (response.status !== 401 || attempt > 0) return response;
      session.invalidate(token);
    }
  };
}

/** Requests that must carry no token: a drive's pre-authenticated download and upload addresses. */
export function unauthorised(provider: ProviderId, transport: Transport): Api {
  return (request) => transport(provider, request);
}

export function textOf(response: CloudResponse): string {
  return new TextDecoder().decode(response.body);
}

export function jsonOf<T>(response: CloudResponse): T {
  try {
    return JSON.parse(textOf(response)) as T;
  } catch {
    throw new CloudError('server', `HTTP ${response.status}: the answer is not JSON`);
  }
}

/** The drive's refusal as a `CloudError`, with its own error code when it gave one. */
export function failure(response: CloudResponse, what: string): CloudError {
  let code = '';
  try {
    const body = JSON.parse(textOf(response)) as { error?: { code?: unknown; message?: unknown } | string };
    const error = body.error;
    code = typeof error === 'string' ? error : typeof error?.code === 'string' ? error.code : typeof error?.message === 'string' ? error.message : '';
  } catch {
    /* not JSON: the status says enough */
  }
  return new CloudError(kindOfStatus(response.status), `${what}: HTTP ${response.status}${code ? ` ${code}` : ''}`);
}

export function ok(response: CloudResponse): boolean {
  return response.status >= 200 && response.status < 300;
}
