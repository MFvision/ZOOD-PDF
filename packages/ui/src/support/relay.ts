import { ABOUT } from '../settings/about';
import { readJson, writeJson } from '../state/preferences';
import { SUPPORT } from './config';

/**
 * The few calls Help & Support makes to ZOOD's relay. Each one is a click:
 * sending a report, opening the ideas, voting, looking at a report's status.
 * The relay keeps the GitHub key; the app holds no secret at all, only a
 * random number for this install, so one install has one vote per idea and
 * its own reports only.
 */

const INSTALL_KEY = 'warraq.support.install';

/** A random id made once per install. It names no person and no device. */
export function installId(): string {
  const kept = readJson<string | null>(INSTALL_KEY, null);
  if (typeof kept === 'string' && /^[0-9a-f-]{36}$/.test(kept)) return kept;
  const made = globalThis.crypto?.randomUUID?.() ?? fallbackUuid();
  writeJson(INSTALL_KEY, made);
  return made;
}

function fallbackUuid(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class RelayError extends Error {
  constructor(
    /** `offline`: no answer at all (not uploaded yet, no network); `refused`: it answered no. */
    readonly kind: 'offline' | 'refused' | 'busy',
    message: string,
  ) {
    super(message);
  }
}

export interface RelayOptions {
  fetcher?: typeof fetch;
  base?: string;
  timeoutMs?: number;
}

/** One call: JSON in, JSON out, given up after the timeout. */
export async function relay<T>(action: string, body: Record<string, unknown> | null, options: RelayOptions = {}, query = ''): Promise<T> {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const url = `${options.base ?? SUPPORT.relay}?a=${encodeURIComponent(action)}${query ? `&${query}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? SUPPORT.timeoutMs);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: body ? 'POST' : 'GET',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-Zood-App': ABOUT.version },
      body: body ? JSON.stringify({ ...body, install: installId() }) : undefined,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (error) {
    throw new RelayError('offline', String(error));
  } finally {
    clearTimeout(timer);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    // A page that is not the relay's (a hosting error page, a 404) is "not there yet".
    throw new RelayError('offline', `not the relay (${response.status})`);
  }
  if (response.status === 429) throw new RelayError('busy', 'too many');
  if (!response.ok || !data || typeof data !== 'object' || (data as { ok?: unknown }).ok !== true) {
    const message = (data as { error?: unknown } | null)?.error;
    throw new RelayError(response.status >= 500 ? 'offline' : 'refused', typeof message === 'string' ? message : `status ${response.status}`);
  }
  return data as T;
}

/** A GET with the install in the address (GET has no body). */
export function relayGet<T>(action: string, params: Record<string, string>, options: RelayOptions = {}): Promise<T> {
  const query = new URLSearchParams({ ...params, install: installId() }).toString();
  return relay<T>(action, null, options, query);
}
