import { useCallback, useMemo } from 'react';
import { useAppDispatch, useServices } from '../state/AppContext';
import type { LinkTo, PageImage, PageLink } from './editPdf';
import type { Clip, Matrix } from './matrix';

/**
 * Edit PDF's changes, each one call to the core on the open document. The
 * file as it was is kept first, so the change goes on the undo stack with
 * the text edits (`rememberFileChange`) and Undo puts it back byte for byte.
 * A change bumps the page's revision, so the page is drawn again and its
 * pictures and links listed again, and the file counts as edited until it
 * is saved. A failure says so and changes nothing.
 */
export function useEditPdfActions() {
  const { document, rememberFileChange } = useServices();
  const dispatch = useAppDispatch();

  const change = useCallback(
    async <T,>(page: number, op: string, args: object, blobs: ArrayBuffer[] = []): Promise<T | null> => {
      if (!document) return null;
      dispatch({ type: 'EDIT_BUSY', busy: true });
      try {
        const before = await document.save();
        const { result } = await document.call<T>(op, { page, ...args }, blobs);
        rememberFileChange(page, before);
        return result;
      } catch {
        dispatch({ type: 'EDIT_BUSY', busy: false });
        dispatch({ type: 'DOCUMENT_FAILED', error: 'editPdf.failed' });
        return null;
      }
    },
    [document, dispatch, rememberFileChange],
  );

  const read = useCallback(
    async <T,>(op: string, page: number): Promise<T | null> => {
      if (!document) return null;
      try {
        return (await document.call<T>(op, { page })).result;
      } catch {
        return null;
      }
    },
    [document],
  );

  return useMemo(
    () => ({
      listImages: async (page: number) => (await read<{ images: PageImage[] }>('images.list', page))?.images ?? null,
      listLinks: async (page: number) => (await read<{ links: PageLink[] }>('links.list', page))?.links ?? null,
      addImage: (page: number, matrix: Matrix, bytes: ArrayBuffer) => change<{ id: string }>(page, 'images.add', { matrix }, [bytes.slice(0)]),
      transformImage: (page: number, id: string, matrix: Matrix, clip?: Clip) =>
        change<{ images: PageImage[] }>(page, 'images.transform', { id, matrix, clip }),
      replaceImage: (page: number, id: string, bytes: ArrayBuffer) => change<{ images: PageImage[] }>(page, 'images.replace', { id }, [bytes.slice(0)]),
      deleteImage: (page: number, id: string) => change<{ images: PageImage[] }>(page, 'images.delete', { id }),
      addLink: (page: number, rect: PageLink['rect'], to: LinkTo) => change<{ links: PageLink[]; id: string }>(page, 'links.add', { rect, to }),
      updateLink: (page: number, id: string, rect?: PageLink['rect'], to?: LinkTo) => change<{ links: PageLink[] }>(page, 'links.update', { id, rect, to }),
      removeLink: (page: number, id: string) => change<{ links: PageLink[] }>(page, 'links.remove', { id }),
    }),
    [change, read],
  );
}
