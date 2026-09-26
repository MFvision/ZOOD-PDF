/**
 * Page marks (warraq-marks, `marks.*`): the panel's form ↔ the engine's mark model, page
 * selection (all / odd / even / custom ranges with Arabic-Indic digits via services/ranges.ts),
 * engine calls for preview, apply and listing.
 */
import type { EngineClient } from './engine';
import { normalizeDigits, parseRanges, type RangeResult } from './ranges';
import type { CoreCall } from './coreOps';
import type { Locale } from '../i18n';

export type MarkKind = 'watermark' | 'header' | 'footer' | 'pageNumber' | 'bates';
export type Tab = 'watermark' | 'header' | 'numbers' | 'bates';
export type FontId = 'amiri' | 'cairo' | 'inter';
export type VerticalPos = 'top' | 'middle' | 'bottom';
export type HorizontalPos = 'start' | 'center' | 'end';
export type RangeMode = 'all' | 'odd' | 'even' | 'custom';
export type DigitStyle = 'latin' | 'arabic';

/** The engine's mark model (warraq-marks `MarkSpec`). */
export interface MarkSpec {
  kind: MarkKind;
  pages?: number[] | null;
  text?: string | null;
  slots?: { start: string; center: string; end: string } | null;
  picture?: boolean;
  font?: FontId;
  size?: number | null;
  color?: [number, number, number] | null;
  opacity?: number | null;
  rotation?: number;
  diagonal?: boolean;
  vertical?: VerticalPos | null;
  horizontal?: HorizontalPos | null;
  offsetX?: number;
  offsetY?: number;
  margin?: number | null;
  layer?: 'behind' | 'front' | null;
  scale?: number | null;
  rtl?: boolean;
  digits?: DigitStyle;
  lang?: 'ar' | 'en';
  bates?: { prefix: string; suffix: string; start: number; digits: number } | null;
  fileName?: string;
  now?: { year: number; month: number; day: number; hour: number; minute: number } | null;
  ui?: unknown;
}

export interface ListedMark {
  id: string;
  spec: MarkSpec | null;
  pages: number[];
}

export interface ForeignMark {
  id: string;
  kind: 'watermark' | 'header' | 'footer' | 'pagination';
  pages: number[];
  regions: number;
  removable: boolean;
  acrobat: boolean;
}

/** Everything the panel edits (one object for all four tabs, so switching tabs keeps input). */
export interface MarkForm {
  tab: Tab;
  // Watermark
  watermarkType: 'text' | 'picture';
  text: string;
  hasPicture: boolean;
  diagonal: boolean;
  rotation: number;
  scale: number; // % of the page width
  layer: 'behind' | 'front';
  // Header & footer
  band: 'header' | 'footer';
  start: string;
  center: string;
  end: string;
  // Page numbers
  numberText: string;
  // Bates
  batesPrefix: string;
  batesSuffix: string;
  batesStart: string;
  batesDigits: string;
  // Shared
  font: FontId;
  size: number;
  color: string; // #rrggbb
  opacity: number; // %
  vertical: VerticalPos;
  horizontal: HorizontalPos;
  digits: DigitStyle;
  rtl: boolean;
  rangeMode: RangeMode;
  range: string;
}

export const DEFAULT_FORM: MarkForm = {
  tab: 'watermark',
  watermarkType: 'text',
  text: '',
  hasPicture: false,
  diagonal: true,
  rotation: 0,
  scale: 50,
  layer: 'front',
  band: 'footer',
  start: '',
  center: '',
  end: '',
  numberText: '{page}',
  batesPrefix: '',
  batesSuffix: '',
  batesStart: '1',
  batesDigits: '6',
  font: 'amiri',
  size: 60,
  color: '#bf1a1a',
  opacity: 30,
  vertical: 'middle',
  horizontal: 'center',
  digits: 'latin',
  rtl: false,
  rangeMode: 'all',
  range: '',
};

/** Sensible defaults when switching to a tab (size, colour, position differ per kind). */
export function tabDefaults(tab: Tab): Partial<MarkForm> {
  switch (tab) {
    case 'watermark':
      return { size: 60, color: '#bf1a1a', opacity: 30, vertical: 'middle', horizontal: 'center' };
    case 'header':
      return { size: 10, color: '#000000', opacity: 100 };
    case 'numbers':
      return { size: 10, color: '#000000', opacity: 100, vertical: 'bottom', horizontal: 'center' };
    case 'bates':
      return { size: 10, color: '#000000', opacity: 100, vertical: 'bottom', horizontal: 'end' };
  }
}

export const TOKENS = ['{page}', '{pages}', '{date}', '{hijri}', '{time}', '{file}'] as const;

