import { describe, expect, it } from 'vitest';
import { preflightFor } from './preflight';
import type { ProviderSettings } from './preflight';
import { send, watchPolicy } from './send';
import type { SendOptions } from './send';

const KEY = 'sk-ant-api03-not-a-real-key-0123456789';
const read = { sent: [{ page: 1, text: 'صباح الخير' }], left: [], characters: 10 };
const context = { lang: 'en' as const, pageCount: 1, budget: 150_000 };
const claude = preflightFor(
  { provider: 'claude', model: 'claude-sonnet-5' },
  { kind: 'summarize' },
  read,
  context,
);
const localSettings: ProviderSettings = {
  provider: 'local',
  api: 'ollama',
  base: 'http://localhost:11434',
  model: 'gemma3',
};
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
      json({
        type: 'message',
        content: [{ type: 'text', text: 'A greeting [p. 1].' }],
        stop_reason: 'end_turn',
      }),
    );
    const outcome = await send(claude, KEY, new AbortController().signal, options);
    expect(outcome).toEqual({ ok: true, answer: { text: 'A greeting [p. 1].', cutOff: false } });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call?.init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
    });
    expect((call?.init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
  });

  it('reads a local reply, and sends no key there', async () => {
    const { calls, options } = harness(async () =>
      json({ message: { role: 'assistant', content: 'تحية' }, done: true }),
    );
    const outcome = await send(local, KEY, new AbortController().signal, options);
    expect(outcome).toEqual({ ok: true, answer: { text: 'تحية', cutOff: false } });
    expect(calls[0]?.url).toBe('http://localhost:11434/api/chat');
    expect(JSON.stringify(calls[0])).not.toContain(KEY);
  });

  it('turns an HTTP error into what it means', async () => {
    const wrongKey = harness(async () =>
      json(
        { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
        401,
      ),
    );
    expect(await send(claude, KEY, new AbortController().signal, wrongKey.options)).toEqual({
      ok: false,
      failure: { kind: 'key' },
    });
    const limited = harness(async () =>
      json({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429),
    );
    expect(await send(claude, KEY, new AbortController().signal, limited.options)).toEqual({
      ok: false,
      failure: { kind: 'rate' },
    });
    const missing = harness(async () =>
      json({ error: 'model "gemma3" not found, try pulling it first' }, 404),
    );
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
    const other = preflightFor(
      { ...localSettings, base: 'http://localhost:11435' },
      { kind: 'summarize' },
      read,
      context,
    );
    const refused = harness(() => Promise.reject(new TypeError('Failed to fetch')), true);
    expect(await send(other, '', new AbortController().signal, refused.options)).toEqual({
      ok: false,
      failure: { kind: 'blocked', url: 'http://localhost:11435' },
    });
  });

  it('stops waiting when asked', async () => {
    const controller = new AbortController();
    const { options } = harness(() => {
      controller.abort();
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
    expect(await send(claude, KEY, controller.signal, options)).toEqual({
      ok: false,
      failure: { kind: 'cancelled' },
    });
  });

  it('says so when the model returns nothing', async () => {
    const { options } = harness(async () =>
      json({ type: 'message', content: [], stop_reason: 'end_turn' }),
    );
    expect(await send(claude, KEY, new AbortController().signal, options)).toEqual({
      ok: false,
      failure: { kind: 'empty' },
    });
  });
});

describe('the policy watch', () => {
  it('hears a connection the policy refused to that address, and nothing else', () => {
    const target = new EventTarget();
    Object.defineProperty(globalThis, 'document', { configurable: true, value: target });
    try {
      const refusal = (effectiveDirective: string, blockedURI: string) =>
        Object.assign(new Event('securitypolicyviolation'), { effectiveDirective, blockedURI });
      const watch = watchPolicy();
      target.dispatchEvent(refusal('img-src', 'http://localhost:11435/logo.png'));
      expect(watch.refused('http://localhost:11435/api/chat')).toBe(false);
      target.dispatchEvent(refusal('connect-src', 'http://localhost:11435/api/chat'));
      expect(watch.refused('http://localhost:11435/api/chat')).toBe(true);
      expect(watch.refused('https://api.anthropic.com/v1/messages')).toBe(false);
      watch.stop();
      const after = watchPolicy();
      after.stop();
      target.dispatchEvent(refusal('connect-src', 'http://localhost:11435/api/chat'));
      expect(after.refused('http://localhost:11435/api/chat')).toBe(false);
    } finally {
      Reflect.deleteProperty(globalThis, 'document');
    }
  });
});

/** A reply that streams `chunks` — and, like fetch, fails its body when the request is aborted; `hold` leaves it open. */
function streamingHarness(chunks: string[], type = 'text/event-stream', hold = false) {
  const seen: string[] = [];
  const options: SendOptions = {
    fetch: async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          if (!hold) controller.close();
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('aborted', 'AbortError')),
          );
        },
      });
      return new Response(body, { headers: { 'content-type': type } });
    },
    watch: () => ({ refused: () => false, stop: () => undefined }),
    settle: async () => undefined,
    onText: (text) => seen.push(text),
  };
  return { seen, options };
}

const event = (e: object) => `event: x\ndata: ${JSON.stringify(e)}\n\n`;
const delta = (text: string) =>
  event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });

describe('a streamed answer', () => {
  it('is shown as it arrives, and returned whole', async () => {
    const { seen, options } = streamingHarness([
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      delta('صباح '),
      delta('الخير'),
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    ]);
    const outcome = await send(claude, KEY, new AbortController().signal, options);
    expect(outcome).toEqual({ ok: true, answer: { text: 'صباح الخير', cutOff: false } });
    expect(seen).toContain('صباح ');
    expect(seen.at(-1)).toBe('صباح الخير');
  });

  it('keeps what had arrived when Stop is pressed, marked as cut off', async () => {
    const controller = new AbortController();
    const { options } = streamingHarness([delta('نصف الجواب')], 'text/event-stream', true);
    const pending = send(claude, KEY, controller.signal, {
      ...options,
      onText: (text) => {
        if (text.length > 0) controller.abort();
      },
    });
    expect(await pending).toEqual({ ok: true, answer: { text: 'نصف الجواب', cutOff: true } });
  });

  it('is cancelled, not empty, when Stop comes before any of it', async () => {
    const controller = new AbortController();
    const { options } = streamingHarness([event({ type: 'ping' })], 'text/event-stream', true);
    const pending = send(claude, KEY, controller.signal, {
      ...options,
      onText: () => controller.abort(),
    });
    expect(await pending).toEqual({ ok: false, failure: { kind: 'cancelled' } });
  });

  it("reads Ollama's lines as they come", async () => {
    const { options } = streamingHarness(
      [
        '{"message":{"content":"ملخص "}}\n{"message":{"con',
        'tent":"محلي"},"done":true,"done_reason":"stop"}\n',
      ],
      'application/x-ndjson',
    );
    const outcome = await send(local, '', new AbortController().signal, options);
    expect(outcome).toEqual({ ok: true, answer: { text: 'ملخص محلي', cutOff: false } });
  });

  it('says why when the provider reports an error in the middle of it', async () => {
    const { options } = streamingHarness([
      delta('بدأ'),
      event({ type: 'error', error: { message: 'Overloaded' } }),
    ]);
    const outcome = await send(claude, KEY, new AbortController().signal, options);
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: 'other', status: 200, message: 'Overloaded' },
    });
  });
});
