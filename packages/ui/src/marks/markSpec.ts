/**
 * Page marks: what the panel's controls say, as the core's `marks.add`
 * reads it (`warraq-core/src/tools/marks.rs`). Kept apart from the panel so
 * it can be tested without one.
 *
 * The core draws every kind the same way — shaped, subset, tagged as a
 * pagination artifact — and resolves the page tokens (`{page}`, `{pages}`,
 * `{file}`, `{date}`) page by page. The date is written here, because the
 * calendar is the interface's: Gregorian or Hijri (Umm al-Qura), in Western
 * or Arabic-Indic digits, as the person chose.
 */
import type { EditFontId } from '../edit/editFont';

export type MarkKind = 'watermark' | 'header' | 'footer' | 'pageNumber' | 'bates';
export type MarkSection = 'watermark' | 'band' | 'pageNumber' | 'bates';
export type MarkPosition =
  | 'topLeft'
  | 'top'
  | 'topRight'
  | 'left'
  | 'center'
  | 'right'
  | 'bottomLeft'
  | 'bottom'
  | 'bottomRight'
  | 'tiled';
export type NumberFormat = 'plain' | 'ofTotal' | 'pageOfEnglish' | 'pageOfArabic' | 'roman';
export type Numerals = 'western' | 'arabic';
export type Calendar = 'gregorian' | 'hijri';

/** Everything the panel's controls hold. */
export interface MarkForm {
  section: MarkSection;
  watermarkSource: 'text' | 'picture';
  watermarkText: string;
  watermarkPosition: MarkPosition;
  watermarkSize: number;
  /** The picture's width, as a percentage of the page's. */
  imageWidth: number;
  /** Degrees counter-clockwise. */
  rotation: number;
  /** Percent. */
  opacity: number;
  front: boolean;
  color: string;
  /** Headers, footers, page numbers and Bates numbers: their own colour, black
   * unless chosen; they took the watermark's red (First Five, Faisal). */
  textColor: string;
  band: 'header' | 'footer';
  /** Start, centre, end: "start" is the right-hand side in Arabic. */
  slots: [string, string, string];
  direction: 'auto' | 'rtl' | 'ltr';
  numberFormat: NumberFormat;
  numberPosition: MarkPosition;
  startNumber: number;
  skipFirst: boolean;
  batesPrefix: string;
  batesSuffix: string;
  batesStart: number;
  batesDigits: number;
  batesPosition: MarkPosition;
  numerals: Numerals;
  calendar: Calendar;
  /** Points, for headers, footers, page numbers and Bates numbers. */
  size: number;
  /** Points from the page's edges. */
  margin: number;
  font: EditFontId;
  /** Which pages: empty is every page; otherwise `1-3, 5`. */
  pages: string;
}

export const DEFAULT_FORM: MarkForm = {
  section: 'watermark',
  watermarkSource: 'text',
  watermarkText: '',
  watermarkPosition: 'center',
  watermarkSize: 72,
  imageWidth: 40,
  rotation: 45,
  opacity: 30,
  front: true,
  color: '#c0392b',
  textColor: '#000000',
  band: 'header',
  slots: ['', '', ''],
  direction: 'auto',
  numberFormat: 'plain',
  numberPosition: 'bottom',
  startNumber: 1,
  skipFirst: false,
  batesPrefix: '',
  batesSuffix: '',
  batesStart: 1,
  batesDigits: 6,
  batesPosition: 'bottomRight',
  numerals: 'western',
  calendar: 'gregorian',
  size: 10,
  margin: 36,
  font: 'amiri',
  pages: '',
};

/** The tokens a header or footer can hold, in the order the panel offers them. */
export const TOKENS = ['{page}', '{pages}', '{date}', '{file}'] as const;

const ARABIC_LETTER = /\p{Script=Arabic}/u;

/** Western digits for Arabic-Indic and Persian ones, and a comma for the Arabic one. */
function westernDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/،/g, ',');
}

/**
 * Pages as typed — `1-3, 5, 8-` — as 0-based indices in order; an empty
 * field is every page (`[]`). `null` when it does not read as pages of this
 * file. Arabic-Indic digits and the Arabic comma are read too.
 */
