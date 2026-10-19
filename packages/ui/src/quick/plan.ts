import { Combine, FileImage, FileOutput, FileText, LayoutGrid, Lock, RotateCw, ScanText, Scissors, Shrink } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { CREATE_EXTENSIONS } from '../create/createPdf';
import type { TKey } from '../i18n/messages';
import { findStep } from '../batch/steps';
import type { StepId } from '../batch/steps';

/**
 * The quick tools: what the small window the file manager opens
 * (`src-tauri/src/quick.rs`) offers for the files it was given, and which
 * of the batch's steps each one is. The ids are the ones the right-click
 * menu names (`src-tauri/src/shell_menu.rs`, `quick::TOOLS`).
 */

export type QuickToolId = 'compress' | 'word' | 'images' | 'ocr' | 'combine' | 'protect' | 'rotate' | 'extract' | 'topdf';

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
}

/** In the order the window shows them (the ring's order too). */
export const QUICK_TOOLS: readonly QuickTool[] = [
  { id: 'compress', labelKey: 'quick.tool.compress', noteKey: 'quick.note.compress', icon: Shrink, step: 'compress', takes: 'pdf' },
  { id: 'word', labelKey: 'quick.tool.word', noteKey: 'quick.note.word', icon: FileText, step: 'export', options: { format: 'docx' }, takes: 'pdf' },
  { id: 'images', labelKey: 'quick.tool.images', noteKey: 'quick.note.images', icon: FileImage, step: 'export', options: { format: 'png' }, takes: 'pdf' },
  { id: 'ocr', labelKey: 'quick.tool.ocr', noteKey: 'quick.note.ocr', icon: ScanText, step: 'ocr', takes: 'pdf' },
  { id: 'combine', labelKey: 'quick.tool.combine', noteKey: 'quick.note.combine', icon: Combine, takes: 'pdf', min: 2 },
  { id: 'rotate', labelKey: 'quick.tool.rotate', noteKey: 'quick.note.rotate', icon: RotateCw, step: 'rotate', takes: 'pdf' },
  { id: 'extract', labelKey: 'quick.tool.extract', noteKey: 'quick.note.extract', icon: Scissors, step: 'extractPages', takes: 'pdf' },
  { id: 'protect', labelKey: 'quick.tool.protect', noteKey: 'quick.note.protect', icon: Lock, step: 'protect', takes: 'pdf' },
  { id: 'topdf', labelKey: 'quick.tool.topdf', noteKey: 'quick.note.topdf', icon: FileOutput, takes: 'other' },
];

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
  if (!tool.step) return {};
  const step = findStep(tool.step);
  const defaults = (step?.defaults() ?? {}) as Record<string, unknown>;
  const options = { ...defaults, ...tool.options };
  // Extract starts on every page's worth of choice: the first page alone
  // is the batch's cautious default, not what a person extracting means.
  if (tool.id === 'extract') return { ...options, pages: { which: 'list', list: '1-' } };
  return options;
}

/** The name of a file made of several: "first-combined.pdf". */
export function combinedName(first: string, suffix: string): string {
  const base = first.split(/[\\/]/).pop() ?? first;
  const dot = base.lastIndexOf('.');
  return `${dot > 0 ? base.slice(0, dot) : base || 'document'}${suffix}.pdf`;
}
