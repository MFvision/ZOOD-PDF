/**
 * The three places Warraq can ask a model about a document — the brief's
 * "local-first; AI features are bring-your-own-key or local":
 *
 * - This device (the default): a small model run by llama.cpp inside the app
 *   itself — in the desktop host, or in WebAssembly in the page (`device/`).
 *   Nothing leaves the device, no key, no server; the model is downloaded
 *   once, on a click.
 * - Claude, with the person's own Anthropic key, straight from this device to
 *   api.anthropic.com. There is no Warraq server in between and no key ships
 *   with the app.
 * - A model running on the person's own computer, through Ollama's API or an
 *   OpenAI-compatible one.
 *
 * Everything here is a pure function of its inputs, so the tests can pin the
 * exact request each one receives — and that the key goes nowhere except the
 * one header Anthropic reads it from.
 */

export type ProviderId = 'device' | 'claude' | 'local';
export const PROVIDERS: readonly ProviderId[] = ['device', 'claude', 'local'];

/** Room kept for the on-device model's reply, in tokens, inside its 4k window. */
export const DEVICE_REPLY_TOKENS = 1024;

/** The Messages API (`POST /v1/messages`, version 2023-06-01). */
export const CLAUDE_ENDPOINT = 'https://api.anthropic.com/v1/messages';
export const CLAUDE_HOST = 'api.anthropic.com';
export const CLAUDE_MODELS = [
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-haiku-4-5-20251001',
] as const;
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';
/**
 * The reply's cap, thinking included (Sonnet 5 and Opus 5 think by default).
 * The answer is shown as it streams in; one that reaches the cap is marked as
 * cut off rather than passed off as whole.
 */
export const CLAUDE_MAX_TOKENS = 16_000;

/** Ollama's own address. The app's security policy allows it and LM Studio's, and no other port. */
export const LOCAL_DEFAULT_URL = 'http://localhost:11434';
/** LM Studio's server, which speaks the OpenAI-compatible API. */
export const LM_STUDIO_URL = 'http://localhost:1234/v1';
/** What the web and desktop policies add to `connect-src` for a local model (`apps/web/src/csp.test.ts`). */
export const LOCAL_ALLOWED_ORIGINS = [
  'http://localhost:11434',
  'http://127.0.0.1:11434',
  'http://localhost:1234',
  'http://127.0.0.1:1234',
] as const;
export const LOCAL_DEFAULT_MODEL = 'gemma3';
export type LocalApi = 'ollama' | 'openai';
/** Room kept for a local model's reply, in tokens. */
export const LOCAL_REPLY_TOKENS = 4096;
const LOCAL_MIN_CONTEXT = 4096;
const LOCAL_MAX_CONTEXT = 20_480;

/** What a model is asked: the rules apart from the document and the request. */
export interface Prompt {
  system: string;
  user: string;
  /**
   * The shape the answer must have, as a JSON Schema, for the tasks whose
   * answer is data the panel reads (OCR corrections, form values, personal
   * information, tables). Each provider is asked for it its own way; the
   * answer is still checked when it comes back.
   */
  schema?: object;
}

/** One HTTP request, ready for `fetch`. */
export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface Answer {
  text: string;
  /** The reply stopped at its length limit, not at its end. */
  cutOff: boolean;
}

export function claudeRequest(key: string, model: string, prompt: Prompt): ProviderRequest {
  return {
    url: CLAUDE_ENDPOINT,
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      // Anthropic answers a page in a browser only when it says so: the key is
      // then visible to that page, which is the point — it is the person's own.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      // Structured outputs: the answer is JSON of exactly this shape.
      ...(prompt.schema ? { output_config: { format: { type: 'json_schema', schema: prompt.schema } } } : {}),
      // The answer is shown as it is written, not after a silence.
      stream: true,
    }),
  };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export type LocalAddress =
  { ok: true; base: string } | { ok: false; reason: 'invalid' | 'notLocal' };

/**
 * The base address of a local model server, or why it cannot be one. "Local"
 * is a promise that the text stays on this computer, so the host has to be
 * this computer: any other would send the document elsewhere under that name.
 */
