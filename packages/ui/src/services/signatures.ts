/**
 * Digital signatures — pure helpers for the interface: certificate summaries (distinguished
 * names with Arabic values), signing times in Gregorian or Hijri (Umm al-Qura) with locale
 * digits, the lines of a visible appearance, placing a drawn rectangle in PDF user space, and
 * the overall verification status. Engine calls live in `signing.ts`.
 */
import { intlTag, type Locale, type Translate } from '../i18n';

/** `sign.inspect` / `sign.verify` signer summary (warraq-sign `SignerInfo`). */
export interface SignerInfo {
  name: string;
  subject: string;
  issuer: string;
  serial: string;
  keyAlgorithm: string;
  notBefore: string;
  notAfter: string;
  email?: string;
}

export interface CertSummary {
  signer: SignerInfo;
  chain: string[];
  eku: { accepted: boolean; detail: string };
  validNow: boolean;
  canSign: boolean;
}

export interface Note {
  code: string;
  message: string;
}

export interface Modification {
  kind: string;
  allowed: boolean;
  object?: string;
  page?: number;
  field?: string;
  detail: string;
}

/** One signature's verification (warraq-sign `Report`). */
export interface SignatureReport {
  index: number;
  field: string;
  kind: 'approval' | 'certification' | 'documentTimestamp';
  subFilter: string;
  status: 'valid' | 'valid_identity_unknown' | 'modified' | 'invalid' | 'unsupported' | 'unchecked';
  integrity: boolean;
  identity: 'trusted' | 'unknown' | 'invalid';
  signer: SignerInfo | null;
  chain: string[];
  claimedTime: string | null;
  timestamp: { time: string | null; valid: boolean; trusted: boolean; authority: string | null } | null;
  reason: string | null;
  location: string | null;
  contactInfo: string | null;
  level: string;
  revision: number | null;
  coversWholeDocument: boolean;
  byteRange: [number, number, number, number];
  certification: number | null;
  locks: { action: string; fields: string[] }[];
  revocation: string;
  reasons: Note[];
  warnings: Note[];
  modifications: Modification[];
  attacks: { kind: string; detail: string }[];
}

export type Tone = 'good' | 'warn' | 'bad';

export function statusTone(status: string): Tone {
  if (status === 'valid') return 'good';
  if (status === 'modified' || status === 'invalid') return 'bad';
  return 'warn';
}

export type Overall = 'none' | 'valid' | 'valid_identity_unknown' | 'modified' | 'invalid' | 'unsupported';

/** Worst status over every signature (invalid › modified › unknown identity › valid). */
export function overallStatus(reports: Pick<SignatureReport, 'status' | 'kind'>[]): Overall {
  if (reports.length === 0) return 'none';
  const has = (s: string) => reports.some((r) => r.status === s);
  if (has('invalid')) return 'invalid';
  if (has('modified')) return 'modified';
  if (has('unsupported') || has('unchecked')) return 'unsupported';
  if (has('valid_identity_unknown')) return 'valid_identity_unknown';
  return 'valid';
}