export function numberPresets(locale: Locale): string[] {
  return locale === 'ar'
    ? ['{page}', 'صفحة {page} من {pages}', '{page} / {pages}', '- {page} -']
    : ['{page}', 'Page {page} of {pages}', '{page} / {pages}', '- {page} -'];
}

export type PagesResult = { ok: true; pages: number[] | null } | { ok: false; reason: Exclude<RangeResult, { ok: true }>['reason'] };

/** 0-based pages for a selection (`null` = every page). */
export function markPages(mode: RangeMode, custom: string, pageCount: number): PagesResult {
  if (mode === 'all') return { ok: true, pages: null };
  if (mode === 'odd' || mode === 'even') {
    const pages = Array.from({ length: pageCount }, (_, i) => i).filter((i) => (mode === 'odd' ? i % 2 === 0 : i % 2 === 1));
    return pages.length ? { ok: true, pages } : { ok: false, reason: 'empty' };
  }
  const r = parseRanges(custom, pageCount);
  if (!r.ok) return { ok: false, reason: r.reason };
  const set = new Set<number>();
  for (const [a, b] of r.ranges) for (let i = a; i <= b && set.size <= pageCount; i++) set.add(i);
  return { ok: true, pages: [...set].sort((x, y) => x - y) };
}

export function nowParts(d: Date): NonNullable<MarkSpec['now']> {
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  return [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255];
}

