import type { CoreClient, RemoteDocument } from '../core/client';
import { createPdf } from '../create/createPdf';
import type { CreateEnvironment } from '../create/createPdf';
import type { CleanupOptions } from '../ocr/cleanup';
import { startRecognizer } from '../ocr/engine';
import type { OcrLanguage, Recognizer } from '../ocr/engine';
import { readPagesWith } from '../ocr/run';
import type { PreparePixels } from '../ocr/run';
import { libraryKindOf, sourceKind } from './kinds';
import type { LibraryKind, SourceKind } from './kinds';
import { memoryLedger, unchanged } from './ledger';
import type { Ledger } from './ledger';
import { TEXT_LIMITS, boundPages, wordsAsText } from './pageText';
import type { PageText, TextLimits } from './pageText';
import { ReaderBusy, startReader } from './reader';
import type { Reader } from './reader';
import { hashBytes } from './work';

/**
 * Reading the files the Library indexes: every kind turned into the text
 * `library.add` wants, and handed to the core.
 *
 * - **PDFs** are read by Warraq's own reader, page by page. A page that
 *   carries no text is a scan, and goes through Scan & OCR — the same
 *   `ocr/run.ts` and `ocr/cleanup.ts` the tool uses, not a copy of them. A
 *   PDF whose every page is a scan is indexed as a `scan`.
 * - **Pictures** (PNG, JPEG, GIF, BMP, WebP, every page of a TIFF, and HEIC
 *   or AVIF where the browser draws them) are made a PDF by Create PDF's own
 *   `create.images`, and then read exactly as a scan is.
 * - **Word, Excel, PowerPoint, web pages, Markdown, text and CSV** are read
 *   by the readers in `create/` that Create PDF already uses, and their
 *   blocks are flattened into a page of text each (`pageText.ts`).
 *
 * Nothing heavy happens on the interface's thread. The core has its worker,
 * Tesseract has its own, and everything else — unzipping, parsing XML,
 * cleaning a scan up, measuring its slant, hashing, thumbnails — is in this
 * feature's own worker (`ingest.worker.ts`). What is left here is the
 * waiting between them.
 *
 * Every file is hostile input: its size, its pages and its characters are
 * bounded, a job that will not finish has its worker dropped, and a file
 * that cannot be read is written down with a reason while the run goes on.
 */

/** A file the Library is asked to read; the host decides what a key is. */
export interface LibraryFile {
  /** Stable for this file: its full path on the desktop, folder id + relative path in a browser. */
  key: string;
  name: string;
  /** Where it sits under the folder that was added — `reports/2024/q1.pdf` — for the folder filter. */
  path?: string;
  /** Bytes, as the file system says; 0 where it does not. */
  size: number;
  /** Milliseconds since the epoch, as the file system says. */
  modified: number;
  read(): Promise<ArrayBuffer>;
  /** Tried when the file asks for one. Never written to the index or to the ledger. */
  password?: string;
}

/** What the run is doing with a file right now. */
export type IngestStage = 'reading' | 'recognizing' | 'indexing';

export interface IngestProgress {
  /** One-based place in the run. */
  file: number;
  of: number;
  key: string;
  name: string;
  stage: IngestStage;
  /** While a scan or a picture is read: which page of how many. */
  page?: number;
  pages?: number;
}

/**
 * Why a file was not indexed. The words are the panel's to write; these are
 * the reasons it writes them from.
 */
export type SkipReason =
  | 'unchanged'
  | 'tooLarge'
  | 'unsupported'
  | 'needsPassword'
  | 'unreadable'
  | 'tooSlow'
  | 'empty'
  | 'notIndexed';

