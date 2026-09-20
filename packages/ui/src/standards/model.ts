/**
 * What the core's `standards.*` operations answer, and the small pieces of
 * logic the Standards panel shares with its tests.
 */
import { loadEditFont } from '../edit/editFont';
import type { EditFontId } from '../edit/editFont';

export type PdfaLevel = '2b' | '2u' | '3b' | '1b';
export const PDFA_LEVELS: readonly PdfaLevel[] = ['2b', '2u', '3b', '1b'];

export interface Finding {
  clause: string;
  rule: string;
  detail: string;
  /** 0-based, or null for the whole file. */
  page: number | null;
  object: string | null;
}

export interface Findings {
  total: number;
  passed: boolean;
  items: Finding[];
}

export interface Validation {
  findings: Findings;
  rules: { rule: string; clause: string }[];
}

export interface Conversion {
  findings: Findings;
  substituted: { font: string; face: string; missing: string }[];
  unicodeAdded: string[];
  changes: { kind: string; detail: string }[];
  size: number;
}

export type ConversionAnswer = Conversion | { refused: 'signed' } | { refused: 'level'; reasons: string[] };

export interface ProfileInfo {
  profile: boolean;
  class?: string;
  space?: string;
  version?: string;
  description?: string | null;
  /** An output profile a press can print with. */
  press?: boolean;
}

export type Severity = 'error' | 'warning' | 'info';

export interface PreflightItem {
  check: string;
  severity: Severity;
  detail: string;
  pages: number[];
}

export interface PreflightReport {
  items: PreflightItem[];
  sizes: { width: number; height: number; pages: number[] }[];
  fonts: number;
  images: number;
  truncated: boolean;
}

/** `invoice.pdf` → `invoice-PDFA-2b.pdf`. */
export function standardFileName(name: string, suffix: string): string {
  const stem = name.replace(/\.pdf$/i, '') || 'document';
  return `${stem}-${suffix}.pdf`;
}

/**
 * The bundled faces the core may embed for fonts a file does not carry, in
 * the order it prefers them when they cover the same characters: Inter and
 * Cairo without serifs, Amiri with.
 */
const FACES: readonly { id: EditFontId; name: string; serif: boolean }[] = [
  { id: 'inter', name: 'Inter', serif: false },
  { id: 'cairo', name: 'Cairo', serif: false },
  { id: 'amiri', name: 'Amiri', serif: true },
];

export async function bundledFaces(): Promise<{ faces: { name: string; serif: boolean }[]; blobs: ArrayBuffer[] }> {
  const blobs = await Promise.all(FACES.map(async (face) => (await loadEditFont(face.id)).slice().buffer));
  return { faces: FACES.map(({ name, serif }) => ({ name, serif })), blobs };
}

/** Pages (0-based) as a person reads them: 1, 3–5, 9. */
export function pageList(pages: readonly number[]): number[][] {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const page of sorted) {
    const last = runs[runs.length - 1];
    if (last && page === last[last.length - 1]! + 1) last.push(page);
    else runs.push([page]);
  }
  return runs;
}

/** Findings grouped by rule, in the order they came, each with its pages. */
export function groupFindings(items: readonly Finding[]): { rule: string; clause: string; details: string[]; pages: number[] }[] {
  const groups = new Map<string, { rule: string; clause: string; details: string[]; pages: number[] }>();
  for (const item of items) {
    let group = groups.get(item.rule);
    if (!group) {
      group = { rule: item.rule, clause: item.clause, details: [], pages: [] };
      groups.set(item.rule, group);
    }
    if (item.detail && !group.details.includes(item.detail)) group.details.push(item.detail);
    if (item.page !== null && !group.pages.includes(item.page)) group.pages.push(item.page);
  }
  return [...groups.values()];
}

/** Millimetres of bleed as points, the unit the core takes. */
export function mmToPoints(mm: number): number {
  return Math.round((mm * 72 * 100) / 25.4) / 100;
}
