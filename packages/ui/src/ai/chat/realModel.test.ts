import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { takeWithinBudget } from '../budget';
import type { PageText } from '../budget';
import { contextTokensFor, estimateTokens, replyTokensFor } from '../device/context';
import type { ChatMessage, DeviceEngine, Generated, GenerateOptions } from '../device/engine';
import { deviceModel } from '../device/models';
import { buildPrompt } from '../prompt';
import { DEVICE_REPLY_TOKENS } from '../providers';
import { answerTurn } from './answer';
import type { DocumentText } from './answer';
import { chunkPages } from './chunks';
import { memoryKept } from './kept';
import { deviceRunner } from './runner';

/**
 * The assistant with the real on-device model, by hand: the numbers in
 * `docs/STATUS.md` ("The assistant") come from this. Opt-in, and slow.
 *
 *   cargo build --release --example ai_stdio      (in apps/desktop/src-tauri)
 *   WARRAQ_AI_STDIO=…/release/examples/ai_stdio WARRAQ_MODEL=…/qwen2.5-1.5b-instruct-q4_k_m.gguf \
 *     WARRAQ_AI_PDF=tests/corpus/arabic/realworld/….pdf [WARRAQ_AI_CONTEXT=8192] [WARRAQ_AI_PAGES=12] \
 *     pnpm --filter @warraq/ui exec vitest run src/ai/chat/realModel.test.ts
 *
 * The engine is the desktop host's own (`Engine::generate`, llama.cpp),
 * spoken to over standard input and output instead of the webview's message
 * channel; the text is read by the core (WASM) as the app reads it; and the
 * chunking, the analysis and the answering are the chat's own code. What it
 * writes is also added to `.tools/logs/ai-real.log`.
 */
const STDIO = process.env.WARRAQ_AI_STDIO;
const MODEL = process.env.WARRAQ_MODEL;
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const PDF = process.env.WARRAQ_AI_PDF ?? `${root}tests/corpus/arabic/realworld/A_worldbank_malpass_g7_briefing_AR_word2016_pdftools.pdf`;
const CONTEXT = Number(process.env.WARRAQ_AI_CONTEXT ?? contextTokensFor(8, false));
const PAGES = Number(process.env.WARRAQ_AI_PAGES ?? 0);
const QUESTION = process.env.WARRAQ_AI_QUESTION ?? 'ما الذي يقوله المستند عن التمويل؟';

function log(line: string): void {
  console.log(line);
  mkdirSync(`${root}.tools/logs`, { recursive: true });
  appendFileSync(`${root}.tools/logs/ai-real.log`, `${line}\n`);
}

interface Core {
  default(options: { module_or_path: Uint8Array }): Promise<unknown>;
  Document: { open(bytes: Uint8Array): { page_count(): number; extract_text(page: number): string; free(): void } };
  call_static(op: string, args: string, blobs: unknown[]): { json: string; free(): void };
}

async function loadCore(): Promise<Core> {
  const core = (await import(/* @vite-ignore */ `${root}packages/ui/src/core-wasm/warraq_core.js`)) as Core;
  await core.default({ module_or_path: readFileSync(`${root}packages/ui/src/core-wasm/warraq_core_bg.wasm`) });
  return core;
}

function readPdf(core: Core, file: string, limit: number): DocumentText {
  const doc = core.Document.open(new Uint8Array(readFileSync(file)));
  try {
    const count = limit > 0 ? Math.min(limit, doc.page_count()) : doc.page_count();
    const pages: PageText[] = Array.from({ length: count }, (_, index) => ({ page: index + 1, text: doc.extract_text(index) }));
    return { pageCount: count, pages, characters: pages.reduce((sum, page) => sum + page.text.length, 0) };
  } finally {
    doc.free();
  }
}

type Line = { ready?: boolean; token?: string; done?: Generated; error?: string; count?: number; peakMiB?: number };

