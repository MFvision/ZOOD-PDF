import type { Preflight } from '../preflight';
import { DEVICE_REPLY_TOKENS } from '../providers';
import type { Answer, Failure } from '../providers';
import type { Outcome } from '../send';
import { deviceEngine } from './engine';
import type { DeviceEngine } from './engine';
import { GrammarError, schemaToGrammar } from './grammar';
import { deviceModel } from './models';

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
    return fail({ kind: 'device', message: error instanceof Error ? error.message : String(error) });
  }
}
