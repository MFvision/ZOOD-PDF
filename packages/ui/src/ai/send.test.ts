import { describe, expect, it } from 'vitest';
import { preflightFor } from './preflight';
import type { ProviderSettings } from './preflight';
import { send } from './send';
import type { SendOptions } from './send';

const KEY = 'sk-ant-api03-not-a-real-key-0123456789';
const read = { sent: [{ page: 1, text: 'صباح الخير' }], left: [], characters: 10 };
const context = { lang: 'en' as const, pageCount: 1, budget: 150_000 };
const claude = preflightFor({ provider: 'claude', model: 'claude-sonnet-5' }, { kind: 'summarize' }, read, context);
const localSettings: ProviderSettings = { provider: 'local', api: 'ollama', base: 'http://localhost:11434', model: 'gemma3' };
const local = preflightFor(localSettings, { kind: 'summarize' }, read, context);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** `send` with a fetch that answers `reply`, recording what it was asked, and a policy that refuses when told to. */
function harness(reply: () => Promise<Response>, refused = false) {
  const calls: { url: string; init: RequestInit }[] = [];
  const options: SendOptions = {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return reply();
    },
    watch: () => ({ refused: () => refused, stop: () => undefined }),
    settle: async () => undefined,
  };
  return { calls, options };
}

describe('sending', () => {
  it('makes one request, with no cookies, no referrer and no redirects, and reads the answer', async () => {
    const { calls, options } = harness(async () =>
      json({ type: 'message', content: [{ type: 'text', text: 'A greeting [p. 1].' }], stop_reason: 'end_turn' }),
    );
    const outcome = await send(claude, KEY, new AbortController().signal, options);
    expect(outcome).toEqual({ ok: true, answer: { text: 'A greeting [p. 1].', cutOff: false } });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call?.init).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
    expect((call?.init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
  });

  it('reads a local reply, and sends no key there', async () => {
    const { calls, options } = harness(async () => json({ message: { role: 'assistant', content: 'تحية' }, done: true }));
    const outcome = await send(local, KEY, new AbortController().signal, options);
    expect(outcome).toEqual({ ok: true, answer: { text: 'تحية', cutOff: false } });
    expect(calls[0]?.url).toBe('http://localhost:11434/api/chat');
    expect(JSON.stringify(calls[0])).not.toContain(KEY);
  });

  it('turns an HTTP error into what it means', async () => {
    const wrongKey = harness(async () =>
      json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401),
    );
    expect(await send(claude, KEY, new AbortController().signal, wrongKey.options)).toEqual({ ok: false, failure: { kind: 'key' } });
    const limited = harness(async () => json({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429));
    expect(await send(claude, KEY, new AbortController().signal, limited.options)).toEqual({ ok: false, failure: { kind: 'rate' } });
    const missing = harness(async () => json({ error: 'model "gemma3" not found, try pulling it first' }, 404));
    expect(await send(local, '', new AbortController().signal, missing.options)).toEqual({
      ok: false,
      failure: { kind: 'model', model: 'gemma3' },
    });
  });

  it('tells no network from a server that is not running', async () => {
    const down = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await send(claude, KEY, new AbortController().signal, harness(down).options)).toEqual({
      ok: false,
      failure: { kind: 'offline', host: 'api.anthropic.com' },
    });
    expect(await send(local, '', new AbortController().signal, harness(down).options)).toEqual({
      ok: false,
      failure: { kind: 'localDown', url: 'http://localhost:11434' },
    });
  });

  it('tells an address the security policy refused from one that did not answer', async () => {
    const other = preflightFor({ ...localSettings, base: 'http://localhost:9' }, { kind: 'summarize' }, read, context);
    const refused = harness(() => Promise.reject(new TypeError('Failed to fetch')), true);
    expect(await send(other, '', new AbortController().signal, refused.options)).toEqual({
      ok: false,
      failure: { kind: 'blocked', url: 'http://localhost:9' },
    });
  });

  it('stops waiting when asked', async () => {
    const controller = new AbortController();
    const { options } = harness(() => {
      controller.abort();
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
    expect(await send(claude, KEY, controller.signal, options)).toEqual({ ok: false, failure: { kind: 'cancelled' } });
  });

  it('says so when the model returns nothing', async () => {
    const { options } = harness(async () => json({ type: 'message', content: [], stop_reason: 'end_turn' }));
    expect(await send(claude, KEY, new AbortController().signal, options)).toEqual({ ok: false, failure: { kind: 'empty' } });
  });
});
