import { findQuickTool, isConvertibleName, isPdfName } from '../quick/plan';
import type { QuickToolId } from '../quick/plan';

/**
 * What ZOOD's shelf (`DropZone.tsx`, `src-tauri/src/shelf.rs`) offers for
 * the files it acts on: the picked ones, or all of them when none is
 * picked. "Do it now" holds the few that fit these files best, at once;
 * "Convert to" always lists every format, with the ones none of these
 * files can become greyed, so the row never jumps about.
 */

/** A "Do it now" button: a quick tool, or one of the shelf's own. */
export type ShelfAction =
  | { kind: 'tool'; tool: QuickToolId; onePdf?: boolean }
  | { kind: 'organize' }
  | { kind: 'open' }
  | { kind: 'phone' };

/** "Convert to", in its order: the format's short name, and the tool that makes it. */
export const CONVERT_ROW: readonly { tool: QuickToolId; label: string }[] = [
  { tool: 'topdf', label: 'PDF' },
  { tool: 'word', label: 'Word' },
  { tool: 'excel', label: 'Excel' },
  { tool: 'powerpoint', label: 'PowerPoint' },
  { tool: 'text', label: 'TXT' },
  { tool: 'jpg', label: 'JPG' },
  { tool: 'images', label: 'PNG' },
  { tool: 'webp', label: 'WebP' },
];

/** The paths a button acts on: the picked files, or every file when none is picked. */
export function targetsOf<T extends { path: string }>(items: readonly T[], picked: ReadonlySet<string>): T[] {
  const chosen = items.filter((item) => picked.has(item.path));
  return chosen.length > 0 ? chosen : [...items];
}

/** Of these files, the ones a tool takes (its PDFs, or the files it makes PDFs of), by place. */
export function fittingFor(tool: QuickToolId, names: readonly string[]): number[] {
  const takes = findQuickTool(tool)?.takes;
  const fits = names.map((name, at) => ((takes === 'pdf' ? isPdfName(name) : isConvertibleName(name)) ? at : -1)).filter((at) => at >= 0);
  return fits.length >= (findQuickTool(tool)?.min ?? 1) ? fits : [];
}

/**
 * The "Do it now" buttons for these files: Organize first (ZOOD sorting them
 * is what the shelf is for), then the tools, best first. A mix of kinds still
 * gets its tools: each runs on the files it takes (Merge on the PDFs, Make
 * one PDF on the pictures and documents).
 */
export function actionsFor(names: readonly string[], phone: boolean): ShelfAction[] {
  if (names.length === 0) return [];
  const pdfs = names.filter(isPdfName).length;
  const others = names.filter(isConvertibleName).length;
  const actions: ShelfAction[] = [{ kind: 'organize' }];
  if (pdfs >= 2) actions.push({ kind: 'tool', tool: 'combine' });
  if (others >= 2) actions.push({ kind: 'tool', tool: 'topdf', onePdf: true });
  if (pdfs >= 1) actions.push({ kind: 'tool', tool: 'compress' }, { kind: 'tool', tool: 'ocr' }, { kind: 'tool', tool: 'split' }, { kind: 'tool', tool: 'protect' });
  if (names.length === 1 && (pdfs || others)) actions.push({ kind: 'open' });
  if (phone) actions.push({ kind: 'phone' });
  return actions;
}

/** The formats of "Convert to" that some of these files can be converted to. */
export function convertibleTo(names: readonly string[]): Set<QuickToolId> {
  return new Set(CONVERT_ROW.map((entry) => entry.tool).filter((tool) => fittingFor(tool, names).length > 0));
}

/** A file's type as its badge shows it: "PDF", "DOCX"; empty for none. */
export function typeOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toUpperCase().slice(0, 5) : '';
}

/** Pictures the shelf shows as themselves (small ones), not as an icon. */
export const THUMB_TYPES = new Set(['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP', 'BMP']);
export const THUMB_MAX_BYTES = 8 << 20;