export function parsePages(text: string, count: number): number[] | null {
  const plain = westernDigits(text).trim();
  if (plain === '') return [];
  const out = new Set<number>();
  for (const part of plain.split(',')) {
    const piece = part.trim();
    if (piece === '') continue;
    const match = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(piece);
    if (!match || (!match[1] && !match[3])) return null;
    const from = match[1] ? Number(match[1]) : 1;
    const to = match[2] ? (match[3] ? Number(match[3]) : count) : from;
    if (from < 1 || to > count || from > to) return null;
    for (let page = from; page <= to; page += 1) out.add(page - 1);
  }
  return out.size > 0 ? [...out].sort((a, b) => a - b) : null;
}

/** A date written in the chosen calendar and digits, in Arabic or English. */
export function formatDate(date: Date, calendar: Calendar, numerals: Numerals, arabic: boolean): string {
  const base = arabic ? (calendar === 'hijri' ? 'ar-SA' : 'ar') : 'en-GB';
  const ca = calendar === 'hijri' ? 'islamic-umalqura' : 'gregory';
  const nu = numerals === 'arabic' ? 'arab' : 'latn';
  return new Intl.DateTimeFormat(`${base}-u-ca-${ca}-nu-${nu}`, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

/** A PDF date (`D:YYYYMMDDHHmmSSZ`), in UTC. */
export function pdfDate(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
}

/** `#rrggbb` for a colour input; anything else is black. */
function hex(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : '#000000';
}

/** Which kind of mark the form makes. */
export function kindOf(form: MarkForm): MarkKind {
  if (form.section === 'band') return form.band;
  return form.section;
}

/** Whether the form has something to draw. */
export function hasContent(form: MarkForm, picture: boolean): boolean {
  switch (form.section) {
    case 'watermark':
      return form.watermarkSource === 'picture' ? picture : form.watermarkText.trim().length > 0;
    case 'band':
      return form.slots.some((slot) => slot.trim().length > 0);
    default:
      return true;
  }
}

/** The mark as `marks.add` reads it. */
export function specOf(form: MarkForm, context: { fileName: string; now: Date }): Record<string, unknown> {
  const common = {
    kind: kindOf(form),
    color: hex(form.section === 'watermark' ? form.color : form.textColor),
    numerals: form.numerals,
    marginX: form.margin,
    marginY: form.margin,
    font: form.font,
    modified: pdfDate(context.now),
  };
  switch (form.section) {
    case 'watermark': {
      const picture = form.watermarkSource === 'picture';
      return {
        ...common,
        text: picture ? undefined : form.watermarkText.trim(),
        imageWidth: picture ? Math.min(1, Math.max(0.05, form.imageWidth / 100)) : undefined,
        position: form.watermarkPosition,
        size: form.watermarkSize,
        rotation: form.rotation,
        opacity: Math.min(1, Math.max(0.05, form.opacity / 100)),
        front: form.front,
      };
    }
    case 'band': {
      const arabic = form.numerals === 'arabic' || form.slots.some((slot) => ARABIC_LETTER.test(slot));
      return {
        ...common,
        slots: form.slots,
        direction: form.direction,
        calendar: form.calendar,
        date: formatDate(context.now, form.calendar, form.numerals, arabic),
        fileName: context.fileName,
        size: form.size,
      };
    }
    case 'pageNumber':
      return {
        ...common,
        format: form.numberFormat,
        position: form.numberPosition,
        start: Math.max(0, Math.floor(form.startNumber)),
        skipFirst: form.skipFirst,
        size: form.size,
      };
    case 'bates':
      return {
        ...common,
        prefix: form.batesPrefix,
        suffix: form.batesSuffix,
        start: Math.max(0, Math.floor(form.batesStart)),
        width: Math.min(20, Math.max(1, Math.floor(form.batesDigits))),
        position: form.batesPosition,
        size: form.size,
      };
  }
}

/** The form again, from a mark's saved settings — to change a mark and put it back. */
export function formOf(spec: Record<string, unknown>, fallback: MarkForm = DEFAULT_FORM): MarkForm {
  const text = (key: string, or: string) => (typeof spec[key] === 'string' ? (spec[key] as string) : or);
  const number = (key: string, or: number) => (typeof spec[key] === 'number' ? (spec[key] as number) : or);
  const kind = text('kind', 'watermark') as MarkKind;
  const base: MarkForm = {
    ...fallback,
    color: kind === 'watermark' ? text('color', fallback.color) : fallback.color,
    textColor: kind === 'watermark' ? fallback.textColor : text('color', fallback.textColor),
    numerals: text('numerals', fallback.numerals) === 'arabic' ? 'arabic' : 'western',
    margin: number('marginY', fallback.margin),
    font: text('font', fallback.font) as EditFontId,
    size: number('size', fallback.size),
  };
  switch (kind) {
    case 'watermark':
      return {
        ...base,
        section: 'watermark',
        watermarkSource: spec.imageWidth !== undefined ? 'picture' : 'text',
        watermarkText: text('text', ''),
        watermarkPosition: text('position', 'center') as MarkPosition,
        watermarkSize: number('size', fallback.watermarkSize),
        imageWidth: Math.round(number('imageWidth', 0.4) * 100),
        rotation: number('rotation', 0),
        opacity: Math.round(number('opacity', 1) * 100),
        front: spec.front !== false,
        size: fallback.size,
      };
    case 'header':
    case 'footer': {
      const slots = Array.isArray(spec.slots) ? spec.slots.map((s) => (typeof s === 'string' ? s : '')) : [];
      return {
        ...base,
        section: 'band',
        band: kind,
        slots: [slots[0] ?? '', slots[1] ?? '', slots[2] ?? ''],
        direction: text('direction', 'auto') as MarkForm['direction'],
        calendar: text('calendar', 'gregorian') === 'hijri' ? 'hijri' : 'gregorian',
      };
    }
    case 'pageNumber':
      return {
        ...base,
        section: 'pageNumber',
        numberFormat: text('format', 'plain') as NumberFormat,
        numberPosition: text('position', 'bottom') as MarkPosition,
        startNumber: number('start', 1),
        skipFirst: spec.skipFirst === true,
      };
    case 'bates':
      return {
        ...base,
        section: 'bates',
        batesPrefix: text('prefix', ''),
        batesSuffix: text('suffix', ''),
        batesStart: number('start', 1),
        batesDigits: number('width', 6),
        batesPosition: text('position', 'bottomRight') as MarkPosition,
      };
  }
}

/** `n` in the chosen digits, as the core writes page numbers. */
export function inDigits(n: number, numerals: Numerals): string {
  const s = String(n);
  return numerals === 'arabic' ? s.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d))) : s;
}

