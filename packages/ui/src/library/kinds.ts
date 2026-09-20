import { CREATE_ACCEPT, createKind } from '../create/createPdf';
import type { CreateKind } from '../create/createPdf';

/**
 * What kind of thing a file in the Library is. The names are the ones the
 * core's `library.add` takes (the brief's contract): a PDF whose pages carry
 * no text of their own is a `scan`, and a picture is an `image` whether it
 * holds words or not — both are read with Scan & OCR.
 */
export type LibraryKind =
  | 'pdf'
  | 'scan'
  | 'image'
  | 'word'
  | 'excel'
  | 'powerpoint'
  | 'html'
  | 'text'
  | 'markdown';

/** A file the readers in `create/` turn into blocks, or a picture, or a PDF. */
export type SourceKind = CreateKind | 'pdf';

/** What the Library's file and folder pickers offer: what Create PDF reads, and PDFs. */
export const LIBRARY_ACCEPT = ['.pdf', 'application/pdf', ...CREATE_ACCEPT.split(',')].join(',');

/** The extensions the desktop's folder walk keeps. */
export const LIBRARY_EXTENSIONS = LIBRARY_ACCEPT.split(',')
  .filter((entry) => entry.startsWith('.'))
  .map((entry) => entry.slice(1));

/** The kind `library.add` is told, for a source of this kind. */
const KIND_OF: Record<SourceKind, LibraryKind> = {
  pdf: 'pdf',
  image: 'image',
  docx: 'word',
  xlsx: 'excel',
  pptx: 'powerpoint',
  html: 'html',
  markdown: 'markdown',
  // A comma-separated table is text: the contract has no kind of its own for it.
  csv: 'text',
  text: 'text',
};

export const libraryKindOf = (source: SourceKind): LibraryKind => KIND_OF[source];

/**
 * What a file is, by its content first and its name only where the content
 * cannot say — exactly as Create PDF decides it, with PDFs added. Null for
 * anything the Library cannot read, which is skipped with a reason.
 */
export function sourceKind(name: string, bytes: Uint8Array): SourceKind | null {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
  return createKind(name, bytes);
}
