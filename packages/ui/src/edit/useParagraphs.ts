import { useEffect, useState } from 'react';
import type { RemoteDocument } from '../core/client';
import type { ParagraphData } from '../core/types';

/**
 * Editable paragraph boxes of one page.
 *
 * `revision` is the page's edit counter: bumping it re-reads the boxes after a
 * commit, an undo or a redo, because reflowing a paragraph changes its height
 * and can move the ones below it.
 */
export function useParagraphs(
  document: RemoteDocument,
  index: number,
  revision: number,
): ParagraphData[] | null {
  const [paragraphs, setParagraphs] = useState<ParagraphData[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    document
      .paragraphs(index)
      .then((result) => {
        if (!cancelled) setParagraphs(result);
      })
      .catch(() => {
        // A page the core cannot segment simply has nothing to edit.
        if (!cancelled) setParagraphs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [document, index, revision]);

  return paragraphs;
}
