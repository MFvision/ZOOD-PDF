import { budgetFor } from '../budget';
import type { TaskKind } from '../budget';
import { charsPerToken } from '../chat/runner';
import type { Preflight } from '../preflight';
import { DEVICE_REPLY_TOKENS } from '../providers';
import type { Answer, Failure } from '../providers';
import type { Outcome } from '../send';
import { SMALL_CONTEXT } from './context';
import { deviceEngine } from './engine';
import type { DeviceEngine } from './engine';
import { GrammarError, schemaToGrammar } from './grammar';
import { deviceModel } from './models';

/** The characters a token was taken to be worth when the one-shot budgets were set. */
const ASSUMED_CHARS_PER_TOKEN = 1.5;

/**
 * How much document text one of the one-shot tools may give the on-device
 * model: its budget in characters (`budgetFor`), brought down when this
 * document's text costs more tokens than the 1.5 characters each that the
 * budget assumed — `sample` is some of it, counted by the engine. Without
 * this a dense text overflowed the window and the request was refused.
 */
export async function deviceBudget(engine: Pick<DeviceEngine, 'countTokens'>, task: TaskKind, sample: string): Promise<number> {
  const budget = budgetFor('device', task);
  const ratio = await charsPerToken(engine, sample);
  return Math.floor(budget * Math.min(1, ratio / ASSUMED_CHARS_PER_TOKEN));
}

export interface GenerateOptions {
  /** The answer so far, as it is written. */
  onText?: (text: string) => void;
  /** The engine to use; the one for the preflight's model when not given (tests give their own). */
  engine?: DeviceEngine;
}

/**
 * The on-device counterpart of `send`: the same preflight — the rules and
 * the text the person reviewed — put to the model in the app, and its
 * answer read as it is written. Nothing is sent anywhere. A data task's
 * schema becomes a grammar the sampling follows; a schema the grammar
 * cannot express goes without one, and the panel's checks on the answer
 * still stand.
 */
export async function generateOnDevice(preflight: Preflight, signal: AbortSignal, options: GenerateOptions = {}): Promise<Outcome> {
  const { settings, prompt } = preflight;
  const fail = (failure: Failure): Outcome => ({ ok: false, failure });
  if (settings.provider !== 'device') return fail({ kind: 'device', message: 'not an on-device request' });
  const engine = options.engine ?? (await deviceEngine(deviceModel(settings.model)));
  const status = await engine.status();
  if (status.kind !== 'ready') return fail(status.kind === 'unavailable' ? { kind: 'device', message: status.reason } : { kind: 'modelMissing' });
  let grammar: string | undefined;
  if (prompt.schema) {
    try {
      grammar = schemaToGrammar(prompt.schema);
    } catch (error) {
      if (!(error instanceof GrammarError)) throw error;
    }
  }
  if (engine.countTokens) {
    try {
      // Counted before it is run: a request over the window is said to be too large, at once.
      const tokens = (await engine.countTokens(`${prompt.system}\n${prompt.user}`)) + 16;
      if (tokens + DEVICE_REPLY_TOKENS > SMALL_CONTEXT) return fail({ kind: 'tooLarge' });
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
        grammar,
        maxTokens: DEVICE_REPLY_TOKENS,
        contextTokens: SMALL_CONTEXT,
        signal,
        onToken: (piece) => {
          text += piece;
          options.onText?.(text);
        },
      },
    );
    text = generated.text || text;
    if (text.trim().length === 0) return fail({ kind: 'empty' });
    const answer: Answer = { text: text.trim(), cutOff: generated.cutOff };
    return { ok: true, answer };
  } catch (error) {
    // Stopped: what had arrived is kept, and said to be incomplete.
    if (signal.aborted) return text.trim().length > 0 ? { ok: true, answer: { text: text.trim(), cutOff: true } } : fail({ kind: 'cancelled' });
    const message = error instanceof Error ? error.message : String(error);
    if (/E_TOO_LONG|exceeds? .*context|context size/i.test(message)) return fail({ kind: 'tooLarge' });
    return fail({ kind: 'device', message });
  }
}
