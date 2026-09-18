import { requestFor } from './preflight';
import type { Preflight } from './preflight';
import { CLAUDE_HOST, claudeAnswer, httpFailure, localAnswer, providerMessage } from './providers';
import type { Answer, Failure } from './providers';

export type Outcome = { ok: true; answer: Answer } | { ok: false; failure: Failure };

/** The page's security policy, watched for a connection it refuses while a request runs. */
export interface PolicyWatch {
  refused(url: string): boolean;
  stop(): void;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * A fetch the CSP refuses fails exactly like one with no network: a
 * `TypeError`. The policy says which it was, through a
 * `securitypolicyviolation` event on the document — the only way to tell a
 * person "this build does not allow that address" instead of "not running".
 */
export function watchPolicy(): PolicyWatch {
  const refused: string[] = [];
  const target = globalThis.document;
  const listen = (event: Event) => {
    const { effectiveDirective, blockedURI } = event as SecurityPolicyViolationEvent;
    if (effectiveDirective === 'connect-src') refused.push(blockedURI);
  };
  target?.addEventListener('securitypolicyviolation', listen);
  return {
    refused: (url) => refused.some((blocked) => blocked === '' || sameOrigin(blocked, url)),
    stop: () => target?.removeEventListener('securitypolicyviolation', listen),
  };
}

export interface SendOptions {
  fetch?: typeof fetch;
  watch?: () => PolicyWatch;
  /** Waits for a policy report, which the browser delivers as a task of its own after the failure. */
  settle?: () => Promise<void>;
}

const settleDefault = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

/**
 * Sends what `preflight` shows — nothing more — and reads the reply. The
 * only place in Warraq a document's text leaves the device, and only from
 * the Send button. No cookies go with it, no referrer (the extension's page
 * address can name the site it was opened from), and no redirect is
 * followed: the text goes to the host the preflight named, or nowhere.
 */
export async function send(preflight: Preflight, key: string, signal: AbortSignal, options: SendOptions = {}): Promise<Outcome> {
  const { settings } = preflight;
  const request = requestFor(preflight, key);
  const fail = (failure: Failure): Outcome => ({ ok: false, failure });
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const policy = (options.watch ?? watchPolicy)();
  let response: Response;
  try {
    response = await doFetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      cache: 'no-store',
    });
  } catch {
    if (signal.aborted) return fail({ kind: 'cancelled' });
    await (options.settle ?? settleDefault)();
    if (policy.refused(request.url)) {
      return fail({ kind: 'blocked', url: settings.provider === 'claude' ? CLAUDE_HOST : settings.base });
    }
    return fail(settings.provider === 'claude' ? { kind: 'offline', host: CLAUDE_HOST } : { kind: 'localDown', url: settings.base });
  } finally {
    policy.stop();
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    /* no JSON: the status alone has to explain it */
  }
  if (signal.aborted) return fail({ kind: 'cancelled' });
  if (!response.ok) return fail(httpFailure(settings.provider, response.status, providerMessage(json), settings.model));
  const answer = settings.provider === 'claude' ? claudeAnswer(json) : localAnswer(settings.api, json);
  if (!answer || answer.text.trim().length === 0) return fail({ kind: 'empty' });
  return { ok: true, answer };
}
