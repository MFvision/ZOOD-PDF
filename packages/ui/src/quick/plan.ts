import { getSettings } from '../state/settings';
import {
  Combine,
  Droplets,
  FileImage,
  FileOutput,
  FileSpreadsheet,
  FileText,
  FileType,
  Hash,
  ImageDown,
  ImagePlay,
  LayoutGrid,
  Lock,
  LockOpen,
  Presentation,
  Repeat2,
  Ratio,
  RotateCw,
  ScanText,
  Scissors,
  Shrink,
  Signature,
  SquareSplitVertical,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { CREATE_EXTENSIONS } from '../create/createPdf';
import type { TKey } from '../i18n/messages';
import { findStep } from '../batch/steps';
import { choosePages, parseList } from '../batch/pages';
import { DEFAULT_FORM } from '../marks/markSpec';
import type { StepId } from '../batch/steps';

/**
 * The quick tools: what the small window the file manager opens
 * (`src-tauri/src/quick.rs`) offers for the files it was given, and which
 * of the batch's steps each one is. The ids are the ones the right-click
 * menu names (`src-tauri/src/shell_menu.rs`, `quick::TOOLS`).
 */

export type QuickToolId =
  | 'compress'
  | 'word'
  | 'excel'
  | 'powerpoint'
  | 'text'
  | 'images'
  | 'jpg'
  | 'webp'
  | 'ocr'
  | 'combine'
  | 'protect'
  | 'unlock'
  | 'rotate'
  | 'extract'
  | 'split'
  | 'resize'
  | 'numbers'
  | 'watermark'
  | 'sign'
  | 'topdf';

/**
 * How a tool starts. `instant`: at once, nothing asked (on the ring, its
 * progress goes round the ring). `ask`: it needs something only the person
 * can say (a password, which pages, a paper size, the mark's text), so its
 * window opens, with the pages to see while choosing. `editor`: the file
 * opens in the editor at that tool.
 */
export type QuickMode = 'instant' | 'ask' | 'editor';

export interface QuickTool {
  id: QuickToolId;
  labelKey: TKey;
  noteKey: TKey;
  icon: LucideIcon;
  /** The batch step it runs on each file; none for those that make one file of many. */
  step?: StepId;
  /** The step's options where they differ from the step's own defaults. */
  options?: Record<string, unknown>;
  /** What it takes: PDFs, or files to make PDFs of. */
  takes: 'pdf' | 'other';
  /** At least this many files. */
  min?: number;
  mode: QuickMode;
  /** On the ring, its short name is the file type it makes ("DOCX", "WEBP"), as in a group's half circle. */
  makes?: string;
}

/** In the order the window shows them (the ring's order too). */
export const QUICK_TOOLS: readonly QuickTool[] = [
  { id: 'compress', labelKey: 'quick.tool.compress', noteKey: 'quick.note.compress', icon: Shrink, step: 'compress', takes: 'pdf', mode: 'instant' },
  { id: 'word', labelKey: 'quick.tool.word', noteKey: 'quick.note.word', icon: FileText, step: 'export', options: { format: 'docx' }, takes: 'pdf', mode: 'instant', makes: 'DOCX' },
  { id: 'excel', labelKey: 'quick.tool.excel', noteKey: 'quick.note.excel', icon: FileSpreadsheet, step: 'export', options: { format: 'xlsx' }, takes: 'pdf', mode: 'instant', makes: 'XLSX' },
  { id: 'powerpoint', labelKey: 'quick.tool.powerpoint', noteKey: 'quick.note.powerpoint', icon: Presentation, step: 'export', options: { format: 'pptx' }, takes: 'pdf', mode: 'instant', makes: 'PPTX' },
  { id: 'text', labelKey: 'quick.tool.text', noteKey: 'quick.note.text', icon: FileType, step: 'export', options: { format: 'txt' }, takes: 'pdf', mode: 'instant', makes: 'TXT' },
  { id: 'images', labelKey: 'quick.tool.images', noteKey: 'quick.note.images', icon: FileImage, step: 'export', options: { format: 'png' }, takes: 'pdf', mode: 'instant', makes: 'PNG' },
  { id: 'jpg', labelKey: 'quick.tool.jpg', noteKey: 'quick.note.jpg', icon: ImageDown, step: 'export', options: { format: 'jpg' }, takes: 'pdf', mode: 'instant', makes: 'JPG' },
  { id: 'webp', labelKey: 'quick.tool.webp', noteKey: 'quick.note.webp', icon: ImagePlay, step: 'export', options: { format: 'webp' }, takes: 'pdf', mode: 'instant', makes: 'WEBP' },
  { id: 'ocr', labelKey: 'quick.tool.ocr', noteKey: 'quick.note.ocr', icon: ScanText, step: 'ocr', takes: 'pdf', mode: 'instant' },
  { id: 'combine', labelKey: 'quick.tool.combine', noteKey: 'quick.note.combine', icon: Combine, takes: 'pdf', min: 2, mode: 'instant' },
  { id: 'rotate', labelKey: 'quick.tool.rotate', noteKey: 'quick.note.rotate', icon: RotateCw, step: 'rotate', takes: 'pdf', mode: 'instant' },
  { id: 'split', labelKey: 'quick.tool.split', noteKey: 'quick.note.split', icon: SquareSplitVertical, takes: 'pdf', mode: 'ask' },
  { id: 'extract', labelKey: 'quick.tool.extract', noteKey: 'quick.note.extract', icon: Scissors, step: 'extractPages', takes: 'pdf', mode: 'ask' },
  { id: 'resize', labelKey: 'quick.tool.resize', noteKey: 'quick.note.resize', icon: Ratio, step: 'resize', takes: 'pdf', mode: 'ask' },
  { id: 'numbers', labelKey: 'quick.tool.numbers', noteKey: 'quick.note.numbers', icon: Hash, step: 'pageMarks', takes: 'pdf', mode: 'instant' },
  { id: 'watermark', labelKey: 'quick.tool.watermark', noteKey: 'quick.note.watermark', icon: Droplets, step: 'pageMarks', takes: 'pdf', mode: 'ask' },
  { id: 'sign', labelKey: 'quick.tool.sign', noteKey: 'quick.note.sign', icon: Signature, takes: 'pdf', mode: 'editor' },
  { id: 'protect', labelKey: 'quick.tool.protect', noteKey: 'quick.note.protect', icon: Lock, step: 'protect', takes: 'pdf', mode: 'ask' },
  { id: 'unlock', labelKey: 'quick.tool.unlock', noteKey: 'quick.note.unlock', icon: LockOpen, step: 'unlock', takes: 'pdf', mode: 'ask' },
  { id: 'topdf', labelKey: 'quick.tool.topdf', noteKey: 'quick.note.topdf', icon: FileOutput, takes: 'other', mode: 'instant' },
];

/**
 * A group on the ring: one slot that, when the pointer reaches it, opens a
 * half circle of its tools behind it (Convert: DOCX, XLSX, … WEBP), so
 * every format is one move away without crowding the ring.
 */
export interface QuickGroup {
  id: 'convert';
  labelKey: TKey;
  icon: LucideIcon;
  members: readonly QuickToolId[];
}

export const QUICK_GROUPS: readonly QuickGroup[] = [
  { id: 'convert', labelKey: 'quick.group.convert', icon: Repeat2, members: ['word', 'excel', 'powerpoint', 'text', 'images', 'jpg', 'webp'] },
];

export function findQuickGroup(id: string | null | undefined): QuickGroup | undefined {
  return QUICK_GROUPS.find((group) => group.id === id);
}

/**
 * The ring's own choice, clockwise from the top, when the person has not
 * made theirs: Compress on top and Rotate at the bottom for one PDF (the
 * Windows ring check drops on both).
 */
export const RING_DEFAULT: readonly string[] = ['compress', 'convert', 'ocr', 'combine', 'split', 'rotate', 'sign', 'protect', 'topdf'];

/** A slot of the ring: a tool, or a group with the tools of it that fit. */
export interface RingItem {
  id: string;
  icon: LucideIcon;
  /** A group's tools, in its half circle. */
  members?: readonly QuickTool[];
}

/** The icon of "every tool" in the ring and the window's chooser. */
export const ALL_TOOLS_ICON = LayoutGrid;

export function findQuickTool(id: string | null | undefined): QuickTool | undefined {
  return QUICK_TOOLS.find((tool) => tool.id === id);
}

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

export const isPdfName = (name: string) => extensionOf(name) === 'pdf';

/** A file "Convert to PDF" takes: a picture, an Office, text or web file. */
export const isConvertibleName = (name: string) => CREATE_EXTENSIONS.includes(extensionOf(name));

/**
 * The tools that fit these files: the PDF tools when they are all PDFs
 * (Combine from two), "Convert to PDF" when they are all pictures or
 * documents, and none for a mix (the window says so).
 */
export function toolsFor(names: readonly string[]): QuickTool[] {
  if (names.length === 0) return [];
  const pdfs = names.filter(isPdfName).length;
  const others = names.filter(isConvertibleName).length;
  return QUICK_TOOLS.filter((tool) => {
    if (tool.takes === 'pdf') return pdfs === names.length && names.length >= (tool.min ?? 1);
    return others === names.length;
  });
}

/** The step's options for a tool: the step's defaults with the tool's own on top. */
export function startingOptions(tool: QuickTool): unknown {
  // Split has no batch step of its own: its choice is here, not after it.
  if (tool.id === 'split') return { ...DEFAULT_SPLIT };
  if (!tool.step) return {};
  const step = findStep(tool.step);
  const defaults = (step?.defaults() ?? {}) as Record<string, unknown>;
  const options = { ...defaults, ...tool.options };
  // Extract starts on every page's worth of choice: the first page alone
  // is the batch's cautious default, not what a person extracting means.
  if (tool.id === 'extract') return { ...options, pages: { which: 'list', list: '1-' } };
  if (tool.id === 'numbers') return { ...options, form: { ...DEFAULT_FORM, section: 'pageNumber', numberPosition: 'bottom' } };
  if (tool.id === 'watermark') return { ...options, form: { ...DEFAULT_FORM, section: 'watermark', watermarkText: '' } };
  return options;
}

/** The ring's slots for these files: the person's choice (Settings › Quick tools) or the ring's own, of those that fit; "All tools" is added by the ring. */
export function ringToolsFor(names: readonly string[], chosen: readonly string[] = getSettings().ringTools): RingItem[] {
  const fitting = toolsFor(names);
  const ids = chosen.length > 0 ? chosen : RING_DEFAULT;
  const items: RingItem[] = ids.flatMap((id): RingItem[] => {
    const group = findQuickGroup(id);
    if (group) {
      const members = group.members.flatMap((member) => fitting.filter((tool) => tool.id === member));
      // A group of one is just that tool.
      if (members.length === 1) return [{ id: members[0]!.id, icon: members[0]!.icon }];
      return members.length > 1 ? [{ id: group.id, icon: group.icon, members }] : [];
    }
    return fitting.filter((tool) => tool.id === id).map((tool) => ({ id: tool.id, icon: tool.icon }));
  });
  return items.slice(0, 8);
}

/* ----------------------------------------------------------------- split */

/** Split: a file every so many pages, or one file per part of a list ("1-3, 4-9"). */
export interface SplitOptions {
  how: 'every' | 'ranges';
  every: number;
  ranges: string;
}

export const DEFAULT_SPLIT: SplitOptions = { how: 'every', every: 1, ranges: '' };

/** The most files one split makes. */
export const MAX_SPLIT_PARTS = 500;

/** The pages of each new file, zero-based; null when the list does not read or nothing is left. */
export function splitGroups(options: SplitOptions, count: number): number[][] | null {
  if (count <= 0) return null;
  const groups: number[][] = [];
  if (options.how === 'every') {
    const every = Math.max(1, Math.floor(options.every) || 1);
    for (let from = 0; from < count && groups.length < MAX_SPLIT_PARTS; from += every) {
      groups.push(Array.from({ length: Math.min(every, count - from) }, (_, k) => from + k));
    }
  } else {
    const parts = options.ranges
      .split(/[,،]/)
      .map((part) => part.trim())
      .filter(Boolean);
    for (const part of parts) {
      const pages = choosePages({ which: 'list', list: part }, count);
      if (pages === null) return null;
      if (pages.length > 0) groups.push(pages);
      if (groups.length >= MAX_SPLIT_PARTS) break;
    }
  }
  return groups.length > 0 ? groups : null;
}

/** Why a split's options cannot run, or null. */
export function splitProblem(options: SplitOptions): TKey | null {
  if (options.how === 'every') return Number.isFinite(options.every) && options.every >= 1 ? null : 'quick.problem.split';
  const parts = options.ranges.split(/[,،]/).filter((part) => part.trim());
  return parts.length > 0 && parts.every((part) => parseList(part) !== null) ? null : 'quick.problem.split';
}

/** The name of a split's part: "report-part2.pdf". */
export function partName(first: string, suffix: string, part: number): string {
  return combinedName(first, `${suffix}${part}`);
}

/** The name of a file made of several: "first-combined.pdf". */
export function combinedName(first: string, suffix: string): string {
  const base = first.split(/[\\/]/).pop() ?? first;
  const dot = base.lastIndexOf('.');
  return `${dot > 0 ? base.slice(0, dot) : base || 'document'}${suffix}.pdf`;
}
