import type { CoreClient } from '../core/client';
import { readBatchFile, writeBatchResult } from '../core/host-tauri';
import { DEFAULT_CREATE_OPTIONS, createPdf } from '../create/createPdf';
import { appCreateEnvironment } from '../create/environment';
import type { Lang, TKey, TParams } from '../i18n/messages';
import { dictionaries } from '../i18n/messages';
import { startRecognizer } from '../ocr/engine';
import type { Recognizer } from '../ocr/engine';
import { resultName } from '../batch/names';
import { startPdfium } from '../batch/pdfium';
import type { PdfiumTools } from '../batch/pdfium';
import { runBatch } from '../batch/run';
import type { FileState } from '../batch/run';
import type { SequenceStep } from '../batch/steps';
import { combinedName, partName, splitGroups } from './plan';
import type { QuickTool, SplitOptions } from './plan';

/**
 * Runs a quick tool on files, for the quick window and for the ring alike:
 * the batch's step on each file, or Combine, Split and Convert to PDF, which
 * make files of their own. Results go beside the originals, never over a
 * file.
 */

export interface QuickFile {
  name: string;
  path: string;
  size: number;
}

export interface QuickRun {
  tool: QuickTool;
  files: readonly QuickFile[];
  options: unknown;
  password?: string;
  /** Convert to PDF: one PDF of all the files. */
  onePdf?: boolean;
  client: CoreClient;
  lang: Lang;
  t: (key: TKey, params?: TParams) => string;
  signal: AbortSignal;
  onState: (key: number, state: FileState) => void;
  /** Where a file's (first) result was written. */
  onOutput: (key: number, path: string) => void;
}

/** What the tool adds to a result's name ("-compressed"); a conversion keeps the name. */
export function quickSuffix(tool: QuickTool, t: (key: TKey) => string): string {
  const key = `quick.suffix.${tool.id}` as TKey;
  return key in dictionaries.en ? t(key) : '';
}

const failure = (error: unknown): FileState => ({
  state: 'failed',
  step: null,
  key: 'batch.error.step',
  message: String((error as Error)?.message ?? error).slice(0, 300),
});

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export async function runQuick(run: QuickRun): Promise<void> {
  const { tool, files, client, lang, t, signal, onState, onOutput } = run;
  const suffix = quickSuffix(tool, t);
  if (tool.step) {
    const step: SequenceStep = { key: 1, id: tool.step, options: run.options };
    let pdfium: PdfiumTools | null = null;
    const recognizers = new Map<string, Recognizer>();
    try {
      await runBatch({
        inputs: files.map((file, key) => ({ key, name: file.name, path: file.path, size: file.size, read: () => readBatchFile(file.path) })),
        steps: [step],
        password: run.password || undefined,
        signal,
        context: {
          client,
          lang,
          t,
          pdfium: async () => (pdfium ??= startPdfium()),
          recognizer: async (languages) => {
            const id = [...languages].sort().join('+');
            let recognizer = recognizers.get(id);
            if (!recognizer) {
              recognizer = await startRecognizer(languages);
              recognizers.set(id, recognizer);
            }
            return recognizer;
          },
        },
        onState,
        deliver: async (input, doc) => {
          const written = await writeBatchResult(new Uint8Array(doc.bytes), resultName(input.name, suffix, doc.extension), { beside: input.path ?? '' });
          onOutput(input.key, written);
          return baseName(written);
        },
      });
    } finally {
      for (const recognizer of recognizers.values()) await recognizer.stop().catch(() => undefined);
      const engine = pdfium as PdfiumTools | null;
      if (engine) await engine.stop();
    }
    return;
  }
  if (tool.id === 'combine') return combineAll(run, suffix);
  if (tool.id === 'split') return splitAll(run, suffix);
  if (tool.id === 'topdf') return convertAll(run);
}

