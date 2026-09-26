import type { PluginRegistry } from '@embedpdf/react-pdf-viewer';
import type { RemoteDocument } from '../core/client';
import type { TextLineData } from '../core/types';
import { capability } from '../embed/embedControl';
import type { AppServices } from '../state/AppContext';
import type { ReadingSource } from './readAloud';

/**
 * The open document as the reader reads it: a copy opened by Warraq's core
 * from the file as it stands — with applied redactions gone — whose lines
 * come in logical order, so Arabic is read as written. The selection comes
 * from whichever view is on screen: EmbedPDF's (answered by Warraq's reading
 * of the selected glyphs) or Warraq's own overlay.
 */
export async function readingSource(
  services: Pick<AppServices, 'client' | 'currentFileBytes' | 'documentPassword' | 'goToPage' | 'embedRegistry' | 'embedShowing'>,
  currentPage: number,
): Promise<ReadingSource | null> {
  const bytes = await services.currentFileBytes();
  if (!bytes) return null;
  const doc: RemoteDocument = await services.client.open(bytes, services.documentPassword);
  const cache = new Map<number, Promise<TextLineData[]>>();
  let closed = false;
  return {
    pageCount: doc.pageCount,
    currentPage,
    lines: (page) => {
      if (closed || page < 0 || page >= doc.pageCount) return Promise.resolve([]);
      let lines = cache.get(page);
      if (!lines) {
        lines = doc.text_lines(page).catch(() => [] as TextLineData[]);
        cache.set(page, lines);
      }
      return lines;
    },
    selection: async () => {
      if (services.embedShowing && services.embedRegistry) return embedSelection(services.embedRegistry);
      const text = globalThis.getSelection?.()?.toString() ?? '';
      return text.trim() ? text : null;
    },
    goToPage: (page) => services.goToPage(page),
    close: () => {
      if (closed) return;
      closed = true;
      void doc.free();
    },
  };
}

interface Selection {
  getSelectedText(): { toPromise(): Promise<string[]> };
}

async function embedSelection(registry: PluginRegistry): Promise<string | null> {
  try {
    const parts = await capability<Selection>(registry, 'selection')?.getSelectedText().toPromise();
    const text = (parts ?? []).join('\n').trim();
    return text ? text : null;
  } catch {
    return null;
  }
}
