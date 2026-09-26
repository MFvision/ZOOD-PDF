/**
 * Accessibility tool: typed calls to warraq-core's `a11y.*` methods and view helpers.
 *
 * Reads (structure, checker) run on a private engine copy of the open document; changes go through
 * the app's `coreEdit` (one incremental update each, shared undo history, the viewer reloads).
 * The checker is a Matterhorn-inspired subset of PDF/UA — not a certified PDF/UA validator.
 */
import type { EngineClient } from './engine';

export interface A11yElement {
  /** Object number; null for a direct (not editable) element. */
  id: number | null;
  type: string;
  role: string;
  depth: number;
  parent: number | null;
  page: number | null;
  text: string;
  lang: string | null;
  effectiveLang: string | null;
  alt: string | null;
  actualText: string | null;
  /** Top-left page box (points). */
  bbox: [number, number, number, number] | null;
  mcids: number;
  children: number;
  annotations: number;
}

export interface A11yListing {
  tagged: boolean;
  marked: boolean;
  lang: string | null;
  title: string | null;
  displayDocTitle: boolean;
  pageCount: number;
  elements: A11yElement[];
  truncated: boolean;
  textComplete: boolean;
}

export type FixKind = 'auto' | 'needsTitle' | 'retag' | 'manual';

export interface A11yFinding {
  rule: string;
  variant: string;
  key: string;
  clause: string;
  matterhorn: string | null;
  object: string | null;
  page: number | null;
  element: number | null;
  params: Record<string, string>;
  message: string;
  severity: 'error' | 'warning';
  fixable: boolean;
  fix: FixKind;
}

export interface A11yReport {
  findings: A11yFinding[];
  counts: Record<string, number>;
  errorCount: number;
  warningCount: number;
  fixableCount: number;
  rulesChecked: number;
  passed: boolean;
  incomplete: boolean;
  certified: boolean;
}

/** The checker's rules (same order as the engine's catalogue). */
export const RULE_IDS = [
  'struct-tree',
  'marked',
  'suspects',
  'untagged-content',
  'orphan-mcid',
  'parent-tree',
  'role-map',
  'title',
  'display-doc-title',
  'doc-lang',
  'lang-mismatch',
  'ligature-actualtext',
  'figure-alt',
  'heading-skip',
  'table-th',
  'list-structure',
  'annot-tagged',
  'tabs-order',
  'field-tu',
  'font-embedded',
  'font-unicode',
  'direction-trap',
] as const;

/** Every message key the engine can return (`a11y.finding.<rule>.<variant>`). */
export const FINDING_KEYS = [
  'a11y.finding.struct-tree.missing',
  'a11y.finding.marked.missing',
  'a11y.finding.suspects.true',
  'a11y.finding.untagged-content.page',
  'a11y.finding.orphan-mcid.page',
  'a11y.finding.parent-tree.missing',
  'a11y.finding.role-map.unmapped',
  'a11y.finding.title.missing',
  'a11y.finding.display-doc-title.missing',
  'a11y.finding.doc-lang.missing',
  'a11y.finding.lang-mismatch.text',
  'a11y.finding.ligature-actualtext.page',
  'a11y.finding.figure-alt.missing',
  'a11y.finding.heading-skip.skipped',
  'a11y.finding.table-th.missing',
  'a11y.finding.list-structure.list',
  'a11y.finding.list-structure.item',
  'a11y.finding.annot-tagged.missing',
  'a11y.finding.tabs-order.missing',
  'a11y.finding.field-tu.missing',
  'a11y.finding.font-embedded.missing',
  'a11y.finding.font-unicode.missing',
  'a11y.finding.direction-trap.r2l',
] as const;

/** Types the panel can assign (the engine's list). */
export const ASSIGNABLE_TYPES = [
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'L',
  'LI',
  'Lbl',
  'LBody',
  'Table',
  'TR',
  'TH',
  'TD',
  'Figure',
  'Formula',
  'Caption',
  'Span',
  'Quote',
  'BlockQuote',
  'Note',
  'Code',
  'Div',
  'Sect',
  'Art',
  'Part',
  'TOC',
  'TOCI',
  'Link',
  'Artifact',
] as const;