export function localAddress(input: string): LocalAddress {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return { ok: false, reason: 'invalid' };
  }
  if (!LOOPBACK.has(url.hostname)) return { ok: false, reason: 'notLocal' };
  return { ok: true, base: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

/**
 * Ollama's context window for this prompt: all of it and the reply. Ollama
 * silently drops the start of a prompt that does not fit, and its default is
 * 4k tokens on a small machine, so this is never left to the default. Arabic
 * costs more tokens per character than English; 1.5 characters a token is
 * the cautious end for the tokenizers local models use.
 */
export function localContext(prompt: Prompt): number {
  const tokens = Math.ceil((prompt.system.length + prompt.user.length) / 1.5) + LOCAL_REPLY_TOKENS;
  return Math.min(LOCAL_MAX_CONTEXT, Math.max(LOCAL_MIN_CONTEXT, Math.ceil(tokens / 2048) * 2048));
}

/** The request to a local server at `base` (from `localAddress`). It carries no key: there is none. */
export function localRequest(
  api: LocalApi,
  base: string,
  model: string,
  prompt: Prompt,
): ProviderRequest {
  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ];
  const headers = { 'content-type': 'application/json' };
  if (api === 'openai') {
    // An OpenAI-compatible base is often given with its /v1 already.
    const url = /\/v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    const shape = prompt.schema ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: prompt.schema } } } : {};
    return { url, headers, body: JSON.stringify({ model, messages, stream: true, ...shape }) };
  }
  return {
    url: `${base}/api/chat`,
    headers,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      // Ollama's structured outputs: its `format` takes the schema itself.
      ...(prompt.schema ? { format: prompt.schema } : {}),
      options: { num_ctx: localContext(prompt), num_predict: LOCAL_REPLY_TOKENS },
    }),
  };
}

/** The text of a Messages API reply: its text blocks, without the (hidden) thinking before them. */
export function claudeAnswer(json: unknown): Answer | null {
  const reply = json as { content?: unknown; stop_reason?: unknown } | null;
  if (!reply || !Array.isArray(reply.content)) return null;
  const text = (reply.content as { type?: unknown; text?: unknown }[])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
  return {
    text,
    cutOff:
      reply.stop_reason === 'max_tokens' || reply.stop_reason === 'model_context_window_exceeded',
  };
}

/** Reasoning some local models write before their answer, which is not the answer. */
const THINKING = /<think>[\s\S]*?(<\/think>|$)/g;

export function localAnswer(api: LocalApi, json: unknown): Answer | null {
  let content: unknown;
  let cutOff: boolean;
  if (api === 'openai') {
    const choice = (
      json as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] } | null
    )?.choices?.[0];
    content = choice?.message?.content;
    cutOff = choice?.finish_reason === 'length';
  } else {
    const reply = json as { message?: { content?: unknown }; done_reason?: unknown } | null;
    content = reply?.message?.content;
    cutOff = reply?.done_reason === 'length';
  }
  if (typeof content !== 'string') return null;
  return { text: content.replace(THINKING, '').trim(), cutOff };
}

/**
 * A streamed reply, read as it arrives: Anthropic's server-sent events,
 * Ollama's lines of JSON, or an OpenAI-compatible server's events. `push`
 * takes the text as it comes, cut anywhere; `text` is the answer so far.
 */
export interface ReplyStream {
  push(chunk: string): void;
  /** The stream has ended: what is left in the buffer is the last unit. */
  end(): void;
  /** The answer so far, without thinking or a local model's reasoning. */
  text(): string;
  /** Thinking has begun and no answer yet: something is happening. */
  thinking(): boolean;
  cutOff(): boolean;
  /** The provider's own words, when it reported a failure mid-stream. */
  error(): string | null;
}

