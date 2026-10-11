import { describe, expect, it } from 'vitest';
import { budgetFor, takeWithinBudget } from '../budget';
import type { PageText } from '../budget';
import { SMALL_CONTEXT, estimateTokens, replyTokensFor } from '../device/context';
import type { ChatMessage, DeviceEngine, Generated, GenerateOptions } from '../device/engine';
import { deviceBudget, generateOnDevice } from '../device/generate';
import { deviceModel } from '../device/models';
import { preflightFor } from '../preflight';
import { DEVICE_REPLY_TOKENS } from '../providers';
import { answerTurn } from './answer';
import type { DocumentText } from './answer';
import { memoryKept } from './kept';
import { charsPerToken, deviceRunner } from './runner';

/**
 * Why "the answer doesn't appear" (the owner's report, 2026-10-11), kept as
 * a test. The one-shot form gave the on-device model 4,000 characters of the
 * document, on the reckoning that Arabic costs a token for every 1.5
 * characters; the model's window is counted in tokens, and the host refuses
 * a request that does not fit it (`E_TOO_LONG`, `src-tauri/src/ai.rs`). Real
 * documents cost more: the corpus's Saudi copyright law — an ordinary law,
 * set in a legacy Arabic encoding — is 1.21 characters a token, so its first
 * 3,581 characters with the rules came to 3,198 tokens against the 3,072 the
 * window held, and the request failed before a word was written (measured
 * with the real model, `realModel.test.ts`; docs/STATUS.md).
 *
 * The engine here has a window as the host's has, and counts a token for
 * every `rate` characters of Arabic.
 */
interface Windowed extends DeviceEngine {
  asked: { tokens: number; content: string; maxTokens: number; contextTokens: number }[];
}

function windowed(rate: number, counts: boolean): Windowed {
  // The rules and the tags are English, four characters a token; the document's own text costs `rate`.
  const count = (text: string) => {
    const latin = text.match(/[\x20-\x7e\n]/g)?.length ?? 0;
    return Math.ceil(latin / 4 + (text.length - latin) / rate);
  };
  const asked: Windowed['asked'] = [];
  return {
    asked,
    model: deviceModel('qwen2.5-1.5b'),
    runtime: async () => 'test',
    memoryGiB: async () => 8,
    status: async () => ({ kind: 'ready', bytes: 1 }),
    download: async () => undefined,
    remove: async () => undefined,
    ...(counts ? { countTokens: async (text: string) => count(text) } : {}),
    generate: async (messages: readonly ChatMessage[], options: GenerateOptions): Promise<Generated> => {
      const context = options.contextTokens ?? SMALL_CONTEXT;
      const tokens = count(messages.map((message) => message.content).join('\n'));
      // The host's own check, word for word.
      if (tokens + options.maxTokens > context) throw new Error(`E_TOO_LONG: the request is ${tokens} tokens; the window holds ${context - options.maxTokens} with the reply`);
      asked.push({ tokens, content: messages[1]?.content ?? '', maxTokens: options.maxTokens, contextTokens: context });
      options.onToken('An answer.');
      return { text: 'An answer.', cutOff: false, tokens: 3, ms: 1 };
    },
  };
}

/** Pages of about 700 characters each, like the law's. */
function pagesOf(count: number): PageText[] {
  return Array.from({ length: count }, (_, index) => ({
    page: index + 1,
    text: Array.from({ length: 14 }, (_, line) => `المادة ${index + 1} الفقرة ${line + 1}: نص من نظام حماية حقوق المؤلف.`).join('\n'),
  }));
}

const asDocument = (pages: PageText[]): DocumentText => ({ pageCount: pages.length, pages, characters: pages.reduce((sum, page) => sum + page.text.length, 0) });
const live = () => new AbortController().signal;

