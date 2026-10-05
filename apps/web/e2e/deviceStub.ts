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
}

export async function installDeviceStub(page: Page, answer: (messages: { role: string; content: string }[]) => string): Promise<void> {
  await page.addInitScript(
    ({ source }) => {
      const answerFor = new Function('messages', `return (${source})(messages);`) as (messages: { role: string; content: string }[]) => string;
      const record: StubRecord = { downloads: 0, removed: 0, ready: false, requests: [], aborted: 0 };
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
          options: { grammar?: string; maxTokens: number; onToken: (t: string) => void; signal: AbortSignal },
        ) => {
          record.requests.push({ messages, grammar: options.grammar ?? null, maxTokens: options.maxTokens });
          const text = answerFor(messages);
          let out = '';
          for (const word of text.split(/(?<=\s)/)) {
            await new Promise((resolve) => setTimeout(resolve, 15));
            if (options.signal.aborted) throw new Error('aborted');
            out += word;
            options.onToken(word);
          }
          return { text: out, cutOff: false, tokens: out.length, ms: 1 };
        },
      });
    },
    { source: answer.toString() },
  );
}

export function stubRecord(page: Page): Promise<StubRecord> {
  return page.evaluate(() => (globalThis as unknown as { __deviceStub: StubRecord }).__deviceStub);
}