export interface IngestedFile {
  key: string;
  name: string;
  /** What the file turned out to be; absent for one that was never identified. */
  kind?: LibraryKind;
  added: boolean;
  skipped?: SkipReason;
  /** The core's error code, when one says more than the reason does. */
  problem?: string;
  /** Pages the document has, and characters put in the index. */
  pages: number;
  chars: number;
  /** Pages read by Tesseract rather than taken from the file's own text. */
  recognized: number;
  /** Something of the file was left out because it was past a bound. */
  truncated: boolean;
  /** The date the document carries, as the core found it in the text. */
  date?: string;
  /** A small picture of the first page; never for a file that needed a password. */
  thumbnail?: { image: ArrayBuffer; mime: string };
  /** Milliseconds this file took. */
  took: number;
}

export interface IngestRun {
  files: IngestedFile[];
  added: number;
  skipped: number;
  /** Files that could not be read at all, of the skipped. */
  failed: number;
  /** Pages Tesseract read in this run. */
  recognized: number;
  /** Keys the run never reached, because it was stopped: give these again to resume. */
  remaining: string[];
  took: number;
}

/** Bounds on the work one file may cost. */
export interface IngestLimits {
  /** A file larger than this is not read. */
  bytes: number;
  /** Pages of one file Tesseract may read. */
  ocrPages: number;
  /** Pages and characters the index takes of one file. */
  text: TextLimits;
  /** The longer side of a thumbnail, in pixels. */
  thumbnailEdge: number;
}

/**
 * How a scan or a photograph is cleaned up before it is read, unless the
 * panel says otherwise: the paper's own light evened out and the ink
 * stretched to black (`ocr/cleanup.ts`).
 *
 * A folder holds pages photographed by hand, and a shadow across one costs
 * Tesseract nearly all of its words. Measured on the photograph fixture
 * (`scripts/measure-library.mjs`): read as it is, 13 % of the page's words,
 * and 77 seconds spent reading nonsense; with these two steps, 93 % in 13
 * seconds. Everything the cleanup offers reaches 94 %, and doubles the time
 * a folder takes — on a 1924 manuscript, five times — so the Library stops
 * at two. Scan & OCR leaves the choice to the person, who can see the page;
 * the Library never can.
 */
export const LIBRARY_CLEANUP: CleanupOptions = {
  background: true,
  contrast: true,
  binarize: false,
  despeckle: false,
  borders: false,
};

export const INGEST_LIMITS: IngestLimits = {
  bytes: 128 * 1024 * 1024,
  ocrPages: 50,
  text: TEXT_LIMITS,
  thumbnailEdge: 192,
};

export interface IngestOptions {
  /** From `library.open`. */
  handle: number;
  files: readonly LibraryFile[];
  client: Pick<CoreClient, 'open' | 'callStatic'>;
  /** Read scans and pictures with Tesseract; on by default. */
  recognize?: boolean;
  languages?: readonly OcrLanguage[];
  /** How a scan is cleaned up before it is read; `LIBRARY_CLEANUP` by default. */
  cleanup?: CleanupOptions;
  /** What has already been read, so it is not read again. Kept only in memory by default. */
  ledger?: Ledger;
  /** The worker that does the reading; the app's own by default. */
  reader?: Reader;
  /** A recognizer already running: used and left running. */
  recognizer?: Recognizer;
  signal?: AbortSignal;
  onProgress?: (progress: IngestProgress) => void;
  onFile?: (file: IngestedFile) => void;
  limits?: Partial<IngestLimits>;
}

/** What `library.add` answers. */
interface Added {
  added: boolean;
  skipped?: string;
  pages: number;
  chars: number;
  date?: string;
  guessedKind?: string;
}

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return /^(E_[A-Z_]+)/.exec(String((error as Error)?.message ?? error))?.[1] ?? '';
};

/** A copy of `bytes` that a transfer may take without losing the original. */
const copy = (bytes: ArrayBuffer): ArrayBuffer => bytes.slice(0);

/** What was read of one file, before it goes to the index. */
interface ReadFile {
  kind: LibraryKind;
  pages: PageText[];
  /** Pages the document has, text or not. */
  pageCount: number;
  recognized: number;
  truncated: boolean;
  thumbnail?: { image: ArrayBuffer; mime: string };
}

