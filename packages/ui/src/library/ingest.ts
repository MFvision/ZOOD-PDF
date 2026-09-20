import { kindOfName } from './kinds';
import type { LibraryKind, PageText } from './ops';

/**
 * Turning one file into text the index can hold.
 *
 * This is the seam between the Library panel (which walks the files, shows
 * the progress and keeps the index) and the readers (PDFs through the core,
 * scans and pictures through Scan & OCR, Word/Excel/PowerPoint/HTML/Markdown
 * through the readers `create/` already has). The panel calls `ingest` and
 * knows nothing else about how a file is read; the readers live behind it,
 * off the interface's thread.
 *
 * A PDF is not read here: the core reads it itself from the bytes, which is
 * both faster and the only place that knows whether its pages have text (a
 * PDF with none comes back as a `scan`). For those `ingest` answers with the
 * bytes and no text.
 */

export interface IngestSource {
  /** The host's stable identifier: a full path on the desktop, folder + relative path in a browser. */
  key: string;
  name: string;
  size?: number;
  /** The file's own modified time, in milliseconds since the epoch. */
  modified: number;
  /** The file's bytes, read only when its turn comes. */
  bytes: () => Promise<ArrayBuffer>;
  /** The password for a protected file, when the person gave one. Never stored. */
  password?: string;
}

export interface IngestProgress {
  /** What is being done to this file now, for the progress line. */
  stage: 'reading' | 'recognizing';
  /** The page being read, one-based, when the reader works page by page. */
  page?: number;
  pages?: number;
}

export type IngestResult =
  /** Text read here; the bytes do not go to the core. */
  | { read: 'text'; kind: LibraryKind; text: PageText[]; pages: number }
  /** The core reads these bytes itself (PDFs). */
  | { read: 'bytes'; kind: LibraryKind; bytes: ArrayBuffer }
  /** Nothing could be read; the run carries on and the file is listed with this reason. */
  | { read: 'skipped'; reason: string };

export interface IngestOptions {
  signal?: AbortSignal;
  onProgress?: (progress: IngestProgress) => void;
  /** The interface language, for a reader that needs one (OCR). */
  lang?: string;
}

export type Ingest = (source: IngestSource, options?: IngestOptions) => Promise<IngestResult>;

/**
 * What the panel uses until the readers land: PDFs, straight to the core.
 * Every other kind is reported as skipped with its reason, which the progress
 * view shows — the person is told what was not read instead of being left to
 * guess why a word is not found.
 */
export const ingest: Ingest = async (source) => {
  const kind = kindOfName(source.name);
  if (kind === null) return { read: 'skipped', reason: 'kind' };
  if (kind !== 'pdf') return { read: 'skipped', reason: 'reader' };
  return { read: 'bytes', kind, bytes: await source.bytes() };
};