/** The host's engine, as a process. */
function stdioEngine(binary: string, model: string): { engine: DeviceEngine; peakMiB(): Promise<number>; close(): void; requests: { tokens: number; ms: number; prompt: number }[] } {
  const child: ChildProcessWithoutNullStreams = spawn(binary, [model], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const waiting: ((line: Line) => void)[] = [];
  const queue: Line[] = [];
  lines.on('line', (text) => {
    const line = JSON.parse(text) as Line;
    const next = waiting.shift();
    if (next) next(line);
    else queue.push(line);
  });
  const read = () => new Promise<Line>((resolve) => (queue.length > 0 ? resolve(queue.shift()!) : waiting.push(resolve)));
  const write = (value: object) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const ready = read();
  const requests: { tokens: number; ms: number; prompt: number }[] = [];
  const count = async (text: string) => {
    await ready;
    write({ op: 'count', text });
    const line = await read();
    if (typeof line.count !== 'number') throw new Error(line.error ?? 'no count');
    return line.count;
  };
  const engine: DeviceEngine = {
    model: deviceModel(/0\.5b/.test(model) ? 'qwen2.5-0.5b' : 'qwen2.5-1.5b'),
    runtime: async () => 'metal',
    memoryGiB: async () => 8,
    status: async () => ({ kind: 'ready', bytes: 0 }),
    download: async () => undefined,
    remove: async () => undefined,
    countTokens: count,
    generate: async (messages: readonly ChatMessage[], options: GenerateOptions): Promise<Generated> => {
      await ready;
      const prompt = await count(messages.map((message) => message.content).join('\n'));
      write({ op: 'generate', messages, maxTokens: options.maxTokens, contextTokens: options.contextTokens ?? null });
      for (;;) {
        const line = await read();
        if (line.token !== undefined) options.onToken(line.token);
        else if (line.done) {
          requests.push({ tokens: line.done.tokens, ms: line.done.ms, prompt });
          return line.done;
        } else throw new Error(line.error ?? 'the engine stopped');
      }
    },
  };
  return {
    engine,
    requests,
    peakMiB: async () => {
      write({ op: 'memory' });
      return (await read()).peakMiB ?? 0;
    },
    close: () => child.stdin.end(),
  };
}

describe.skipIf(!STDIO || !MODEL)('the real on-device model', () => {
  it('the one-shot request as it was: 4,000 characters of the document against a 4,096-token window', { timeout: 1_800_000 }, async () => {
    const core = await loadCore();
    const doc = readPdf(core, PDF, PAGES);
    const host = stdioEngine(STDIO!, MODEL!);
    try {
      // Exactly what the old panel built: whole pages while they fit 4,000 characters, the rest left out.
      const budgeted = await takeWithinBudget(
        doc.pages.map((page) => page.page),
        4000,
        async (page) => doc.pages[page - 1]!.text,
      );
      log(`\n== one-shot, as it was · ${PDF.split('/').pop()} · ${doc.pageCount} pages, ${doc.characters} characters`);
      log(`pages sent whole: ${budgeted.sent.length} (${budgeted.characters} characters); left out: ${budgeted.left.length}`);
      if (budgeted.sent.length === 0) {
        log('nothing fits: page 1 alone is over 4,000 characters — the panel refused to build a request at all');
        return;
      }
      const prompt = buildPrompt({ kind: 'summarize' }, budgeted.sent, { lang: 'ar', pageCount: doc.pageCount, left: budgeted.left });
      const tokens = await host.engine.countTokens!(`${prompt.system}\n${prompt.user}`);
      log(`the request is ${prompt.system.length + prompt.user.length} characters = ${tokens} tokens (${(budgeted.characters / Math.max(1, await host.engine.countTokens!(budgeted.sent.map((page) => page.text).join('\n')))).toFixed(2)} characters a token of document text); the window held ${4096 - DEVICE_REPLY_TOKENS}`);
      const started = Date.now();
      let first = 0;
      try {
        const done = await host.engine.generate(
          [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          { maxTokens: DEVICE_REPLY_TOKENS, contextTokens: 4096, signal: new AbortController().signal, onToken: () => (first ||= Date.now() - started) },
        );
        log(`answered: ${done.tokens} tokens in ${done.ms} ms; first word after ${first} ms; cut off: ${done.cutOff}`);
        log(done.text);
      } catch (error) {
        log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      host.close();
    }
  });

  it('what a character costs in tokens, by its kind', { timeout: 600_000 }, async () => {
    const core = await loadCore();
    const host = stdioEngine(STDIO!, MODEL!);
    try {
      const { readdirSync } = await import('node:fs');
      const dir = `${root}tests/corpus/arabic/realworld/`;
      for (const name of readdirSync(dir).filter((file) => file.endsWith('.pdf'))) {
        let doc: DocumentText;
        try {
          doc = readPdf(core, dir + name, 12);
        } catch {
          continue;
        }
        const text = doc.pages.map((page) => page.text).join('\n').slice(0, 20_000);
        if (text.trim().length < 300) continue;
        const tokens = await host.engine.countTokens!(text);
        log(`${name.slice(0, 40).padEnd(40)} ${text.length} chars, ${tokens} tokens = ${(text.length / tokens).toFixed(2)} c/t; estimate ${estimateTokens(text)} (${(estimateTokens(text) / tokens).toFixed(2)}x)`);
      }
      const english = 'The quick brown fox jumps over the lazy dog, and the document goes on to say many ordinary things. '.repeat(40);
      log(`english ${english.length} chars, ${await host.engine.countTokens!(english)} tokens; estimate ${estimateTokens(english)}`);
    } finally {
      host.close();
    }
  });

  it('the chat: a summary of the whole document, a question, a follow-up', { timeout: 7_200_000 }, async () => {
    const core = await loadCore();
    const doc = readPdf(core, PDF, PAGES);
    const host = stdioEngine(STDIO!, MODEL!);
    const client = {
      callStatic: async <T>(op: string, args?: Record<string, unknown>) => {
        const reply = core.call_static(op, JSON.stringify(args ?? {}), []);
        try {
          return { result: JSON.parse(reply.json) as T, blobs: [] as ArrayBuffer[] };
        } finally {
          reply.free();
        }
      },
    };
    try {
      const texts = doc.pages.filter((page) => page.text.trim().length > 0).map((page) => page.text);
      const sample = `${(texts[0] ?? '').slice(0, 3000)}\n${(texts[Math.floor(texts.length / 2)] ?? '').slice(0, 3000)}`;
      const runner = await deviceRunner(host.engine, { contextTokens: CONTEXT, runtime: 'metal', sample });
      const chunks = chunkPages(doc.pages, runner.budget);
      log(`\n== chat · ${MODEL!.split('/').pop()} · window ${CONTEXT} tokens (reply ${replyTokensFor(CONTEXT)}) · ${PDF.split('/').pop()}`);
      log(`${doc.pageCount} pages, ${doc.characters} characters; budget ${runner.budget} characters a request; ${chunks.length} chunks`);
      const kept = memoryKept();
      const history: { role: 'user' | 'assistant'; text: string }[] = [];
      const turn = async (label: string, ask: Parameters<typeof answerTurn>[1]) => {
        const before = host.requests.length;
        const started = Date.now();
        let first = 0;
        const turned = await answerTurn(doc, ask, history, runner, {
          client,
          kept,
          signal: new AbortController().signal,
          onText: () => (first ||= Date.now() - started),
          onProgress: (progress) => progress?.stage === 'reading' && console.log(`  reading pages ${progress.from}–${progress.to} (${progress.done + 1}/${progress.total})`),
        });
        const made = host.requests.slice(before);
        const written = made.reduce((sum, request) => sum + request.tokens, 0);
        log(`\n-- ${label}: "${ask.text}"`);
        log(`${made.length} requests to the model, ${made.reduce((sum, request) => sum + request.prompt, 0)} prompt tokens read, ${written} tokens written, ${((Date.now() - started) / 1000).toFixed(1)} s in all; first word of the answer after ${(first / 1000).toFixed(1)} s`);
        if (!turned.ok) {
          log(`NO ANSWER: ${JSON.stringify(turned)}`);
          return turned;
        }
        log(`from: ${JSON.stringify(turned.basis)}; cut off: ${turned.answer.cutOff}`);
        log(turned.answer.text);
        history.push({ role: 'user', text: ask.text }, { role: 'assistant', text: turned.answer.text });
        return turned;
      };
      const summary = await turn('summary', { kind: 'overview', text: 'لخّص هذا المستند: جملة أو جملتان عمّا هو، ثم نقاطه الرئيسية، كل نقطة مع صفحتها.' });
      expect(summary.ok).toBe(true);
      await turn('summary again (kept)', { kind: 'overview', text: 'Summarize this document in English, in five points.' });
      await turn('question', { kind: 'question', text: QUESTION });
      await turn('follow-up', { kind: 'question', text: 'وضّح ذلك أكثر في جملتين.' });
      log(`\npeak memory of the engine's process: ${(await host.peakMiB()).toFixed(0)} MiB`);
    } finally {
      host.close();
    }
  });
});