function rgbToHex(c: [number, number, number] | null | undefined): string {
  if (!c) return '#000000';
  return `#${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** True when the text is mostly right-to-left letters (decides what "start" means). */
export function looksRightToLeft(text: string): boolean {
  let rtl = 0;
  let ltr = 0;
  for (const ch of text.slice(0, 4000)) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0x0590 && c <= 0x08ff) || (c >= 0xfb1d && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff)) rtl++;
    else if (/\p{L}/u.test(ch)) ltr++;
  }
  return rtl > ltr;
}

export type BuildError = 'noText' | 'noPicture' | 'badNumber' | 'range';
export type BuildResult = { ok: true; spec: MarkSpec } | { ok: false; error: BuildError; reason?: string };

export interface BuildContext {
  pageCount: number;
  fileName: string;
  now: Date;
  locale: Locale;
}

function intIn(s: string, lo: number, hi: number): number | null {
  const n = Number(normalizeDigits(s).trim());
  return Number.isSafeInteger(n) && n >= lo && n <= hi ? n : null;
}

/** The engine model for the form. */
export function buildSpec(f: MarkForm, ctx: BuildContext): BuildResult {
  const pages = markPages(f.rangeMode, f.range, ctx.pageCount);
  if (!pages.ok) return { ok: false, error: 'range', reason: pages.reason };
  const common: MarkSpec = {
    kind: 'watermark',
    pages: pages.pages,
    font: f.font,
    size: f.size,
    color: hexToRgb(f.color),
    opacity: Math.min(100, Math.max(0, f.opacity)) / 100,
    rtl: f.rtl,
    digits: f.digits,
    lang: ctx.locale,
    fileName: ctx.fileName,
    now: nowParts(ctx.now),
    ui: { tab: f.tab, rangeMode: f.rangeMode, range: f.range },
  };
  switch (f.tab) {
    case 'watermark': {
      const picture = f.watermarkType === 'picture';
      if (picture && !f.hasPicture) return { ok: false, error: 'noPicture' };
      if (!picture && !f.text.trim()) return { ok: false, error: 'noText' };
      return {
        ok: true,
        spec: {
          ...common,
          kind: 'watermark',
          text: picture ? null : f.text,
          picture,
          diagonal: f.diagonal,
          rotation: f.diagonal ? 0 : f.rotation,
          vertical: f.vertical,
          horizontal: f.horizontal,
          layer: f.layer,
          scale: f.scale / 100,
        },
      };
    }
    case 'header': {
      if (![f.start, f.center, f.end].some((s) => s.trim())) return { ok: false, error: 'noText' };
      return { ok: true, spec: { ...common, kind: f.band, slots: { start: f.start, center: f.center, end: f.end }, layer: 'front' } };
    }
    case 'numbers': {
      if (!f.numberText.trim()) return { ok: false, error: 'noText' };
      return { ok: true, spec: { ...common, kind: 'pageNumber', text: f.numberText, vertical: f.vertical, horizontal: f.horizontal, layer: 'front' } };
    }
    case 'bates': {
      const start = intIn(f.batesStart, 0, 1e12);
      const digits = intIn(f.batesDigits, 1, 12);
      if (start === null || digits === null) return { ok: false, error: 'badNumber' };
      return {
        ok: true,
        spec: {
          ...common,
          kind: 'bates',
          text: '{bates}',
          bates: { prefix: f.batesPrefix, suffix: f.batesSuffix, start, digits },
          vertical: f.vertical,
          horizontal: f.horizontal,
          layer: 'front',
        },
      };
    }
  }
}

/** The form for a stored mark (editing). */
export function formFromSpec(s: MarkSpec): MarkForm {
  const ui = (s.ui && typeof s.ui === 'object' ? s.ui : {}) as { rangeMode?: RangeMode; range?: string };
  const base: MarkForm = {
    ...DEFAULT_FORM,
    font: s.font ?? 'amiri',
    size: s.size ?? DEFAULT_FORM.size,
    color: rgbToHex(s.color),
    opacity: Math.round((s.opacity ?? 1) * 100),
    vertical: s.vertical ?? DEFAULT_FORM.vertical,
    horizontal: s.horizontal ?? DEFAULT_FORM.horizontal,
    digits: s.digits ?? 'latin',
    rtl: !!s.rtl,
    rangeMode: ui.rangeMode ?? (s.pages ? 'custom' : 'all'),
    range: ui.range ?? (s.pages ? s.pages.map((p) => p + 1).join(', ') : ''),
  };
  switch (s.kind) {
    case 'watermark':
      return {
        ...base,
        tab: 'watermark',
        watermarkType: s.picture ? 'picture' : 'text',
        hasPicture: !!s.picture,
        text: s.text ?? '',
        diagonal: !!s.diagonal,
        rotation: s.rotation ?? 0,
        scale: Math.round((s.scale ?? 0.5) * 100),
        layer: s.layer ?? 'front',
      };
    case 'header':
    case 'footer':
      return { ...base, tab: 'header', band: s.kind, start: s.slots?.start ?? '', center: s.slots?.center ?? '', end: s.slots?.end ?? '' };
    case 'pageNumber':
      return { ...base, tab: 'numbers', numberText: s.text ?? '{page}' };
    case 'bates':
      return {
        ...base,
        tab: 'bates',
        batesPrefix: s.bates?.prefix ?? '',
        batesSuffix: s.bates?.suffix ?? '',
        batesStart: String(s.bates?.start ?? 1),
        batesDigits: String(s.bates?.digits ?? 6),
      };
  }
}

/** Calls drawing the mark on page `page` only (the preview), replacing mark `editing` if given
 * (an update keeps the mark's picture when no new one is chosen). */
export function previewCalls(spec: MarkSpec, page: number, editing?: string, picture?: Uint8Array): CoreCall[] {
  const blobs = picture ? [picture] : [];
  return editing
    ? [{ method: 'marks.update', params: { id: editing, mark: spec, only: [page] }, blobs }]
    : [{ method: 'marks.add', params: { mark: spec, only: [page] }, blobs }];
}

/** Calls adding the mark (or updating mark `editing`). */
export function applyCalls(spec: MarkSpec, editing?: string, picture?: Uint8Array): CoreCall[] {
  const blobs = picture ? [picture] : [];
  return editing ? [{ method: 'marks.update', params: { id: editing, mark: spec }, blobs }] : [{ method: 'marks.add', params: { mark: spec }, blobs }];
}

let seq = 0;

/** Our marks and other applications' marks in `bytes`. */
export async function listMarks(engine: EngineClient, bytes: Uint8Array, password?: string): Promise<{ marks: ListedMark[]; foreign: ForeignMark[] }> {
  const id = `marks-list-${++seq}`;
  await engine.open(id, bytes.slice(), password);
  try {
    const r = await engine.call<{ marks: ListedMark[]; foreign: ForeignMark[] }>(id, 'marks.list', {}, []);
    return r.json;
  } finally {
    engine.close(id).catch(() => {});
  }
}

type T = (key: string, args?: Record<string, string | number>) => string;

/** One-line description of a stored mark. */
export function describeMark(s: Partial<MarkSpec> | null, t: T): string {
  if (!s || !s.kind) return t('marks.kind.unknown');
  const kind = t(`marks.kind.${s.kind}`);
  let what = '';
  if (s.kind === 'watermark') what = s.picture ? t('marks.picture') : (s.text ?? '');
  else if (s.kind === 'header' || s.kind === 'footer') what = [s.slots?.start, s.slots?.center, s.slots?.end].filter((x) => x && x.trim()).join(' · ');
  else if (s.kind === 'bates' && s.bates) what = `${s.bates.prefix}${String(s.bates.start).padStart(s.bates.digits, '0')}${s.bates.suffix}`;
  else what = s.text ?? '';
  return what ? `${kind}: ${what}` : kind;
}
