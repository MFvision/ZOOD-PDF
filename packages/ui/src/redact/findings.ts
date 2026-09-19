import type { PageBox, RedactionMark } from '../embed/embedControl';
import type { TKey, TParams } from '../i18n/messages';

/** A ready-made pattern `redact.find` knows (`warraq-core/src/tools/patterns.rs`). */
export const PATTERNS = ['email', 'phone', 'nationalId', 'iban', 'card', 'date'] as const;
export type PatternKind = (typeof PATTERNS)[number];

/** One match of `redact.find`: where it is, what it reads, and its glyph boxes. */
export interface FoundMatch {
  page: number;
  text: string;
  before: string;
  after: string;
  kind: 'text' | 'custom' | PatternKind;
  rects: PageBox[];
}

/** The chosen matches, as marks for the EmbedPDF view. */
export function marksOf(matches: readonly FoundMatch[], chosen: ReadonlySet<number>): RedactionMark[] {
  return matches
    .map((match, index) => ({ match, index }))
    .filter(({ index }) => chosen.has(index))
    .map(({ match }) => ({ page: match.page, text: match.text, rects: match.rects }));
}

/** What `redact.inspect` says a file carries (`warraq_pdf::hidden`). */
export const HIDDEN_KINDS = [
  'metadata',
  'scripts',
  'attachments',
  'comments',
  'forms',
  'hiddenLayers',
  'bookmarks',
  'thumbnails',
  'privateData',
  'links',
  'hiddenText',
] as const;
export type HiddenKind = (typeof HIDDEN_KINDS)[number];

export interface HiddenFinding {
  kind: HiddenKind;
  count: number;
  details: string[];
}

export interface HiddenReport {
  findings: HiddenFinding[];
  revisions: number;
  unreachable: number;
  signed: boolean;
  protected: boolean;
}

/**
 * What to remove unless the person says otherwise: everything found, except
 * hidden text — a scan's searchable OCR layer is invisible text, and taking
 * it away is a choice to make, not a default.
 */
export function defaultChoices(report: HiddenReport): Set<HiddenKind> {
  return new Set(report.findings.map((f) => f.kind).filter((kind) => kind !== 'hiddenText'));
}

/** The core names a few details by a word and a count; those are said in the interface's language. */
const DETAIL_WORDS = new Set(['invisible', 'white', 'offPage', 'JavaScript', 'OpenAction', 'AA', 'Actions', 'Fields', 'XFA', 'XMP']);

/**
 * A detail line of a finding, in the interface's language where it is one of
 * the core's own words ("white (3)"); names from the file — an attachment's,
 * a layer's, a property's value — as the file gives them.
 */
export function detailText(detail: string, t: (key: TKey, params?: TParams) => string): string {
  const match = /^(\w+)(?: \((\d+)\))?$/.exec(detail);
  if (!match || !DETAIL_WORDS.has(match[1] ?? '')) return detail;
  return t(`redact.hidden.detail.${match[1]}` as TKey, { count: Number(match[2] ?? 1) });
}
