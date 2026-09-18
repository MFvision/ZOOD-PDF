import type { AppServices } from '../state/AppContext';
import { takeWithinBudget } from './budget';
import type { Budgeted } from './budget';

export interface DocumentReading {
  pageCount: number;
  budgeted: Budgeted;
}

/**
 * The open document's text as it stands now, read on this device by
 * Warraq's own reader — before anything is sent, so the preflight can show
 * exactly what would go.
 *
 * - The bytes are `currentFileBytes()`: the file as the person sees it, with
 *   their comments and, above all, with applied redactions gone. Text that
 *   was redacted is not in these bytes, so it cannot be sent.
 * - `extract_text` gives Arabic in logical order. PDFium's text comes out in
 *   visual order, reversed, which a model would read as nonsense.
 * - The copy is opened on its own and freed after; the open document is not touched.
 */
export async function readDocument(
  services: Pick<AppServices, 'client' | 'currentFileBytes' | 'documentPassword'>,
  pagesOf: (pageCount: number) => number[],
  budget: number,
  onPage?: (page: number) => void,
): Promise<DocumentReading | null> {
  const bytes = await services.currentFileBytes();
  if (!bytes) return null;
  const doc = await services.client.open(bytes, services.documentPassword);
  try {
    const budgeted = await takeWithinBudget(pagesOf(doc.pageCount), budget, (page) => {
      onPage?.(page);
      return doc.extract_text(page - 1);
    });
    return { pageCount: doc.pageCount, budgeted };
  } finally {
    void doc.free();
  }
}