describe('the on-device window is counted in tokens', () => {
  const pages = pagesOf(23);

  it('the cause: 4,000 characters of a text that costs more than a token for every 1.5 do not fit, and the request is refused', async () => {
    const engine = windowed(0.75, true);
    const old = budgetFor('device', 'summarize');
    expect(old).toBe(4000);
    const budgeted = await takeWithinBudget(
      pages.map((page) => page.page),
      old,
      async (page) => pages[page - 1]!.text,
    );
    expect(budgeted.characters).toBeGreaterThan(3400);
    const preflight = preflightFor({ provider: 'device', model: 'qwen2.5-1.5b', runtime: 'test' }, { kind: 'summarize' }, budgeted, { lang: 'ar', pageCount: 23, budget: old });
    // What the host does with it.
    await expect(
      engine.generate(
        [
          { role: 'system', content: preflight.prompt.system },
          { role: 'user', content: preflight.prompt.user },
        ],
        { maxTokens: DEVICE_REPLY_TOKENS, signal: live(), onToken: () => undefined },
      ),
    ).rejects.toThrow(/^E_TOO_LONG/);
    // And what the panel then had to show: a failure, said to be the request's size — not an answer.
    const outcome = await generateOnDevice(preflight, live(), { engine });
    expect(outcome).toEqual({ ok: false, failure: { kind: 'tooLarge' } });
    expect(engine.asked).toHaveLength(0);
  });

  it('the fix for the one-shot tools: the budget is what this text costs, so the same request fits', async () => {
    const engine = windowed(0.75, true);
    const budget = await deviceBudget(engine, 'summarize', pages[0]!.text);
    expect(budget).toBeLessThan(4000);
    const budgeted = await takeWithinBudget(
      pages.map((page) => page.page),
      budget,
      async (page) => pages[page - 1]!.text,
    );
    expect(budgeted.sent.length).toBeGreaterThan(0);
    const preflight = preflightFor({ provider: 'device', model: 'qwen2.5-1.5b', runtime: 'test' }, { kind: 'summarize' }, budgeted, { lang: 'ar', pageCount: 23, budget });
    const outcome = await generateOnDevice(preflight, live(), { engine });
    expect(outcome).toEqual({ ok: true, answer: { text: 'An answer.', cutOff: false } });
    // A text that costs what was assumed keeps its 4,000 characters.
    expect(await deviceBudget(windowed(2.4, true), 'summarize', pages[0]!.text)).toBe(4000);
  });

  it('the chat: every request of a summary of the whole document fits the window, and the answer comes', async () => {
    for (const rate of [0.75, 2.4, 4]) {
      const engine = windowed(rate, true);
      const doc = asDocument(pages);
      const runner = await deviceRunner(engine, { contextTokens: SMALL_CONTEXT, runtime: 'test', sample: pages[0]!.text });
      const turned = await answerTurn(doc, { kind: 'overview', text: 'لخّص المستند.' }, [], runner, { client: { callStatic: async () => ({ result: {} as never, blobs: [] }) }, kept: memoryKept(), signal: live() });
      expect(turned.ok, `rate ${rate}`).toBe(true);
      expect(turned.ok && turned.answer.text).toBe('An answer.');
      // Every page reached the model, and nothing asked of it was over its window.
      const reply = replyTokensFor(SMALL_CONTEXT);
      for (const asked of engine.asked) expect(asked.tokens + reply).toBeLessThanOrEqual(SMALL_CONTEXT);
      for (const page of pages) expect(engine.asked.some((asked) => asked.content.includes(page.text))).toBe(true);
    }
  });

  it('where the engine cannot count (the browser), the estimate keeps a margin, and a refusal is answered with less', async () => {
    // Twice as dear as its characters suggest: the estimate is short, the engine refuses, the chunk is halved.
    const engine = windowed(0.6, false);
    const doc = asDocument(pages);
    const runner = await deviceRunner(engine, { contextTokens: SMALL_CONTEXT, runtime: 'test', sample: pages[0]!.text });
    const turned = await answerTurn(doc, { kind: 'overview', text: 'لخّص المستند.' }, [], runner, { client: { callStatic: async () => ({ result: {} as never, blobs: [] }) }, kept: memoryKept(), signal: live() });
    expect(turned.ok).toBe(true);
    for (const page of pages) expect(engine.asked.some((asked) => asked.content.includes(page.text))).toBe(true);
    // The estimate itself: an Arabic letter about half a token, a vowel mark or a digit a whole one.
    expect(estimateTokens('كتاب')).toBe(2);
    expect(estimateTokens('كِتَابٌ')).toBe(5);
    expect(estimateTokens('2026')).toBe(4);
    expect(await charsPerToken({}, 'x'.repeat(400))).toBeCloseTo(4 / 1.6, 1);
    expect(engine.asked.length).toBeGreaterThan(0);
  });
});