/** Every file into one, in the order given, beside the first. */
async function combineAll({ files, client, password, onState, onOutput }: QuickRun, suffix: string) {
  files.forEach((_, key) => onState(key, { state: 'working', step: 0 }));
  try {
    const blobs = await Promise.all(files.map((file) => readBatchFile(file.path)));
    const { blobs: made } = await client.callStatic<{ pageCount: number }>('pages.combine', { passwords: files.map(() => password || null) }, blobs);
    const bytes = made[0];
    if (!bytes) throw new Error('E_COMBINE: nothing came back');
    const first = files[0]!;
    const written = await writeBatchResult(new Uint8Array(bytes), combinedName(first.name, suffix), { beside: first.path });
    onOutput(0, written);
    files.forEach((_, key) => onState(key, { state: 'done', output: baseName(written) }));
  } catch (error) {
    files.forEach((_, key) => onState(key, failure(error)));
  }
}

/** Each file into several, as the split's options say, beside it. */
async function splitAll({ files, options, client, password, signal, onState, onOutput }: QuickRun, suffix: string) {
  for (const [key, file] of files.entries()) {
    if (signal.aborted) {
      onState(key, { state: 'cancelled' });
      continue;
    }
    onState(key, { state: 'working', step: 0 });
    try {
      const open = await client.open(await readBatchFile(file.path), password || undefined);
      try {
        const groups = splitGroups(options as SplitOptions, open.pageCount);
        if (!groups) throw new Error('E_SPLIT: no pages in these parts');
        let first = '';
        for (const [index, pages] of groups.entries()) {
          if (signal.aborted) break;
          onState(key, { state: 'working', step: 0, detail: { key: 'quick.split.detail', params: { part: index + 1, of: groups.length } } });
          const { blobs } = await open.call('pages.extract', { pages });
          if (!blobs[0]) throw new Error('E_SPLIT: a part came back empty');
          const written = await writeBatchResult(new Uint8Array(blobs[0]), partName(file.name, suffix, index + 1), { beside: file.path });
          if (index === 0) {
            first = written;
            onOutput(key, written);
          }
        }
        onState(key, signal.aborted ? { state: 'cancelled' } : { state: 'done', output: baseName(first) });
      } finally {
        void open.free();
      }
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (/^E_PASSWORD/.test(message)) onState(key, { state: 'failed', step: null, key: password ? 'batch.error.wrongPassword' : 'batch.error.needsPassword' });
      else onState(key, failure(error));
    }
  }
}

/** A PDF of each picture or document beside it, or one of them all beside the first. */
async function convertAll({ files, client, onePdf, signal, t, onState, onOutput }: QuickRun) {
  const environment = appCreateEnvironment(client);
  const groups = onePdf ? [files.map((_, key) => key)] : files.map((_, key) => [key]);
  for (const group of groups) {
    if (signal.aborted) {
      group.forEach((key) => onState(key, { state: 'cancelled' }));
      continue;
    }
    group.forEach((key) => onState(key, { state: 'working', step: 0 }));
    try {
      const sources = await Promise.all(group.map(async (key) => ({ name: files[key]!.name, bytes: await readBatchFile(files[key]!.path) })));
      const result = await createPdf(sources, DEFAULT_CREATE_OPTIONS, environment);
      const first = files[group[0]!]!;
      const fileName = group.length > 1 ? combinedName(first.name, t('quick.suffix.together')) : resultName(first.name, '', 'pdf');
      const written = await writeBatchResult(new Uint8Array(result.bytes), fileName, { beside: first.path });
      onOutput(group[0]!, written);
      group.forEach((key) => onState(key, { state: 'done', output: baseName(written) }));
    } catch (error) {
      group.forEach((key) => onState(key, failure(error)));
    }
  }
}

/** Whether a failed file only wants its password: the quick window can ask for it. */
export function wantsPassword(state: FileState | undefined): boolean {
  return state?.state === 'failed' && (state.key === 'batch.error.needsPassword' || state.key === 'batch.error.wrongPassword');
}
