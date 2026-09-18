/**
 * The two places Warraq can ask a model about a document — the brief's "AI
 * features are bring-your-own-key or local":
 *
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

export type ProviderId = 'claude' | 'local';

/** The Messages API (`POST /v1/messages`, version 2023-06-01). */
export const CLAUDE_ENDPOINT = 'https://api.anthropic.com/v1/messages';
export const CLAUDE_HOST = 'api.anthropic.com';
export const CLAUDE_MODELS = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'] as const;
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';
/**
 * The reply's cap, thinking included (Sonnet 5 and Opus 5 think by default).
 * A request is answered in one piece, and this keeps it to minutes; a reply
 * that reaches the cap is marked as cut off rather than passed off as whole.
 */
export const CLAUDE_MAX_TOKENS = 16_000;

/** Ollama's own address. The app's security policy allows this port and no other. */
export const LOCAL_DEFAULT_URL = 'http://localhost:11434';
/** What the web and desktop policies add to `connect-src` for a local model (`apps/web/src/csp.test.ts`). */
export const LOCAL_ALLOWED_ORIGINS = ['http://localhost:11434', 'http://127.0.0.1:11434'] as const;
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
    }),
  };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export type LocalAddress = { ok: true; base: string } | { ok: false; reason: 'invalid' | 'notLocal' };

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
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
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
export function localRequest(api: LocalApi, base: string, model: string, prompt: Prompt): ProviderRequest {
  const messages = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ];
  const headers = { 'content-type': 'application/json' };
  if (api === 'openai') {
    // An OpenAI-compatible base is often given with its /v1 already.
    const url = /\/v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    return { url, headers, body: JSON.stringify({ model, messages, stream: false }) };
  }
  return {
    url: `${base}/api/chat`,
    headers,
    body: JSON.stringify({
      model,
      messages,
      stream: false,
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
  return { text, cutOff: reply.stop_reason === 'max_tokens' || reply.stop_reason === 'model_context_window_exceeded' };
}

/** Reasoning some local models write before their answer, which is not the answer. */
const THINKING = /<think>[\s\S]*?(<\/think>|$)/g;

export function localAnswer(api: LocalApi, json: unknown): Answer | null {
  let content: unknown;
  let cutOff: boolean;
  if (api === 'openai') {
    const choice = (json as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] } | null)?.choices?.[0];
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
  | { kind: 'cancelled' };

/** An HTTP error from `provider`, with its message when it gave one. */
export function httpFailure(provider: ProviderId, status: number, message: string | null, model: string): Failure {
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
