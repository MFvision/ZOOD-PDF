import { budgetFor } from '../budget';
import type { Preflight, ProviderSettings } from '../preflight';
import { THIS_DEVICE } from '../preflight';
import { CLAUDE_HOST } from '../providers';
import type { Prompt } from '../providers';
import { send } from '../send';
import type { Outcome } from '../send';
import { estimateTokens, materialTokensFor, replyTokensFor, SAFE_CHARS_PER_TOKEN } from '../device/context';
import type { DeviceEngine } from '../device/engine';

/**
 * What answers one request of the chat: the model on this device, Claude
 * with the person's key, or a local server. The chat, the analysis and the
 * answers are written against this alone, so they are the same for all three
 * — and a test hands in one that only records what it was asked.
 */
export interface RunOptions {
  signal: AbortSignal;
  /** The answer so far, as it is written; `thinking` while the model thinks before it. */
  onText?: (text: string, thinking: boolean) => void;
  /** A short answer is wanted (a summary of a chunk): the on-device model is stopped at half its usual reply. */
  brief?: boolean;
}

export interface Runner {
  settings: ProviderSettings;
  /** Names what an analysis was made with, so one model's summaries are not taken for another's. */
  key: string;
  /** Where requests go: `THIS_DEVICE`, Anthropic's host, or the local server's address. */
  destination: string;
  /**
   * Characters of material — document text, summaries, passages, earlier
   * turns — one request can carry besides the rules and the request itself.
   */
  budget: number;
  /** Characters of text one request can carry when the answer is as long as the text — a translation. */
  echoBudget: number;
  run(prompt: Prompt, options: RunOptions): Promise<Outcome>;
}

/** The preflight `send` asks for: the rules and the text, to the provider named. */
function asPreflight(settings: ProviderSettings, destination: string, prompt: Prompt): Preflight {
  return {
    settings,
    task: { kind: 'ask', question: '' },
    destination,
    passages: false,
    pages: [],
    left: [],
    pageCount: 0,
    characters: prompt.user.length,
    budget: prompt.user.length,
    empty: false,
    prompt,
  };
}

/** Claude or a local server: one HTTP request a turn, through the app's one sender (`send.ts`). */
export function remoteRunner(settings: Exclude<ProviderSettings, { provider: 'device' }>, key: string, fetcher?: typeof fetch): Runner {
  const destination = settings.provider === 'claude' ? CLAUDE_HOST : settings.base;
  return {
    settings,
    key: `${settings.provider}:${settings.model}`,
    destination,
    budget: budgetFor(settings.provider, 'ask'),
    echoBudget: budgetFor(settings.provider, 'translate'),
    run: (prompt, options) => send(asPreflight(settings, destination, prompt), key, options.signal, { onText: options.onText, ...(fetcher ? { fetch: fetcher } : {}) }),
  };
}

export interface DeviceRunnerOptions {
  /** The window to run in, in tokens (`device/context.ts`). */
  contextTokens: number;
  runtime: string;
  /**
   * A sample of the document, to learn what a character of it costs in
   * tokens: a quarter of a token in English, most of one in Arabic, more
   * with every vowel mark. Without it, or where the engine cannot count, the
   * cautious figure is used.
   */
  sample?: string;
}

/** How much of `sample` the engine is asked to count. */
const SAMPLE = 6000;

/**
 * Characters a token is worth for text like `sample`. The engine's own count
 * where it can count (the desktop's), a tenth kept back because the sample
 * is not the whole document. Where it cannot (the browser's), an estimate by
 * the kinds of its characters, with the margin that estimate was found to
 * need: on the corpus it came out between 0.64 and 1.18 of the real count.
 */
export async function charsPerToken(engine: Pick<DeviceEngine, 'countTokens'>, sample: string | undefined): Promise<number> {
  const text = (sample ?? '').slice(0, SAMPLE);
  if (text.trim().length < 200) return SAFE_CHARS_PER_TOKEN;
  const bounded = (ratio: number) => Math.max(0.5, Math.min(6, ratio));
  if (engine.countTokens) {
    try {
      const tokens = await engine.countTokens(text);
      if (Number.isFinite(tokens) && tokens > 0) return bounded((text.length / tokens) * 0.9);
    } catch {
      /* the estimate, then */
    }
  }
  return bounded(text.length / (estimateTokens(text) * 1.6));
}

/**
 * The model on this device. Its budget is its window in tokens, turned into
 * characters by what this document's text costs; and every request is
 * counted before it is run, so one that would not fit comes back as "too
 * large" — which the callers answer by sending less — and never as a
 * failure after a long wait, or an answer to a prompt whose start was lost.
 */
export async function deviceRunner(engine: DeviceEngine, options: DeviceRunnerOptions): Promise<Runner> {
  const context = options.contextTokens;
  const reply = replyTokensFor(context);
  const ratio = await charsPerToken(engine, options.sample);
  const settings: ProviderSettings = { provider: 'device', model: engine.model.id, runtime: options.runtime };
  return {
    settings,
    key: `device:${engine.model.id}`,
    destination: THIS_DEVICE,
    budget: Math.floor(materialTokensFor(context) * ratio),
    // A translation into Arabic takes up to twice the tokens of its English: half the reply's room.
    echoBudget: Math.max(200, Math.floor(reply * ratio * 0.5)),
    run: async (prompt, { signal, onText, brief }): Promise<Outcome> => {
      const status = await engine.status();
      if (status.kind !== 'ready') {
        return { ok: false, failure: status.kind === 'unavailable' ? { kind: 'device', message: status.reason } : { kind: 'modelMissing' } };
      }
      if (engine.countTokens) {
        try {
          // The chat template's own marks are a few tokens a message.
          const tokens = (await engine.countTokens(`${prompt.system}\n${prompt.user}`)) + 16;
          if (tokens + reply > context) return { ok: false, failure: { kind: 'tooLarge' } };
        } catch {
          /* the engine's own check still stands */
        }
      }
      let text = '';
      try {
        const generated = await engine.generate(
          [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          {
            maxTokens: brief ? Math.floor(reply / 2) : reply,
            contextTokens: context,
            signal,
            onToken: (piece) => {
              text += piece;
              onText?.(text, false);
            },
          },
        );
        text = generated.text || text;
        if (text.trim().length === 0) return { ok: false, failure: { kind: 'empty' } };
        return { ok: true, answer: { text: text.trim(), cutOff: generated.cutOff } };
      } catch (error) {
        // Stopped: what had arrived is kept, and said to be incomplete.
        if (signal.aborted) return text.trim().length > 0 ? { ok: true, answer: { text: text.trim(), cutOff: true } } : { ok: false, failure: { kind: 'cancelled' } };
        const message = error instanceof Error ? error.message : String(error);
        // The host says E_TOO_LONG; llama.cpp in the browser says the request exceeds the context size.
        if (/E_TOO_LONG|exceeds? .*context|context size/i.test(message)) return { ok: false, failure: { kind: 'tooLarge' } };
        return { ok: false, failure: { kind: 'device', message } };
      }
    },
  };
}