export function replyStream(provider: ProviderId, api: LocalApi): ReplyStream {
  let buffer = '';
  let answer = '';
  let thinking = false;
  let cutOff = false;
  let error: string | null = null;
  // Server-sent events end at a blank line; Ollama's objects at a newline.
  const separator = provider === 'local' && api === 'ollama' ? '\n' : '\n\n';
  const handle = (unit: string) => {
    if (provider === 'local' && api === 'ollama') {
      const json = parse(unit);
      if (!json) return;
      const reply = json as {
        message?: { content?: unknown };
        done_reason?: unknown;
        error?: unknown;
      };
      if (typeof reply.message?.content === 'string') answer += reply.message.content;
      if (reply.done_reason === 'length') cutOff = true;
      if (typeof reply.error === 'string') error = reply.error;
      return;
    }
    const data = unit
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data === '' || data === '[DONE]') return;
    const json = parse(data);
    if (!json) return;
    if (provider === 'claude') {
      const event = json as {
        type?: unknown;
        content_block?: { type?: unknown };
        delta?: { type?: unknown; text?: unknown; stop_reason?: unknown };
        error?: { message?: unknown };
      };
      if (event.type === 'content_block_start' && event.content_block?.type === 'thinking')
        thinking = true;
      if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string')
        answer += event.delta.text;
      if (event.type === 'message_delta') {
        const stop = event.delta?.stop_reason;
        if (stop === 'max_tokens' || stop === 'model_context_window_exceeded') cutOff = true;
      }
      if (event.type === 'error')
        error = typeof event.error?.message === 'string' ? event.error.message : 'error';
      return;
    }
    const choice = (
      json as { choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[] }
    ).choices?.[0];
    if (typeof choice?.delta?.content === 'string') answer += choice.delta.content;
    if (choice?.finish_reason === 'length') cutOff = true;
    const failed = providerMessage(json);
    if (failed) error = failed;
  };
  return {
    push(chunk) {
      buffer += chunk.replace(/\r\n/g, '\n');
      let at = buffer.indexOf(separator);
      while (at >= 0) {
        handle(buffer.slice(0, at));
        buffer = buffer.slice(at + separator.length);
        at = buffer.indexOf(separator);
      }
    },
    end() {
      if (buffer.trim().length > 0) handle(buffer);
      buffer = '';
    },
    text: () => (provider === 'local' ? answer.replace(THINKING, '').trim() : answer),
    thinking: () => thinking && answer.length === 0,
    cutOff: () => cutOff,
    error: () => error,
  };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The provider's own words for a failure — Anthropic's, Ollama's or an OpenAI-style server's shape. */
export function providerMessage(json: unknown): string | null {
  const error = (json as { error?: unknown } | null)?.error;
  if (typeof error === 'string') return error;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : null;
}

/** Why nothing useful came back, in terms a person can act on. */
export type Failure =
  | { kind: 'key' }
  | { kind: 'rate' }
  | { kind: 'busy' }
  | { kind: 'billing' }
  | { kind: 'denied' }
  | { kind: 'model'; model: string }
  | { kind: 'tooLarge' }
  | { kind: 'server'; status: number }
  | { kind: 'other'; status: number; message: string }
  | { kind: 'offline'; host: string }
  | { kind: 'localDown'; url: string }
  | { kind: 'blocked'; url: string }
  | { kind: 'empty' }
  | { kind: 'cancelled' }
  /** The on-device model is not downloaded yet. */
  | { kind: 'modelMissing' }
  /** The on-device engine failed, in its own words. */
  | { kind: 'device'; message: string };

/** An HTTP error from `provider`, with its message when it gave one. */
export function httpFailure(
  provider: ProviderId,
  status: number,
  message: string | null,
  model: string,
): Failure {
  if (status === 401 && provider === 'claude') return { kind: 'key' };
  if (status === 402) return { kind: 'billing' };
  if (status === 403 && provider === 'claude') return { kind: 'denied' };
  // A model the server does not have: Ollama says "… not found, try pulling it first".
  if (status === 404 && /model/i.test(message ?? '')) return { kind: 'model', model };
  if (status === 413) return { kind: 'tooLarge' };
  if (status === 429) return { kind: 'rate' };
  if (status === 529 || status === 503) return { kind: 'busy' };
  if (status >= 500) return { kind: 'server', status };
  return { kind: 'other', status, message: message ?? '' };
}
