import type { Page } from '@playwright/test';

/**
 * The on-device engine, faked inside the page: the browser tests prove the
 * "On this device" provider — the download button, the verification, the
 * preflight, the streamed answer, the reviewed data answers — without any
 * test ever downloading a model or running llama.cpp. The stub is installed
 * before the app loads, on the hook `deviceEngine` looks for; nothing in a
 * shipped page sets it.
 *
 * `answer` is run inside the page for every request, with the messages the
 * panel built; what it returns is streamed back word by word.
 */
export interface StubRecord {
  downloads: number;
  removed: number;
  ready: boolean;
  requests: { messages: { role: string; content: string }[]; grammar: string | null; maxTokens: number }[];
  aborted: number;
  /** Requests the engine refused as over its window. */
  refused: number;
}

export interface StubOptions {
  /**
   * Gives the engine a window, as the host's has: a request is refused
   * (`E_TOO_LONG`, the host's own words) when it and its reply do not fit,
   * counting a token for every this many characters.
   */
  charsPerToken?: number;
  /** Milliseconds between the words of an answer (15 when not given). */
  pace?: number;
}

export async function installDeviceStub(page: Page, answer: (messages: { role: string; content: string }[]) => string, options: StubOptions = {}): Promise<void> {
  // The answer is worked out here, in the test, and asked for from the page:
  // nothing is built from source text in the page (no eval, as in the app).
  await page.exposeFunction('__deviceStubAnswer', answer);
  await page.addInitScript(
    ({ charsPerToken, pace }) => {
      const answerFor = (globalThis as unknown as { __deviceStubAnswer: (messages: { role: string; content: string }[]) => Promise<string> }).__deviceStubAnswer;
      const record: StubRecord = { downloads: 0, removed: 0, ready: false, requests: [], aborted: 0, refused: 0 };
      (globalThis as unknown as { __deviceStub: StubRecord }).__deviceStub = record;
      (globalThis as unknown as { __WARRAQ_DEVICE_ENGINE__: unknown }).__WARRAQ_DEVICE_ENGINE__ = (model: { bytes: number }) => ({
        model,
        runtime: async () => 'test',
        memoryGiB: async () => 8,
        status: async () => (record.ready ? { kind: 'ready', bytes: model.bytes } : { kind: 'missing' }),
        download: async (onProgress: (received: number, total: number) => void, signal: AbortSignal) => {
          record.downloads += 1;
          for (const share of [0.25, 0.5, 1]) {
            await new Promise((resolve) => setTimeout(resolve, 60));
            if (signal.aborted) {
              record.aborted += 1;
              throw new Error('aborted');
            }
            onProgress(Math.round(model.bytes * share), model.bytes);
          }
          record.ready = true;
        },
        remove: async () => {
          record.removed += 1;
          record.ready = false;
        },
        generate: async (
          messages: { role: string; content: string }[],
          options: { grammar?: string; maxTokens: number; contextTokens?: number; onToken: (t: string) => void; signal: AbortSignal },
        ) => {
          if (charsPerToken) {
            const tokens = Math.ceil(messages.reduce((sum, message) => sum + message.content.length, 0) / charsPerToken);
            const context = options.contextTokens ?? 4096;
            if (tokens + options.maxTokens > context) {
              record.refused += 1;
              throw new Error(`E_TOO_LONG: the request is ${tokens} tokens; the window holds ${context - options.maxTokens} with the reply`);
            }
          }
          record.requests.push({ messages, grammar: options.grammar ?? null, maxTokens: options.maxTokens });
          const text = await answerFor(messages);
          let out = '';
          for (const word of text.split(/(?<=\s)/)) {
            await new Promise((resolve) => setTimeout(resolve, pace ?? 15));
            if (options.signal.aborted) {
              record.aborted += 1;
              throw new Error('aborted');
            }
            out += word;
            options.onToken(word);
          }
          return { text: out, cutOff: false, tokens: out.length, ms: 1 };
        },
      });
    },
    { charsPerToken: options.charsPerToken ?? 0, pace: options.pace ?? 15 },
  );
}

export function stubRecord(page: Page): Promise<StubRecord> {
  return page.evaluate(() => (globalThis as unknown as { __deviceStub: StubRecord }).__deviceStub);
}