/** Languages offered in the panel (BCP 47). */
export const LANGUAGES = ['ar', 'en', 'fa', 'ur', 'fr'] as const;

/** Siblings of element `id` (same parent) in reading order. */
export function siblingsOf(elements: A11yElement[], id: number): A11yElement[] {
  const me = elements.find((e) => e.id === id);
  if (!me) return [];
  return elements.filter((e) => e.parent === me.parent && e.depth === me.depth);
}

/** New index among siblings after moving `id` by `delta` (null when it cannot move). */
export function moveIndex(elements: A11yElement[], id: number, delta: -1 | 1): number | null {
  const sib = siblingsOf(elements, id);
  const at = sib.findIndex((e) => e.id === id);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= sib.length) return null;
  return to;
}

/** Index for dropping `dragId` onto sibling `dropId` (null when they are not siblings). */
export function dropIndex(elements: A11yElement[], dragId: number, dropId: number): number | null {
  if (dragId === dropId) return null;
  const sib = siblingsOf(elements, dragId);
  const to = sib.findIndex((e) => e.id === dropId);
  return to < 0 ? null : to;
}

export function figuresOf(elements: A11yElement[]): A11yElement[] {
  return elements.filter((e) => e.role === 'Figure' && e.id !== null);
}

export interface OverlayBox {
  id: number;
  /** Reading-order number among the top-level elements. */
  n: number;
  role: string;
  bbox: [number, number, number, number];
}

/** Top-level elements (children of the Document) with boxes on page `page`, numbered in reading order. */
export function overlayBoxes(elements: A11yElement[], page: number): OverlayBox[] {
  const docIds = new Set(elements.filter((e) => e.role === 'Document').map((e) => e.id));
  const top = elements.filter((e) => (e.parent === null ? e.role !== 'Document' : docIds.has(e.parent)) && e.id !== null);
  const out: OverlayBox[] = [];
  top.forEach((e, i) => {
    if (e.page === page && e.bbox) out.push({ id: e.id!, n: i + 1, role: e.role, bbox: e.bbox });
  });
  return out;
}

export interface FindingGroup {
  rule: string;
  items: A11yFinding[];
}

export function groupFindings(findings: A11yFinding[]): FindingGroup[] {
  const out: FindingGroup[] = [];
  for (const f of findings) {
    let g = out.find((x) => x.rule === f.rule);
    if (!g) {
      g = { rule: f.rule, items: [] };
      out.push(g);
    }
    g.items.push(f);
  }
  return out;
}

/** Engine params are strings; numeric ones become numbers (plural forms, locale digits). */
export function findingArgs(params: Record<string, string>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) out[k] = /^\d+$/.test(v) ? Number(v) : v;
  return out;
}

/** A readable title from a file name. */
export function suggestTitle(name: string): string {
  return name
    .replace(/\.pdf$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Read-only engine copy of one open document for the Accessibility panel. */
export class A11yDoc {
  private synced: Uint8Array | null = null;
  private readonly engineId: string;
  constructor(
    private readonly engine: EngineClient,
    docId: string,
  ) {
    this.engineId = `${docId}:a11y`;
  }

  async sync(bytes: Uint8Array, password?: string): Promise<void> {
    if (this.synced === bytes) return;
    await this.engine.open(this.engineId, bytes, password);
    this.synced = bytes;
  }

  async structure(): Promise<A11yListing> {
    return (await this.engine.call<A11yListing>(this.engineId, 'a11y.structure')).json;
  }

  async check(): Promise<A11yReport> {
    return (await this.engine.call<A11yReport>(this.engineId, 'a11y.check')).json;
  }

  async pages(): Promise<{ width: number; height: number; rotation: number }[]> {
    const r = await this.engine.call<{ pages: { width: number; height: number; rotation: number }[] }>(this.engineId, 'doc.info');
    return r.json.pages;
  }

  async close(): Promise<void> {
    this.synced = null;
    await this.engine.close(this.engineId).catch(() => {});
  }
}
