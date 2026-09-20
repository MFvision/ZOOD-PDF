import { useSyncExternalStore } from 'react';
import type { Clip, Matrix } from './matrix';

/**
 * Edit PDF's own state: which kind of thing is being edited — text,
 * pictures or links — and what is selected. It lives beside the app's
 * reducer rather than in it, because nothing outside the editor reads it.
 * The document itself changes only through the core (`images.*`,
 * `links.*`), and each change bumps the page's revision like a text edit.
 */
export type EditKind = 'text' | 'images' | 'links';

/** A picture on a page, as `images.list` answers. */
export interface PageImage {
  id: string;
  matrix: Matrix;
  clip: Clip;
  pixels: [number, number];
  inline: boolean;
  inForm: boolean;
  /** Drawn in several places by the same bytes: not offered for editing. */
  shared: boolean;
}

/** Where a link goes: an address, or a page (0-based). */
export interface LinkTo {
  uri?: string;
  page?: number;
}

/** A link on a page, as `links.list` answers. */
export interface PageLink {
  id: string;
  rect: [number, number, number, number];
  to: LinkTo;
}

/** A picture chosen to place, waiting for where. */
export interface PendingPicture {
  name: string;
  bytes: ArrayBuffer;
  width: number;
  height: number;
}

export interface EditPdfState {
  kind: EditKind;
  /** The selected picture: its page and its place in that page's list. */
  image: { page: number; index: number } | null;
  cropping: boolean;
  pending: PendingPicture | null;
  link: { page: number; id: string } | null;
  /** A link area drawn and not yet given somewhere to go. */
  draft: { page: number; rect: [number, number, number, number] } | null;
  /** The latest lists per page, for the panel's inspector. */
  images: Readonly<Record<number, readonly PageImage[]>>;
  links: Readonly<Record<number, readonly PageLink[]>>;
  /**
   * The page revision each list was read at. A change clears `busy` before
   * the page's list is read again; until it is, the list describes the page
   * as it was, and a key or a click acting on it would undo part of the
   * change (`listFresh`).
   */
  imagesAt: Readonly<Record<number, number>>;
  linksAt: Readonly<Record<number, number>>;
}

const INITIAL: EditPdfState = {
  kind: 'text',
  image: null,
  cropping: false,
  pending: null,
  link: null,
  draft: null,
  images: {},
  links: {},
  imagesAt: {},
  linksAt: {},
};

let state: EditPdfState = INITIAL;
const listeners = new Set<() => void>();

export function updateEditPdf(change: Partial<EditPdfState> | ((current: EditPdfState) => Partial<EditPdfState>)): void {
  const next = typeof change === 'function' ? change(state) : change;
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

/** Back to text, nothing selected: a new document, or the editor closed. */
export function resetEditPdf(): void {
  state = INITIAL;
  for (const listener of listeners) listener();
}

export function useEditPdf(): EditPdfState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => INITIAL,
  );
}

/** Whether a page's list of pictures (or links) was read at the page as it is now. */
export function listFresh(listedAt: Readonly<Record<number, number>>, page: number, revision: number): boolean {
  return listedAt[page] === revision;
}

/** The selected picture, if its page's list still has it. */
export function selectedImage(current: EditPdfState): PageImage | null {
  if (!current.image) return null;
  return current.images[current.image.page]?.[current.image.index] ?? null;
}

export function selectedLink(current: EditPdfState): PageLink | null {
  if (!current.link) return null;
  return current.links[current.link.page]?.find((link) => link.id === current.link?.id) ?? null;
}

/**
 * A picture's size in pixels, turned as its EXIF orientation says it is
 * shown — as the core turns it before it goes in (`picture.rs`), so the box
 * it is placed in has the proportions it is drawn with.
 */
export async function pictureSize(bytes: ArrayBuffer, type: string): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(new Blob([bytes], { type }), { imageOrientation: 'from-image' });
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

/** PNG or JPEG, by content: the core takes nothing else. */
export function pictureType(bytes: ArrayBuffer): 'image/png' | 'image/jpeg' | null {
  const head = new Uint8Array(bytes.slice(0, 8));
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  return null;
}
