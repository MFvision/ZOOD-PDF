import type { TKey, TParams } from '../i18n/messages';
import { friendlyError, rawMessage } from './friendlyError';
import { StepError, findStep } from './steps';
import type { BatchDoc, SequenceStep, StepContext } from './steps';

/**
 * Runs a sequence of steps over many files, one file at a time. A file is
 * read only when its turn comes; its steps run in order; the result is
 * handed over (`deliver`: written beside the original, into a folder, or
 * kept for the zip) and the next file begins. A file that fails — it does
 * not open, a step refuses it — is marked with the reason and the batch goes
 * on. Stop ends the batch after the step under way: the file it was on, and
 * those after it, are marked as not done.
 */

/** A file of the batch. */
export interface BatchInput {
  /** Unique within the batch. */
  key: number;
  name: string;
  /** On the desktop: where it is, so a result can go beside it. */
  path?: string;
  /** Its place under a chosen folder: `sub/report.pdf`. */
  relative?: string;
  size?: number;
  read(): Promise<ArrayBuffer>;
}

/** Where a file is in the batch. */
export type FileState =
  | { state: 'waiting' }
  | { state: 'working'; step: number; detail?: { key: TKey; params?: TParams } }
  | { state: 'done'; output: string }
  | { state: 'failed'; step: number | null; key: TKey; params?: TParams; message?: string }
  | { state: 'cancelled' };

export interface BatchSummary {
  done: number;
  failed: number;
  cancelled: number;
}

export interface RunOptions {
  inputs: readonly BatchInput[];
  steps: readonly SequenceStep[];
  /** Tried on a file that asks for a password. */
  password?: string;
  context: Omit<StepContext, 'name' | 'onDetail' | 'signal' | 'now'>;
  signal: AbortSignal;
  onState: (key: number, state: FileState) => void;
  /** Hands a finished file over; answers what to show for it (its new name or path). */
  deliver: (input: BatchInput, doc: BatchDoc) => Promise<string>;
  now?: () => Date;
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return /^(E_[A-Z_]+)/.exec(String((error as Error)?.message ?? error))?.[1] ?? '';
}

/** Opens `bytes` to find what it opens with: nothing, the batch's password, or neither. */
async function openingPassword(
  client: StepContext['client'],
  bytes: ArrayBuffer,
  password: string | undefined,
): Promise<{ ok: true; password?: string } | { ok: false; key: TKey }> {
  const attempt = async (tried?: string) => {
    const doc = await client.open(bytes.slice(0), tried);
    void doc.free();
  };
  try {
    await attempt();
    return { ok: true };
  } catch (error) {
    if (codeOf(error) !== 'E_PASSWORD') return { ok: false, key: 'batch.error.notPdf' };
  }
  if (!password) return { ok: false, key: 'batch.error.needsPassword' };
  try {
    await attempt(password);
    return { ok: true, password };
  } catch {
    return { ok: false, key: 'batch.error.wrongPassword' };
  }
}

export async function runBatch(options: RunOptions): Promise<BatchSummary> {
  const { inputs, steps, signal, onState, context } = options;
  const summary: BatchSummary = { done: 0, failed: 0, cancelled: 0 };
  const now = options.now ?? (() => new Date());
  for (const input of inputs) {
    if (signal.aborted) {
      onState(input.key, { state: 'cancelled' });
      summary.cancelled += 1;
      continue;
    }
    let at: number | null = null;
    let phase: 'read' | 'step' | 'write' = 'read';
    try {
      onState(input.key, { state: 'working', step: -1 });
      const bytes = await input.read();
      const opening = await openingPassword(context.client, bytes, options.password);
      if (!opening.ok) throw new StepError(opening.key);
      let doc: BatchDoc = { bytes, password: opening.password, extension: 'pdf' };
      for (const [index, step] of steps.entries()) {
        if (signal.aborted) break;
        const definition = findStep(step.id);
        if (!definition) throw new StepError('batch.problem.unknown');
        at = index;
        phase = 'step';
        onState(input.key, { state: 'working', step: index });
        doc = await definition.run(doc, step.options, {
          ...context,
          name: input.name,
          signal,
          now: now(),
          onDetail: (key, params) => onState(input.key, { state: 'working', step: index, detail: { key, params } }),
        });
      }
      if (signal.aborted) {
        onState(input.key, { state: 'cancelled' });
        summary.cancelled += 1;
        continue;
      }
      at = null;
      phase = 'write';
      const output = await options.deliver(input, doc);
      onState(input.key, { state: 'done', output });
      summary.done += 1;
    } catch (error) {
      if (error instanceof StepError) {
        onState(input.key, { state: 'failed', step: at, key: error.key, params: error.params });
      } else {
        const key = friendlyError(error, phase, 'batch');
        onState(input.key, { state: 'failed', step: at, key, message: rawMessage(error) });
      }
      summary.failed += 1;
    }
  }
  return summary;
}