/**
 * The numbers a page-number format is shown with — in its label, or in a
 * listed mark's summary — in the digits the mark draws: its first number,
 * and the last of `count` pages (the first skipped or not).
 */
export function pageNumberSample(numerals: Numerals, start = 1, count = 9, skipFirst = false): { page: string; pages: string } {
  const numbered = Math.max(1, count - (skipFirst ? 1 : 0));
  return { page: inDigits(start, numerals), pages: inDigits(start + numbered - 1, numerals) };
}

/** A Bates mark's first number as the core draws it: the start padded to its digits (always Western), between prefix and suffix. */
export function batesSample(spec: Record<string, unknown>): string {
  const number = (key: string, or: number) => (typeof spec[key] === 'number' ? (spec[key] as number) : or);
  const width = Math.min(20, Math.max(1, Math.floor(number('width', 6))));
  const start = Math.max(0, Math.floor(number('start', 1)));
  return `${String(spec.prefix ?? '')}${String(start).padStart(width, '0')}${String(spec.suffix ?? '')}`;
}

/** Pages as a person reads them: `1–3, 5`. */
export function pagesLabel(pages: readonly number[]): string {
  const runs: string[] = [];
  let start = -1;
  let previous = -2;
  const close = () => {
    if (start < 0) return;
    runs.push(previous > start ? `${start + 1}–${previous + 1}` : `${start + 1}`);
  };
  for (const page of pages) {
    if (page !== previous + 1) {
      close();
      start = page;
    }
    previous = page;
  }
  close();
  return runs.join(', ');
}
