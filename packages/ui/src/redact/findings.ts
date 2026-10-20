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
  /** In a page mark ZOOD PDF drew: a header, footer, page or Bates number, a watermark. */
  pageMark: boolean;
  /** Empty when the reader does not know where its glyphs are: it is marked by hand. */
  rects: PageBox[];
}

/** A match whose glyphs the reader placed, so it can be marked for the person. */
export const placed = (match: FoundMatch): boolean => match.rects.length > 0;

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

/**
 * One line of a finding (`warraq_pdf::hidden::Detail`): one of the core's own
 * words, a kind of annotation or a document property's key — each said in the
 * interface's language — or a name from the file, shown as the file has it.
 */
export type HiddenDetail =
  | { word: string; count: number }
  | { subtype: string; count: number }
  | { property: string; value: string; date: string | null }
  | { name: string };

export interface HiddenFinding {
  kind: HiddenKind;
  count: number;
  details: HiddenDetail[];
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

/** The core's own words for what it counted (`hidden.rs`). */
const DETAIL_WORDS = new Set(['invisible', 'white', 'offPage', 'JavaScript', 'OpenAction', 'AA', 'Actions', 'Fields', 'XFA', 'XMP']);

/** Kinds of annotation the interface names (PDF 32000-1 §12.5.6); another is shown by its PDF name. */
export const ANNOTATION_KINDS = [
  'Text',
  'FreeText',
  'Line',
  'Square',
  'Circle',
  'Polygon',
  'PolyLine',
  'Highlight',
  'Underline',
  'Squiggly',
  'StrikeOut',
  'Stamp',
  'Caret',
  'Ink',
  'Popup',
  'Sound',
  'Movie',
  'Screen',
  'PrinterMark',
  'TrapNet',
  'Watermark',
  '3D',
  'Redact',
  'Projection',
  'RichMedia',
] as const;

/** The document properties the interface names; a file's own key is shown as it is. */
export const PROPERTY_KEYS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Trapped'] as const;

const has = (list: readonly string[], item: string): boolean => list.includes(item);

/**
 * A detail line of a finding in the interface's language: the core's words,
 * annotation kinds and property keys translated, a date written the way the
 * language writes one; names and values from the file — an attachment's, a
 * layer's, a property's — as the file gives them, even a layer called "white".
 */
export function detailText(detail: HiddenDetail, t: (key: TKey, params?: TParams) => string, lang: string): string {
  if ('word' in detail) {
    return has([...DETAIL_WORDS], detail.word) ? t(`redact.hidden.detail.${detail.word}` as TKey, { count: detail.count }) : `${detail.word} (${detail.count})`;
  }
  if ('subtype' in detail) {
    return has(ANNOTATION_KINDS, detail.subtype)
      ? t(`redact.hidden.subtype.${detail.subtype}` as TKey, { count: detail.count })
      : `${detail.subtype} (${detail.count})`;
  }
  if ('property' in detail) {
    const key = has(PROPERTY_KEYS, detail.property) ? t(`redact.hidden.property.${detail.property}` as TKey) : detail.property;
    const when = detail.date ? new Date(detail.date) : null;
    const value =
      when && !Number.isNaN(when.getTime())
        ? new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(when)
        : detail.value;
    return t('redact.hidden.property', { key, value });
  }
  return detail.name;
}
