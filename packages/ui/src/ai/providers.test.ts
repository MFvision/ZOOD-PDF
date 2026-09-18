import { describe, expect, it } from 'vitest';
import {
  CLAUDE_MAX_TOKENS,
  LOCAL_REPLY_TOKENS,
  claudeAnswer,
  claudeRequest,
  httpFailure,
  localAddress,
  localAnswer,
  localContext,
  localRequest,
  providerMessage,
} from './providers';

const KEY = 'sk-ant-api03-not-a-real-key-0123456789';
const prompt = {
  system: 'Rules.',
  user: '<document>\n<page number="1">\nصباح الخير\n</page>\n</document>\n\nSummarize this document in English.',
};

describe('the request to Claude', () => {
  it('is exactly the Messages API call the documentation gives', () => {
    const request = claudeRequest(KEY, 'claude-sonnet-5', prompt);
    expect(request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
    expect(JSON.parse(request.body)).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: CLAUDE_MAX_TOKENS,
      system: 'Rules.',
      messages: [{ role: 'user', content: prompt.user }],
    });
  });

  it('carries the key in its one header and nowhere else', () => {
    const request = claudeRequest(KEY, 'claude-opus-5', prompt);
    const { 'x-api-key': key, ...others } = request.headers;
    expect(key).toBe(KEY);
    expect(JSON.stringify(others)).not.toContain(KEY);
    expect(request.url).not.toContain(KEY);
    expect(request.body).not.toContain(KEY);
  });

  it('sends the Arabic exactly as it was read, not escaped or reordered', () => {
    expect(claudeRequest(KEY, 'claude-sonnet-5', prompt).body).toContain('صباح الخير');
  });
});

describe('the request to a local model', () => {
  it("is Ollama's /api/chat, in one piece, with room for the whole prompt", () => {
    const request = localRequest('ollama', 'http://localhost:11434', 'gemma3', prompt);
    expect(request.url).toBe('http://localhost:11434/api/chat');
    expect(request.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(request.body)).toEqual({
      model: 'gemma3',
      messages: [
        { role: 'system', content: 'Rules.' },
        { role: 'user', content: prompt.user },
      ],
      stream: false,
      options: { num_ctx: localContext(prompt), num_predict: LOCAL_REPLY_TOKENS },
    });
  });

  it('is /v1/chat/completions on an OpenAI-compatible server, with or without /v1 in its address', () => {
    const body = {
      model: 'qwen2.5',
      messages: [
        { role: 'system', content: 'Rules.' },
        { role: 'user', content: prompt.user },
      ],
      stream: false,
    };
    const plain = localRequest('openai', 'http://127.0.0.1:11434', 'qwen2.5', prompt);
    expect(plain.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(plain.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(plain.body)).toEqual(body);
    expect(localRequest('openai', 'http://localhost:1234/v1', 'qwen2.5', prompt).url).toBe(
      'http://localhost:1234/v1/chat/completions',
    );
  });

  it('gives the model a context window that holds all of a full request and its reply', () => {
    // A full local budget of Arabic, the longest question, and the rules.
    const full = { system: 'r'.repeat(1_200), user: 'ع'.repeat(16_000 + 2_000 + 600) };
    const context = localContext(full);
    expect(context).toBeGreaterThanOrEqual(Math.ceil((1_200 + 18_600) / 1.5) + LOCAL_REPLY_TOKENS);
    expect(context % 2048).toBe(0);
    expect(localContext({ system: 'r', user: 'u' })).toBe(6144);
  });
});

describe('a local address', () => {
  it('is kept to this computer', () => {
    expect(localAddress('http://localhost:11434')).toEqual({
      ok: true,
      base: 'http://localhost:11434',
    });
    expect(localAddress(' http://127.0.0.1:11434/ ')).toEqual({
      ok: true,
      base: 'http://127.0.0.1:11434',
    });
    expect(localAddress('http://[::1]:11434')).toEqual({ ok: true, base: 'http://[::1]:11434' });
    expect(localAddress('http://localhost:1234/v1/')).toEqual({
      ok: true,
      base: 'http://localhost:1234/v1',
    });
    for (const elsewhere of [
      'http://192.168.1.20:11434',
      'https://ollama.example.com',
      'http://localhost.example.com:11434',
    ]) {
      expect(localAddress(elsewhere), elsewhere).toEqual({ ok: false, reason: 'notLocal' });
    }
    for (const broken of [
      '',
      'localhost:11434',
      'ftp://localhost:11434',
      'http://user:secret@localhost:11434',
      'http://localhost:11434/?key=1',
    ]) {
      expect(localAddress(broken), broken).toEqual({ ok: false, reason: 'invalid' });
    }
  });
});

describe('a reply', () => {
  it('from Claude is its text blocks, without the thinking before them', () => {
    const reply = {
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: 'The recovery is uneven ' },
        { type: 'text', text: '[p. 1].' },
      ],
      stop_reason: 'end_turn',
    };
    expect(claudeAnswer(reply)).toEqual({ text: 'The recovery is uneven [p. 1].', cutOff: false });
    expect(claudeAnswer({ ...reply, stop_reason: 'max_tokens' })?.cutOff).toBe(true);
    expect(claudeAnswer({ type: 'error' })).toBeNull();
    expect(claudeAnswer(null)).toBeNull();
  });

  it("from Ollama is its message, without a thinking model's reasoning", () => {
    const reply = {
      message: { role: 'assistant', content: '<think>Let me see.</think>\nملخص [p. 2]' },
      done: true,
      done_reason: 'stop',
    };
    expect(localAnswer('ollama', reply)).toEqual({ text: 'ملخص [p. 2]', cutOff: false });
    expect(localAnswer('ollama', { ...reply, done_reason: 'length' })?.cutOff).toBe(true);
    expect(localAnswer('ollama', { error: 'boom' })).toBeNull();
  });

  it('from an OpenAI-compatible server is its first choice', () => {
    const reply = {
      choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'length' }],
    };
    expect(localAnswer('openai', reply)).toEqual({ text: 'Hello', cutOff: true });
  });

  it("that failed is read in each provider's own words", () => {
    expect(
      providerMessage({
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      }),
    ).toBe('invalid x-api-key');
    expect(providerMessage({ error: 'model "llama9" not found, try pulling it first' })).toBe(
      'model "llama9" not found, try pulling it first',
    );
    expect(
      providerMessage({ error: { message: 'bad request', type: 'invalid_request_error' } }),
    ).toBe('bad request');
    expect(providerMessage('not json')).toBeNull();
  });
});