/** Cheap check before asking the engine: a signed PDF has a `/ByteRange`. */
export function looksSigned(bytes: Uint8Array): boolean {
  const needle = [0x2f, 0x42, 0x79, 0x74, 0x65, 0x52, 0x61, 0x6e, 0x67, 0x65]; // "/ByteRange"
  const n = needle.length;
  outer: for (let i = 0; i + n <= bytes.length; i++) {
    if (bytes[i] !== 0x2f) continue;
    for (let j = 1; j < n; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** `CN=…, O=…` as written by the engine (no escaping; values may contain ", "). */
export function parseDn(dn: string): { key: string; value: string }[] {
  if (!dn.trim()) return [];
  const parts = dn.split(/, (?=(?:[A-Za-z]+|\d+(?:\.\d+)+)=)/);
  return parts.map((p) => {
    const eq = p.indexOf('=');
    return eq < 0 ? { key: '', value: p } : { key: p.slice(0, eq), value: p.slice(eq + 1) };
  });
}

export function dnField(dn: string, key: string): string | undefined {
  return parseDn(dn).find((p) => p.key === key)?.value;
}

/** Bidi formatting characters that Intl inserts around dates; the signature font draws none of them. */
export function stripBidiControls(s: string): string {
  return s.replace(/[‎‏؜‪-‮⁦-⁩]/g, '');
}

export type Calendar = 'gregory' | 'islamic';

function calendarTag(locale: Locale, calendar: Calendar): string {
  if (calendar === 'gregory') return intlTag(locale);
  // Unicode extension keys in alphabetical order: ca before nu.
  return locale === 'ar' ? 'ar-u-ca-islamic-umalqura-nu-arab' : 'en-u-ca-islamic-umalqura';
}

/** Date and time of a signature (ISO 8601 from the engine). */
export function formatSignTime(iso: string | null | undefined, locale: Locale, calendar: Calendar, timeZone?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(calendarTag(locale, calendar), { dateStyle: 'long', timeStyle: 'short', timeZone }).format(d);
}

/** Date only (certificate validity). */
export function formatDay(iso: string | null | undefined, locale: Locale, calendar: Calendar = 'gregory'): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(calendarTag(locale, calendar), { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
}

export interface AppearanceInput {
  name: string;
  reason: string;
  location: string;
  date: Date;
  showDate: boolean;
  timeZone?: string;
}

/** Lines drawn in a visible signature, localised, digits per locale. */
export function appearanceLines(t: Translate, locale: Locale, a: AppearanceInput): string[] {
  const lines = [a.name.trim()];
  if (a.showDate) {
    const date = new Intl.DateTimeFormat(intlTag(locale), {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: a.timeZone,
    }).format(a.date);
    lines.push(t('sign.ap.date', { date: stripBidiControls(date).replace(/،/g, '').replace(/,/g, '') }));
  }
  if (a.reason.trim()) lines.push(t('sign.ap.reason', { reason: a.reason.trim() }));
  if (a.location.trim()) lines.push(t('sign.ap.location', { location: a.location.trim() }));
  return lines.filter(Boolean).map(stripBidiControls);
}

/** A selection on the rendered page picture, as fractions with the origin at the top-left. */
export interface PreviewRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Converts a rectangle drawn on the rendered page (which shows `/Rotate` applied) to the page's
 * unrotated user space `[x0, y0, x1, y1]` (origin bottom-left), rounded to whole points.
 */
export function previewRectToPdf(sel: PreviewRect, page: { width: number; height: number }, rotation: number): [number, number, number, number] {
  const { width: W, height: H } = page;
  const u0 = Math.min(sel.x0, sel.x1);
  const u1 = Math.max(sel.x0, sel.x1);
  const v0 = Math.min(sel.y0, sel.y1);
  const v1 = Math.max(sel.y0, sel.y1);
  const rot = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  let xs: [number, number];
  let ys: [number, number];
  switch (rot) {
    case 90:
      xs = [v0 * W, v1 * W];
      ys = [u0 * H, u1 * H];
      break;
    case 180:
      xs = [(1 - u1) * W, (1 - u0) * W];
      ys = [v0 * H, v1 * H];
      break;
    case 270:
      xs = [(1 - v1) * W, (1 - v0) * W];
      ys = [(1 - u1) * H, (1 - u0) * H];
      break;
    default:
      xs = [u0 * W, u1 * W];
      ys = [(1 - v1) * H, (1 - v0) * H];
  }
  const r = (n: number) => Math.round(n);
  return [r(xs[0]), r(ys[0]), r(xs[1]), r(ys[1])];
}

/** Timestamp authorities offered by default (editable; desktop only). Free RFC 3161 services. */
export const DEFAULT_TSAS: readonly string[] = [
  'http://timestamp.digicert.com',
  'http://timestamp.sectigo.com',
  'https://freetsa.org/tsr',
  'http://time.certum.pl',
];