/**
 * One run over `files`. It resolves when every file has been read, or as
 * soon as `signal` aborts — the files it never reached come back in
 * `remaining`, and a run given exactly those carries on where this one
 * stopped. A file that finished is written down in the ledger, so giving the
 * whole list again is just as good: what was done is skipped, not redone.
 */
export async function ingestFiles(options: IngestOptions): Promise<IngestRun> {
  const started = Date.now();
  const limits: IngestLimits = { ...INGEST_LIMITS, ...options.limits };
  const ledger = options.ledger ?? memoryLedger();
  const ownReader = !options.reader;
  const reader = options.reader ?? startReader();
  const signal = options.signal;
  const languages = options.languages ?? ['ara', 'eng'];
  const cleanup = options.cleanup ?? LIBRARY_CLEANUP;
  const recognizing = options.recognize ?? true;
  const say = options.onProgress ?? (() => undefined);
  const run: IngestRun = { files: [], added: 0, skipped: 0, failed: 0, recognized: 0, remaining: [], took: 0 };

  // One recognizer for the whole run: starting Tesseract costs seconds, and
  // a folder of scans would pay it for every file.
  let recognizer = options.recognizer;
  const ownRecognizer = !options.recognizer;
  const recognizerFor = async (): Promise<Recognizer> => {
    recognizer ??= await startRecognizer(languages);
    return recognizer;
  };

  /** The pixel work, in the Library's own worker instead of this thread. */
  const prepare: PreparePixels = async (page, steps, dpi) => {
    const buffer = page.rgba.buffer;
    const reply = await reader.work({ job: 'prepare', page: { width: page.width, height: page.height, rgba: buffer }, cleanup: steps, dpi }, [buffer]);
    if (reply.job !== 'prepare') throw new Error('E_READER: wrong answer');
    return {
      page: { width: reply.page.width, height: reply.page.height, rgba: new Uint8ClampedArray(reply.page.rgba) },
      angle: reply.angle,
    };
  };

  /** Create PDF's own environment, with its picture decoding in the worker. */
  const createEnvironment: CreateEnvironment = {
    callStatic: (op, args, blobs) => options.client.callStatic(op, args, blobs),
    // Pictures never need a face: only `create.document` typesets text.
    fonts: () => Promise.resolve([]),
    decodePicture: async (bytes, mime) => {
      const buffer = copy(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      const reply = await reader.work({ job: 'decode', bytes: buffer, mime }, [buffer]);
      return reply.job === 'decode' && reply.bytes ? new Uint8Array(reply.bytes) : null;
    },
  };

  async function thumbnailOfDocument(doc: RemoteDocument): Promise<{ image: ArrayBuffer; mime: string } | undefined> {
    if (doc.pageCount < 1) return undefined;
    const [width, height] = doc.pageSizes[0] ?? [612, 792];
    // Drawn only as large as the thumbnail needs: the cheapest render there is.
    const scale = Math.min(1, limits.thumbnailEdge / Math.max(1, Math.max(width, height)));
    const page = await doc.render_page(0, scale);
    const buffer = page.rgba.buffer;
    const reply = await reader.work({ job: 'thumbnail', page: { width: page.width, height: page.height, rgba: buffer }, edge: limits.thumbnailEdge }, [buffer]);
    if (reply.job !== 'thumbnail' || !reply.image) return undefined;
    return { image: reply.image, mime: reply.mime };
  }

  /** A PDF — the file's own, or the one a picture was just made into. */
  async function readPdf(doc: RemoteDocument, protectedFile: boolean, at: Omit<IngestProgress, 'stage'>, picture: boolean): Promise<ReadFile> {
    const pages: PageText[] = [];
    const blank: number[] = [];
    const count = doc.pageCount;
    let ownText = 0;
    const reading = Math.min(count, limits.text.pages);
    for (let index = 0; index < reading; index += 1) {
      if (signal?.aborted) break;
      say({ ...at, stage: 'reading', page: index + 1, pages: reading });
      // A picture is all picture: there is nothing to extract, only to recognize.
      const text = picture ? '' : await doc.extract_text(index);
      if (text.trim().length > 0) {
        pages.push({ page: index + 1, text });
        ownText += 1;
      } else blank.push(index);
    }
    let recognized = 0;
    let truncated = count > reading;
    if (recognizing && blank.length > 0 && !signal?.aborted) {
      const targets = blank.slice(0, limits.ocrPages);
      truncated ||= targets.length < blank.length;
      say({ ...at, stage: 'recognizing', page: 1, pages: targets.length });
      const read = await readPagesWith(doc, {
        languages,
        scope: 'blank',
        pages: targets,
        onProgress: (progress) => say({ ...at, stage: 'recognizing', page: progress.page, pages: progress.of }),
        signal,
        options: { cleanup, replaceImage: false },
        recognizer: await recognizerFor(),
        prepare,
      });
      for (const page of read) {
        const text = wordsAsText(page.words);
        if (text.length > 0) pages.push({ page: page.index + 1, text });
      }
      recognized = read.length;
    }
    pages.sort((a, b) => a.page - b.page);
    const bounded = boundPages(pages, limits.text);
    // A PDF no page of which carries text of its own is a scan — whether or
    // not Tesseract was asked to read it, so that "has no text layer" finds it.
    const kind: LibraryKind = picture ? 'image' : count > 0 && ownText === 0 ? 'scan' : 'pdf';
    return {
      kind,
      pages: bounded.pages,
      pageCount: count,
      recognized,
      truncated: truncated || bounded.truncated,
      ...(protectedFile ? {} : { thumbnail: await thumbnailOfDocument(doc) }),
    };
  }

  /** Opens a PDF, with the file's password only if it asks for one. */
  async function openPdf(bytes: ArrayBuffer, password: string | undefined): Promise<{ doc: RemoteDocument; protectedFile: boolean }> {
    try {
      return { doc: await options.client.open(copy(bytes), undefined), protectedFile: false };
    } catch (error) {
      if (codeOf(error) !== 'E_PASSWORD') throw error;
      if (!password) throw error;
      return { doc: await options.client.open(copy(bytes), password), protectedFile: true };
    }
  }

  async function readOne(file: LibraryFile, bytes: ArrayBuffer, kind: SourceKind, at: Omit<IngestProgress, 'stage'>): Promise<ReadFile> {
    if (kind === 'pdf') {
      const { doc, protectedFile } = await openPdf(bytes, file.password);
      try {
        return await readPdf(doc, protectedFile, at, false);
      } finally {
        void doc.free();
      }
    }
    if (kind === 'image') {
      say({ ...at, stage: 'reading' });
      // Create PDF's own path: one page a picture, every page of a TIFF, HEIC
      // through the browser — and then read exactly as a scan is.
      const made = await createPdf([{ name: file.name, bytes: copy(bytes) }], { paper: 'auto', orientation: 'auto', margin: 'none' }, createEnvironment);
      const doc = await options.client.open(made.bytes, undefined);
      try {
        return await readPdf(doc, false, at, true);
      } finally {
        void doc.free();
      }
    }
    say({ ...at, stage: 'reading' });
    const reply = await reader.work({ job: 'read', source: kind, bytes, limits: limits.text }, [bytes]);
    if (reply.job !== 'read') throw new Error('E_READER: wrong answer');
    return { kind: libraryKindOf(kind), pages: reply.pages, pageCount: Math.max(1, reply.pages.length), recognized: 0, truncated: reply.truncated };
  }

  const finish = (file: IngestedFile) => {
    run.files.push(file);
    if (file.added) run.added += 1;
    else {
      run.skipped += 1;
      if (file.skipped === 'unreadable' || file.skipped === 'tooSlow' || file.skipped === 'notIndexed') run.failed += 1;
    }
    run.recognized += file.recognized;
    options.onFile?.(file);
  };

  try {
    for (const [index, file] of options.files.entries()) {
      if (signal?.aborted) {
        run.remaining.push(file.key);
        continue;
      }
      const at = { file: index + 1, of: options.files.length, key: file.key, name: file.name };
      const fileStarted = Date.now();
      const nothing = (skipped: SkipReason, kind?: LibraryKind, problem?: string): IngestedFile => ({
        key: file.key,
        name: file.name,
        ...(kind ? { kind } : {}),
        added: false,
        skipped,
        ...(problem ? { problem } : {}),
        pages: 0,
        chars: 0,
        recognized: 0,
        truncated: false,
        took: Date.now() - fileStarted,
      });
      say({ ...at, stage: 'reading' });
      let bytes: ArrayBuffer;
      try {
        bytes = await file.read();
      } catch (error) {
        finish(nothing('unreadable', undefined, codeOf(error) || undefined));
        continue;
      }
      if (bytes.byteLength > limits.bytes) {
        finish(nothing('tooLarge'));
        continue;
      }
      const size = file.size || bytes.byteLength;
      const hash = await hashBytes(bytes);
      if (unchanged(ledger.mark(file.key), { size, modified: file.modified }, hash)) {
        finish(nothing('unchanged'));
        continue;
      }
      const kind = sourceKind(file.name, new Uint8Array(bytes));
      if (!kind) {
        finish(nothing('unsupported'));
        continue;
      }
      let read: ReadFile;
      try {
        read = await readOne(file, bytes, kind, at);
      } catch (error) {
        if (error instanceof ReaderBusy) finish(nothing('tooSlow', libraryKindOf(kind)));
        else if (codeOf(error) === 'E_PASSWORD') finish(nothing('needsPassword', libraryKindOf(kind)));
        else finish(nothing('unreadable', libraryKindOf(kind), codeOf(error) || undefined));
        continue;
      }
      // Stopped part-way through this file: it is not indexed and not written
      // down, so the run that resumes reads it from the start.
      if (signal?.aborted) {
        run.remaining.push(file.key);
        continue;
      }
      // A document with nothing to say is not worth a record; a PDF or a
      // picture still is — it has pages, a thumbnail, and the filters for a
      // scan with no text layer must find it.
      const printed = read.kind === 'pdf' || read.kind === 'scan' || read.kind === 'image';
      if (read.pages.length === 0 && !printed) {
        finish({ ...nothing('empty', read.kind), pages: read.pageCount, recognized: read.recognized, truncated: read.truncated });
        continue;
      }
      say({ ...at, stage: 'indexing' });
      let answer: Added;
      try {
        const reply = await options.client.callStatic<Added>('library.add', {
          handle: options.handle,
          key: file.key,
          name: file.name,
          kind: read.kind,
          modified: file.modified,
          pages: read.pageCount,
          text: read.pages,
        });
        answer = reply.result;
      } catch (error) {
        finish(nothing('notIndexed', read.kind, codeOf(error) || undefined));
        continue;
      }
      const chars = answer.chars || read.pages.reduce((sum, page) => sum + page.text.length, 0);
      if (answer.added) ledger.remember(file.key, { size, modified: file.modified, hash, indexed: Date.now() });
      finish({
        key: file.key,
        name: file.name,
        kind: read.kind,
        added: answer.added,
        ...(answer.added ? {} : { skipped: 'notIndexed' as SkipReason, problem: answer.skipped }),
        pages: answer.pages || read.pageCount,
        chars,
        recognized: read.recognized,
        truncated: read.truncated,
        ...(answer.date ? { date: answer.date } : {}),
        ...(read.thumbnail ? { thumbnail: read.thumbnail } : {}),
        took: Date.now() - fileStarted,
      });
    }
  } finally {
    if (ownRecognizer && recognizer) await recognizer.stop().catch(() => undefined);
    if (ownReader) reader.close();
  }
  run.took = Date.now() - started;
  return run;
}
