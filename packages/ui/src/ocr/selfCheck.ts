import { runBatchSelfCheck } from '../batch/selfCheck';
import { debugSelfCheck, uiLog } from '../core/host-tauri';
import type { AppServices } from '../state/AppContext';
import { NO_CLEANUP } from './cleanup';
import type { CleanupOptions } from './cleanup';

/**
 * Recognition inside the desktop webview, checked without a person at the
 * screen. With `WARRAQ_DEBUG=1 WARRAQ_SELFCHECK=ocr warraq-desktop scan.pdf`
 * the host asks for it (`debug_selfcheck`); once the file is open, Scan & OCR
 * reads it — Tesseract's worker, its WebAssembly and its models, under the
 * host's own security policy — and every step goes to the host's log. In a
 * browser, and in any ordinary run, the host asks for nothing and this does
 * nothing.
 */
export async function runSelfCheck(
  services: Pick<AppServices, 'recognizeText' | 'client' | 'currentFileBytes' | 'documentPassword'>,
): Promise<void> {
  const check = await debugSelfCheck();
  if (check?.startsWith('batch:')) return runBatchSelfCheck(check.slice('batch:'.length), services.client);
  if (check !== 'ocr' && check !== 'ocr-clean') return;
  const cleanup: CleanupOptions =
    check === 'ocr-clean' ? { background: true, contrast: true, binarize: true, despeckle: true, borders: true } : NO_CLEANUP;
  uiLog(`selfcheck ${check}: start`);
  const started = Date.now();
  try {
    const outcome = await services.recognizeText(
      ['ara', 'eng'],
      'all',
      (progress) => uiLog(`selfcheck ${check}: page ${progress.page} of ${progress.of}`),
      undefined,
      { cleanup, replaceImage: check === 'ocr-clean' },
    );
    uiLog(`selfcheck ${check}: done in ${Date.now() - started} ms ${JSON.stringify(outcome)}`);
    // What the layer says, read back by Warraq's own reader — once the view
    // has reopened the file with it (asking sooner finds no document).
    let bytes: ArrayBuffer | null = null;
    for (let attempt = 0; attempt < 10 && !bytes; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      bytes = await services.currentFileBytes().catch(() => null);
    }
    if (bytes) {
      const doc = await services.client.open(bytes, services.documentPassword);
      try {
        uiLog(`selfcheck ${check}: page 1 reads ${JSON.stringify((await doc.extract_text(0)).slice(0, 160))}`);
      } finally {
        void doc.free();
      }
    }
  } catch (error) {
    uiLog(`selfcheck ${check}: failed ${String((error as Error)?.message ?? error)}`);
  }
}
