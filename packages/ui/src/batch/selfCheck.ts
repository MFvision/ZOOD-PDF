import { listBatchFolder, readBatchFile, uiLog, writeBatchResult } from '../core/host-tauri';
import type { CoreClient } from '../core/client';
import { translate } from '../i18n/messages';
import { startRecognizer } from '../ocr/engine';
import { resultName } from './names';
import { startPdfium } from './pdfium';
import { runBatch } from './run';
import { findStep } from './steps';
import type { SequenceStep, StepId } from './steps';

/** A step with its options as a saved action would give them. */
const step = (key: number, id: StepId, options: unknown): SequenceStep => ({ key, id, options: findStep(id)!.sanitize(options) });

/**
 * The batch on the desktop, checked without a person at the screen (as
 * `ocr/selfCheck.ts` checks recognition): with
 * `WARRAQ_DEBUG=1 WARRAQ_SELFCHECK=batch:/a/folder`, the host lets that
 * folder be read (as if it had been chosen in the panel), and the PDFs in it
 * are turned a quarter and numbered, each result written beside its original
 * through the host's own commands — listed, read, and written as the panel
 * does it — and every file's outcome goes to the log.
 */
export async function runBatchSelfCheck(folder: string, client: Pick<CoreClient, 'open' | 'callStatic'>): Promise<void> {
  uiLog(`selfcheck batch: listing ${folder}`);
  try {
    const found = await listBatchFolder(folder, false);
    uiLog(`selfcheck batch: ${found.length} PDFs`);
    const steps = [step(1, 'rotate', { pages: { which: 'all' }, turn: 1 }), step(2, 'pageMarks', { form: { section: 'pageNumber' } })];
    const summary = await runBatch({
      inputs: found.map((file, k) => ({ key: k + 1, name: file.name, path: file.path, relative: file.relative, read: () => readBatchFile(file.path) })),
      steps,
      signal: new AbortController().signal,
      context: {
        client,
        lang: 'en',
        t: (key, params) => translate('en', key, params),
        pdfium: async () => startPdfium(),
        recognizer: (languages) => startRecognizer(languages),
      },
      onState: (key, state) => {
        if (state.state === 'done' || state.state === 'failed') uiLog(`selfcheck batch: file ${key} ${JSON.stringify(state)}`);
      },
      deliver: (input, doc) => writeBatchResult(new Uint8Array(doc.bytes), resultName(input.name, '-selfcheck', doc.extension), { beside: input.path ?? '' }),
    });
    uiLog(`selfcheck batch: done ${JSON.stringify(summary)}`);
  } catch (error) {
    uiLog(`selfcheck batch: failed ${String((error as Error)?.message ?? error)}`);
  }
}
