/**
 * The reading-order plan the core proposes (`accessibility.plan`) and takes
 * back (`accessibility.tag`), and what the panel does to it: move a block,
 * relabel it, give a figure its text. Pure, so the tests can pin it.
 */

export type Role = 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'P' | 'LI' | 'Table' | 'Figure' | 'Caption' | 'Artifact';

/** What a person can make a block, in the order the menu offers them. */
export const ROLES: readonly Role[] = ['H1', 'H2', 'H3', 'P', 'LI', 'Table', 'Figure', 'Caption', 'Artifact'];

export interface PlanBlock {
  role: Role;
  /** On the page as shown, in points from its top-left corner: [x0, y0, x1, y1]. */
  rect: [number, number, number, number];
  lang?: string | null;
  alt?: string | null;
  list?: number | null;
  cells?: [number, number, number, number][][];
  pagination?: boolean;
  text: string;
}

export interface PlanPage {
  width: number;
  height: number;
  blocks: PlanBlock[];
}

export interface Plan {
  lang: string;
  title?: string | null;
  pages: PlanPage[];
}

export interface PlanAnswer {
  source: 'structure' | 'reading';
  tagged: boolean;
  plan: Plan;
}

export type CheckStatus = 'failed' | 'warning' | 'manual' | 'passed';

export interface Check {
  id: string;
  clause: string;
  wcag: string;
  status: CheckStatus;
  detail: string;
  pages: number[];
  fix: string | null;
}

export interface Figure {
  /** The structure element, "12 0". */
  id: string;
  page: number;
  rect: [number, number, number, number] | null;
  alt: string | null;
}

/** Fixes the core makes by itself, without a plan. */
export const AUTOMATIC_FIXES = ['title', 'displayTitle', 'language', 'tabOrder', 'fieldTooltips', 'bookmarks'] as const;

/** The automatic fixes failed checks ask for, each once. */
export function automaticFixes(checks: readonly Check[]): string[] {
  const wanted = new Set(
    checks.filter((c) => c.status === 'failed' && c.fix).map((c) => c.fix as string),
  );
  return AUTOMATIC_FIXES.filter((fix) => wanted.has(fix));
}

/** Blocks moved: the one at `from` taken out and put at `to`. */
export function moveBlock<T>(blocks: readonly T[], from: number, to: number): T[] {
  const next = [...blocks];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}

/**
 * Each block's place in the reading order, from 1; artifacts are not read,
 * so they have none.
 */
export function readingNumbers(blocks: readonly PlanBlock[]): (number | null)[] {
  let n = 0;
  return blocks.map((b) => (b.role === 'Artifact' ? null : ++n));
}

/** A block relabelled: a table keeps its cells only while it is a table. */
export function withRole(block: PlanBlock, role: Role): PlanBlock {
  const next: PlanBlock = { ...block, role };
  if (role !== 'Table') next.cells = [];
  if (role !== 'LI') next.list = null;
  if (role === 'LI' && block.role !== 'LI') next.list = 0;
  if (role !== 'Artifact') next.pagination = false;
  return next;
}

/** The plan with one page's blocks replaced. */
export function withPage(plan: Plan, index: number, blocks: PlanBlock[]): Plan {
  return { ...plan, pages: plan.pages.map((p, i) => (i === index ? { ...p, blocks } : p)) };
}

/** A short excerpt of a block's text for its row. */
export function excerpt(text: string, length = 70): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > length ? `${clean.slice(0, length)}…` : clean;
}