describe('a failure', () => {
  it('is named for what the person can do about it', () => {
    expect(httpFailure('claude', 401, 'invalid x-api-key', 'claude-sonnet-5')).toEqual({
      kind: 'key',
    });
    expect(httpFailure('claude', 429, 'rate', 'claude-sonnet-5')).toEqual({ kind: 'rate' });
    expect(httpFailure('claude', 529, 'Overloaded', 'claude-sonnet-5')).toEqual({ kind: 'busy' });
    expect(httpFailure('local', 503, null, 'gemma3')).toEqual({ kind: 'busy' });
    expect(httpFailure('claude', 402, null, 'claude-sonnet-5')).toEqual({ kind: 'billing' });
    expect(httpFailure('claude', 403, null, 'claude-opus-5')).toEqual({ kind: 'denied' });
    expect(
      httpFailure('local', 404, 'model "gemma3" not found, try pulling it first', 'gemma3'),
    ).toEqual({ kind: 'model', model: 'gemma3' });
    expect(httpFailure('local', 404, '404 page not found', 'gemma3')).toEqual({
      kind: 'other',
      status: 404,
      message: '404 page not found',
    });
    expect(httpFailure('claude', 413, null, 'claude-sonnet-5')).toEqual({ kind: 'tooLarge' });
    expect(httpFailure('claude', 500, null, 'claude-sonnet-5')).toEqual({
      kind: 'server',
      status: 500,
    });
    expect(httpFailure('claude', 400, 'prompt is too long', 'claude-haiku-4-5-20251001')).toEqual({
      kind: 'other',
      status: 400,
      message: 'prompt is too long',
    });
    // A local server has no key to be wrong about.
    expect(httpFailure('local', 401, 'unauthorized', 'gemma3')).toEqual({
      kind: 'other',
      status: 401,
      message: 'unauthorized',
    });
  });
});
