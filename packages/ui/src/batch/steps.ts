import {
  EyeOff,
  LockOpen,
  Ratio,
  FileOutput,
  Layers,
  Lock,
  RotateCw,
  ScanText,
  Scissors,
  Shrink,
  Stamp,
  Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { COMPRESS_LEVELS } from '../compress/levels';
import type { CompressLevel } from '../compress/levels';
import type { CoreClient } from '../core/client';
import { loadEditFont } from '../edit/editFont';
import { EXPORT_FORMATS, RESOLUTIONS, DEFAULT_RESOLUTION } from '../export/formats';
import type { ExportFormat } from '../export/formats';
import { exportDocument } from '../export/runExport';
import type { Lang, TKey, TParams } from '../i18n/messages';
import { DEFAULT_FORM, hasContent, specOf } from '../marks/markSpec';
import type { MarkForm, MarkPosition, NumberFormat } from '../marks/markSpec';
import { NO_CLEANUP, anyCleanup, sanitizeCleanup } from '../ocr/cleanup';
import type { CleanupOptions } from '../ocr/cleanup';
import { OCR_LANGUAGES } from '../ocr/engine';
import type { OcrLanguage, Recognizer } from '../ocr/engine';
import { recognizeFile } from '../ocr/run';
import type { OcrScope } from '../ocr/run';
import { HIDDEN_KINDS } from '../redact/findings';
import type { HiddenKind } from '../redact/findings';
import { ALL_PAGES, choiceValid, choosePages, sanitizeChoice } from './pages';
import type { PageChoice } from './pages';
import type { PdfiumTools, ProtectSpec } from './pdfium';

/**
 * The batch's steps: a registry. Each step is what one of Warraq's tools
 * does to an open file, done to a file of the batch instead — through the
 * same core operations (`warraq-core/src/tools`) or, for Protect and
 * Flatten, the same PDFium EmbedPDF's view uses. A new operation joins the
 * batch by adding an entry here: its options, how they are checked when an
 * action is read back, and how it runs. `StepOptions.tsx` gives it controls.
 */

/** A file as the steps pass it along. */
export interface BatchDoc {
  bytes: ArrayBuffer;
  /** The password it opens with now: the batch's, or the one Protect gave it. */
  password?: string;
  /** `pdf` until a step makes something else of it (Export). */
  extension: string;
}

/** What a step may use besides the file. */
export interface StepContext {
  client: Pick<CoreClient, 'open' | 'callStatic'>;
  /** PDFium, started on first use. */
  pdfium: () => Promise<PdfiumTools>;
  /** Tesseract for these languages, started on first use and kept for the rest of the batch. */
  recognizer: (languages: readonly OcrLanguage[]) => Promise<Recognizer>;
  /** The original file's name: `{file}` in a header, an export's title. */
  name: string;
  lang: Lang;
  t: (key: TKey, params?: TParams) => string;
  signal: AbortSignal;
  /** How far a long step has got, said beside the file. */
  onDetail: (key: TKey, params?: TParams) => void;
  now: Date;
}

/** A step that cannot do its work on this file, and why, in the interface's words. */
export class StepError extends Error {
  constructor(
    readonly key: TKey,
    readonly params?: TParams,
  ) {
    super(key);
  }
}

export type StepId =
  | 'ocr'
  | 'compress'
  | 'rotate'
  | 'deletePages'
  | 'extractPages'
  | 'pageMarks'
  | 'removeHidden'
  | 'flatten'
  | 'protect'
  | 'unlock'
  | 'resize'
  | 'export';

export interface StepDefinition<O> {
  id: StepId;
  labelKey: TKey;
  /** What the step does, said once under its name. */
  noteKey: TKey;
  icon: LucideIcon;
  /** Export makes something other than a PDF: nothing can come after it. */
  last?: boolean;
  defaults(): O;
  /** Options read back from storage, each one checked. */
  sanitize(raw: unknown): O;
  /** The options as they are kept with a saved action: passwords never are. */
  keep?(options: O): O;
  /** Why the options cannot run as they are, or null. */
  problem(options: O): TKey | null;
  run(doc: BatchDoc, options: O, context: StepContext): Promise<BatchDoc>;
}

/* ---------------------------------------------------------------- helpers */

const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
const oneOf = <T extends string | number>(value: unknown, choices: readonly T[], fallback: T): T =>
  choices.includes(value as T) ? (value as T) : fallback;
const number = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const text = (value: unknown, fallback: string, max = 200) => (typeof value === 'string' ? value.slice(0, max) : fallback);
const record = (raw: unknown) => (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {});

function buffer(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Opens the file with the core, runs `work` on it, and frees it. */
async function withDocument<T>(
  context: StepContext,
  doc: BatchDoc,
  work: (open: Awaited<ReturnType<StepContext['client']['open']>>) => Promise<T>,
): Promise<T> {
  const open = await context.client.open(doc.bytes.slice(0), doc.password);
  try {
    return await work(open);
  } finally {
    void open.free();
  }
}

/* ------------------------------------------------------------------- OCR */

export interface OcrStep {
  languages: OcrLanguage[];
  scope: OcrScope;
  cleanup: CleanupOptions;
  replaceImage: boolean;
}

const ocr: StepDefinition<OcrStep> = {
  id: 'ocr',
  labelKey: 'tool.ocr',
  noteKey: 'batch.step.ocrNote',
  icon: ScanText,
  defaults: () => ({ languages: ['ara', 'eng'], scope: 'blank', cleanup: NO_CLEANUP, replaceImage: false }),
  sanitize(raw) {
    const given = record(raw);
    const languages = Array.isArray(given.languages)
      ? OCR_LANGUAGES.filter((code) => (given.languages as unknown[]).includes(code))
      : ['ara', 'eng'];
    return {
      languages: languages as OcrLanguage[],
      scope: oneOf(given.scope, ['blank', 'all'] as const, 'blank'),
      cleanup: sanitizeCleanup(given.cleanup),
      replaceImage: bool(given.replaceImage, false),
    };
  },
  problem: (o) => (o.languages.length === 0 ? 'batch.problem.languages' : null),
  async run(doc, o, context) {
    const { bytes } = await recognizeFile(
      context.client,
      doc.bytes,
      doc.password,
      o.languages,
      o.scope,
      (progress) => context.onDetail('batch.detail.ocr', { page: progress.page, of: progress.of }),
      context.signal,
      { cleanup: o.cleanup, replaceImage: o.replaceImage && anyCleanup(o.cleanup) },
      // One Tesseract for the whole batch, not one a file.
      await context.recognizer(o.languages),
    );
    return { ...doc, bytes };
  },
};

/* -------------------------------------------------------------- compress */

export interface CompressStep {
  level: CompressLevel;
}

const compress: StepDefinition<CompressStep> = {
  id: 'compress',
  labelKey: 'tool.compress',
  noteKey: 'batch.step.compressNote',
  icon: Shrink,
  defaults: () => ({ level: 'balanced' }),
  sanitize: (raw) => ({ level: oneOf(record(raw).level, Object.keys(COMPRESS_LEVELS) as CompressLevel[], 'balanced') }),
  problem: () => null,
  async run(doc, o, context) {
    type Answer = { refused?: 'protected' | 'signed'; unchanged?: boolean };
    const { result, blobs } = await context.client.callStatic<Answer>(
      'compress.file',
      { password: doc.password ?? null, ...COMPRESS_LEVELS[o.level] },
      [doc.bytes.slice(0)],
    );
    if (result.refused === 'protected') throw new StepError('batch.error.compressProtected');
    if (result.refused === 'signed') throw new StepError('batch.error.compressSigned');
    // Already as small as it gets: the file itself, not a rewrite of it.
    if (result.unchanged || !blobs[0]) return doc;
    return { ...doc, bytes: blobs[0] };
  },
};

/* ----------------------------------------------------------------- pages */

export interface RotateStep {
  pages: PageChoice;
  /** Quarter turns clockwise: 1, 2 or 3. */
  turn: 1 | 2 | 3;
}

const rotate: StepDefinition<RotateStep> = {
  id: 'rotate',
  labelKey: 'batch.step.rotate',
  noteKey: 'batch.step.rotateNote',
  icon: RotateCw,
  defaults: () => ({ pages: ALL_PAGES, turn: 1 }),
  sanitize(raw) {
    const given = record(raw);
    return { pages: sanitizeChoice(given.pages), turn: oneOf(given.turn, [1, 2, 3] as const, 1) };
  },
  problem: (o) => (choiceValid(o.pages) ? null : 'batch.problem.pages'),
  run: (doc, o, context) =>
    withDocument(context, doc, async (open) => {
      const pages = choosePages(o.pages, open.pageCount) ?? [];
      if (pages.length === 0) return doc;
      await open.call('pages.rotate', { pages, quarterTurns: o.turn });
      return { ...doc, bytes: buffer(await open.save()) };
    }),
};

export interface PagesStep {
  pages: PageChoice;
}

const deletePages: StepDefinition<PagesStep> = {
  id: 'deletePages',
  labelKey: 'batch.step.deletePages',
  noteKey: 'batch.step.deletePagesNote',
  icon: Trash2,
  defaults: () => ({ pages: { which: 'list', list: '1' } }),
  sanitize: (raw) => ({ pages: sanitizeChoice(record(raw).pages, { which: 'list', list: '1' }) }),
  problem: (o) => (o.pages.which === 'all' ? 'batch.problem.deleteAll' : choiceValid(o.pages) ? null : 'batch.problem.pages'),
  run: (doc, o, context) =>
    withDocument(context, doc, async (open) => {
      const pages = choosePages(o.pages, open.pageCount) ?? [];
      if (pages.length === 0) return doc;
      if (pages.length >= open.pageCount) throw new StepError('batch.error.deleteAll');
      await open.call('pages.delete', { pages });
      return { ...doc, bytes: buffer(await open.save()) };
    }),
};

const extractPages: StepDefinition<PagesStep> = {
  id: 'extractPages',
  labelKey: 'batch.step.extractPages',
  noteKey: 'batch.step.extractPagesNote',
  icon: Scissors,
  defaults: () => ({ pages: { which: 'list', list: '1' } }),
  sanitize: (raw) => ({ pages: sanitizeChoice(record(raw).pages, { which: 'list', list: '1' }) }),
  problem: (o) => (choiceValid(o.pages) ? null : 'batch.problem.pages'),
  run: (doc, o, context) =>
    withDocument(context, doc, async (open) => {
      const pages = choosePages(o.pages, open.pageCount) ?? [];
      if (pages.length === 0) throw new StepError('batch.error.noPages');
      if (pages.length === open.pageCount) return doc;
      const { blobs } = await open.call('pages.extract', { pages });
      if (!blobs[0]) throw new StepError('batch.error.failed');
      // A new file of those pages, made without the original's protection.
      return { bytes: blobs[0], extension: 'pdf' };
    }),
};

/* ---------------------------------------------------------------- resize */

/** Paper sizes in points, as a portrait sheet: each page is turned its own way on it. */
export const PAPER_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
  legal: [612, 1008],
  a3: [841.89, 1190.55],
  a5: [419.53, 595.28],
} as const;
export type PaperSize = keyof typeof PAPER_SIZES;
export const PAPERS = Object.keys(PAPER_SIZES) as PaperSize[];

export interface ResizeStep {
  pages: PageChoice;
  paper: PaperSize;
}

const resize: StepDefinition<ResizeStep> = {
  id: 'resize',
  labelKey: 'batch.step.resize',
  noteKey: 'batch.step.resizeNote',
  icon: Ratio,
  defaults: () => ({ pages: ALL_PAGES, paper: 'a4' }),
  sanitize(raw) {
    const given = record(raw);
    return { pages: sanitizeChoice(given.pages), paper: oneOf(given.paper, PAPERS, 'a4') };
  },
  problem: (o) => (choiceValid(o.pages) ? null : 'batch.problem.pages'),
  run: (doc, o, context) =>
    withDocument(context, doc, async (open) => {
      const pages = choosePages(o.pages, open.pageCount) ?? [];
      if (pages.length === 0) return doc;
      const [width, height] = PAPER_SIZES[o.paper];
      await open.call('pages.resize', { pages, width, height });
      return { ...doc, bytes: buffer(await open.save()) };
    }),
};

/* ------------------------------------------------------------ page marks */

export interface MarksStep {
  form: MarkForm;
  pages: PageChoice;
}

const POSITIONS: readonly MarkPosition[] = ['topLeft', 'top', 'topRight', 'left', 'center', 'right', 'bottomLeft', 'bottom', 'bottomRight', 'tiled'];
const FORMATS: readonly NumberFormat[] = ['plain', 'ofTotal', 'pageOfEnglish', 'pageOfArabic', 'roman'];

/** A mark's settings read back: a text mark only (a picture would have to be kept with the action). */
export function sanitizeMarkForm(raw: unknown): MarkForm {
  const given = record(raw);
  const d = DEFAULT_FORM;
  const slots = Array.isArray(given.slots) ? given.slots : [];
  return {
    ...d,
    section: oneOf(given.section, ['watermark', 'band', 'pageNumber', 'bates'] as const, d.section),
    watermarkSource: 'text',
    watermarkText: text(given.watermarkText, d.watermarkText),
    watermarkPosition: oneOf(given.watermarkPosition, POSITIONS, d.watermarkPosition),
    watermarkSize: number(given.watermarkSize, d.watermarkSize, 6, 400),
    rotation: number(given.rotation, d.rotation, -180, 180),
    opacity: number(given.opacity, d.opacity, 5, 100),
    front: bool(given.front, d.front),
    color: typeof given.color === 'string' && /^#[0-9a-f]{6}$/i.test(given.color) ? given.color : d.color,
    band: oneOf(given.band, ['header', 'footer'] as const, d.band),
    slots: [text(slots[0], ''), text(slots[1], ''), text(slots[2], '')],
    direction: oneOf(given.direction, ['auto', 'rtl', 'ltr'] as const, d.direction),
    numberFormat: oneOf(given.numberFormat, FORMATS, d.numberFormat),
    numberPosition: oneOf(given.numberPosition, POSITIONS, d.numberPosition),
    startNumber: number(given.startNumber, d.startNumber, 0, 1_000_000),
    skipFirst: bool(given.skipFirst, d.skipFirst),
    batesPrefix: text(given.batesPrefix, d.batesPrefix, 40),
    batesSuffix: text(given.batesSuffix, d.batesSuffix, 40),
    batesStart: number(given.batesStart, d.batesStart, 0, 1_000_000_000),
    batesDigits: number(given.batesDigits, d.batesDigits, 1, 20),
    batesPosition: oneOf(given.batesPosition, POSITIONS, d.batesPosition),
    numerals: oneOf(given.numerals, ['western', 'arabic'] as const, d.numerals),
    calendar: oneOf(given.calendar, ['gregorian', 'hijri'] as const, d.calendar),
    size: number(given.size, d.size, 4, 72),
    margin: number(given.margin, d.margin, 0, 200),
    font: oneOf(given.font, ['amiri', 'cairo', 'inter'] as const, d.font),
    pages: '',
  };
}

const pageMarks: StepDefinition<MarksStep> = {
  id: 'pageMarks',
  labelKey: 'tool.pageMarks',
  noteKey: 'batch.step.pageMarksNote',
  icon: Stamp,
  defaults: () => ({ form: { ...DEFAULT_FORM, section: 'pageNumber', numberPosition: 'bottom' }, pages: ALL_PAGES }),
  sanitize(raw) {
    const given = record(raw);
    return { form: sanitizeMarkForm(given.form), pages: sanitizeChoice(given.pages) };
  },
  problem: (o) => (!hasContent(o.form, false) ? 'batch.problem.markEmpty' : choiceValid(o.pages) ? null : 'batch.problem.pages'),
  async run(doc, o, context) {
    const count = await withDocument(context, doc, async (open) => open.pageCount);
    const pages = choosePages(o.pages, count) ?? [];
    if (pages.length === 0) return doc;
    const font = await loadEditFont(o.form.font);
    const { blobs } = await context.client.callStatic<{ id: number }>(
      'marks.add',
      {
        password: doc.password ?? null,
        mark: specOf(o.form, { fileName: context.name, now: context.now }),
        pages: pages.length === count ? [] : pages,
        replace: true,
        fontBlob: 1,
      },
      [doc.bytes.slice(0), font.slice().buffer],
    );
    if (!blobs[0]) throw new StepError('batch.error.failed');
    return { ...doc, bytes: blobs[0] };
  },
};

/* ---------------------------------------------- remove hidden information */

export interface HiddenStep {
  kinds: HiddenKind[];
}

const removeHidden: StepDefinition<HiddenStep> = {
  id: 'removeHidden',
  labelKey: 'batch.step.removeHidden',
  noteKey: 'batch.step.removeHiddenNote',
  icon: EyeOff,
  // Everything but hidden text: a scan's searchable layer is hidden text.
  defaults: () => ({ kinds: HIDDEN_KINDS.filter((kind) => kind !== 'hiddenText') }),
  sanitize(raw) {
    const given = record(raw);
    const kinds = Array.isArray(given.kinds) ? HIDDEN_KINDS.filter((kind) => (given.kinds as unknown[]).includes(kind)) : null;
    return { kinds: kinds ?? HIDDEN_KINDS.filter((kind) => kind !== 'hiddenText') };
  },
  problem: (o) => (o.kinds.length === 0 ? 'batch.problem.hiddenKinds' : null),
  async run(doc, o, context) {
    const { result, blobs } = await context.client.callStatic<{ refused?: string; size?: number }>(
      'redact.scrub',
      { password: doc.password ?? null, remove: o.kinds },
      [doc.bytes.slice(0)],
    );
    if (result.refused) throw new StepError('batch.error.hiddenProtected');
    if (!blobs[0]) throw new StepError('batch.error.failed');
    return { ...doc, bytes: blobs[0] };
  },
};

/* --------------------------------------------------------------- flatten */

const flatten: StepDefinition<Record<string, never>> = {
  id: 'flatten',
  labelKey: 'batch.step.flatten',
  noteKey: 'batch.step.flattenNote',
  icon: Layers,
  defaults: () => ({}),
  sanitize: () => ({}),
  problem: () => null,
  async run(doc, _o, context) {
    const encrypted = await withDocument(context, doc, async (open) => open.info.encrypted);
    // PDFium would write the file without its protection.
    if (encrypted) throw new StepError('batch.error.flattenProtected');
    // Arabic typed into a field is drawn by Warraq first: PDFium's own
    // appearance of it is empty, and flattening would keep the emptiness.
    const font = await loadEditFont('amiri');
    const fixed = await context.client.callStatic('forms.fix_appearances', { password: null }, [doc.bytes.slice(0), font.slice().buffer]);
    const pdfium = await context.pdfium();
    const { bytes } = await pdfium.flatten(fixed.blobs[0] ?? doc.bytes, undefined);
    return { ...doc, bytes };
  },
};

/* --------------------------------------------------------------- protect */

const protect: StepDefinition<ProtectSpec> = {
  id: 'protect',
  labelKey: 'tool.protect',
  noteKey: 'batch.step.protectNote',
  icon: Lock,
  defaults: () => ({ openPassword: '', ownerPassword: '', allowPrint: true, allowCopy: false, allowChange: false }),
  sanitize(raw) {
    const given = record(raw);
    return {
      openPassword: text(given.openPassword, '', 128),
      ownerPassword: text(given.ownerPassword, '', 128),
      allowPrint: bool(given.allowPrint, true),
      allowCopy: bool(given.allowCopy, false),
      allowChange: bool(given.allowChange, false),
    };
  },
  keep: (o) => ({ ...o, openPassword: '', ownerPassword: '' }),
  problem: (o) =>
    o.openPassword === '' && o.ownerPassword === ''
      ? 'batch.problem.password'
      : o.openPassword !== '' && o.openPassword === o.ownerPassword
        ? 'batch.problem.samePasswords'
        : null,
  async run(doc, o, context) {
    const pdfium = await context.pdfium();
    const bytes = await pdfium.protect(doc.bytes, doc.password, o);
    return { ...doc, bytes, password: o.openPassword || undefined };
  },
};

/* ---------------------------------------------------------------- unlock */

/** The protection off, with the password the file was opened with. */
const unlock: StepDefinition<Record<string, never>> = {
  id: 'unlock',
  labelKey: 'batch.step.unlock',
  noteKey: 'batch.step.unlockNote',
  icon: LockOpen,
  defaults: () => ({}),
  sanitize: () => ({}),
  problem: () => null,
  async run(doc, _o, context) {
    if (!doc.password) {
      const encrypted = await withDocument(context, doc, async (open) => open.info.encrypted);
      if (!encrypted) throw new StepError('batch.error.notProtected');
    }
    const { blobs } = await context.client.callStatic('protect.remove', { password: doc.password ?? null }, [doc.bytes.slice(0)]);
    if (!blobs[0]) throw new StepError('batch.error.failed');
    return { ...doc, bytes: blobs[0], password: undefined };
  },
};

/* ---------------------------------------------------------------- export */

export interface ExportStep {
  format: ExportFormat;
  dpi: number;
}

const exportStep: StepDefinition<ExportStep> = {
  id: 'export',
  labelKey: 'tool.export',
  noteKey: 'batch.step.exportNote',
  icon: FileOutput,
  last: true,
  defaults: () => ({ format: 'docx', dpi: DEFAULT_RESOLUTION }),
  sanitize(raw) {
    const given = record(raw);
    return {
      format: oneOf(given.format, EXPORT_FORMATS.map((f) => f.id), 'docx'),
      dpi: oneOf(given.dpi, RESOLUTIONS, DEFAULT_RESOLUTION),
    };
  },
  problem: () => null,
  run: (doc, o, context) =>
    withDocument(context, doc, async (open) => {
      const result = await exportDocument(open, {
        format: o.format,
        dpi: o.dpi,
        name: context.name,
        pageLabel: (page) => context.t('viewer.page', { page }),
        pagesWord: context.t('export.pagesWord'),
        onProgress: (done, total) => context.onDetail('batch.detail.export', { page: done, of: total }),
      });
      if (!result) throw new StepError('batch.error.noText');
      const extension = result.fileName.slice(result.fileName.lastIndexOf('.') + 1) || o.format;
      return { bytes: buffer(result.bytes), extension };
    }),
};

/* -------------------------------------------------------------- registry */

// Each step's own options type is checked where it is defined; the list
// holds them by their common shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStep = StepDefinition<any>;

/** Every step, in the order they are offered. */
export const STEPS: readonly AnyStep[] = [ocr, compress, rotate, deletePages, extractPages, pageMarks, resize, removeHidden, flatten, protect, unlock, exportStep];

export function findStep(id: string): AnyStep | undefined {
  return STEPS.find((step) => step.id === id);
}

/** A step of a sequence, with its options. */
export interface SequenceStep {
  /** Unique within the sequence, for the list's keys. */
  key: number;
  id: StepId;
  options: unknown;
}

/** Why a sequence cannot run as it is: its first problem, and which step it is in. */
export function sequenceProblem(steps: readonly SequenceStep[]): { index: number; key: TKey } | null {
  if (steps.length === 0) return { index: -1, key: 'batch.problem.noSteps' };
  for (const [index, step] of steps.entries()) {
    const definition = findStep(step.id);
    if (!definition) return { index, key: 'batch.problem.unknown' };
    if (definition.last && index < steps.length - 1) return { index, key: 'batch.problem.exportLast' };
    const problem = definition.problem(step.options);
    if (problem) return { index, key: problem };
  }
  return null;
}
