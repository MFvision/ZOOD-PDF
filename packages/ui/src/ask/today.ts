import { asciiDigits } from './draft';

/**
 * The loose ends in the person's own documents: a payment due, a contract
 * or a licence about to end, a renewal — lines of their Library that say a
 * deadline word and hold a date from a week ago to a month ahead. Read on
 * this computer, from the Library's index, every time the home screen
 * opens; nothing is sent and nothing is decided for the person.
 *
 * Dates are read as people in Saudi Arabia write them: day first, in
 * English or Arabic month names (Gulf and Levantine), in Arabic-Indic or
 * Western digits, and in the Hijri (Umm al-Qura) calendar too.
 */

/** Words that make a date a deadline, as the Library is searched for them. */
export const DEADLINE_WORDS: readonly string[] = [
  'due',
  'deadline',
  'expiry',
  'expires',
  'expiration',
  'renewal',
  'valid until',
  'payment',
  'استحقاق',
  'الاستحقاق',
  'ينتهي',
  'انتهاء',
  'تجديد',
  'موعد',
  'سداد',
  'صالح حتى',
  'آخر موعد',
];

/** How far back an overdue item is still shown, and how far ahead a coming one. */
export const BACK_DAYS = 7;
export const AHEAD_DAYS = 30;
const DAY = 86_400_000;

const EN_MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

/** Arabic month names, Gulf/Egyptian and Levantine, to their month (1–12). */
const AR_MONTHS: readonly (readonly [string, number])[] = [
  ['كانون الثاني', 1],
  ['تشرين الأول', 10],
  ['تشرين الاول', 10],
  ['تشرين الثاني', 11],
  ['كانون الأول', 12],
  ['كانون الاول', 12],
  ['يناير', 1],
  ['فبراير', 2],
  ['مارس', 3],
  ['أبريل', 4],
  ['ابريل', 4],
  ['إبريل', 4],
  ['مايو', 5],
  ['يونيو', 6],
  ['يوليو', 7],
  ['أغسطس', 8],
  ['اغسطس', 8],
  ['سبتمبر', 9],
  ['أكتوبر', 10],
  ['اكتوبر', 10],
  ['نوفمبر', 11],
  ['ديسمبر', 12],
  ['شباط', 2],
  ['آذار', 3],
  ['اذار', 3],
  ['نيسان', 4],
  ['أيار', 5],
  ['ايار', 5],
  ['حزيران', 6],
  ['تموز', 7],
  ['آب', 8],
  ['أيلول', 9],
  ['ايلول', 9],
];

/** Hijri month names to their month (1–12). */
const HIJRI_MONTHS: readonly (readonly [string, number])[] = [
  ['ربيع الأول', 3],
  ['ربيع الاول', 3],
  ['ربيع الآخر', 4],
  ['ربيع الثاني', 4],
  ['جمادى الأولى', 5],
  ['جمادى الاولى', 5],
  ['جمادى الآخرة', 6],
  ['جمادى الثانية', 6],
  ['ذو القعدة', 11],
  ['ذي القعدة', 11],
  ['ذو الحجة', 12],
  ['ذي الحجة', 12],
  ['محرم', 1],
  ['صفر', 2],
  ['رجب', 7],
  ['شعبان', 8],
  ['رمضان', 9],
  ['شوال', 10],
];

function gregorian(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2200) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 ? date : null;
}

const hijriParts = (() => {
  let format: Intl.DateTimeFormat | null = null;
  return (date: Date): [number, number, number] | null => {
    try {
      format ??= new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
      });
      const parts = format.formatToParts(date);
      const get = (type: string) =>
        Number(parts.find((part) => part.type === type)?.value.replace(/\D/g, ''));
      const found: [number, number, number] = [get('year'), get('month'), get('day')];
      return found.every(Number.isFinite) ? found : null;
    } catch {
      return null;
    }
  };
})();

/** A Hijri (Umm al-Qura) date as the Gregorian day it falls on. */
export function fromHijri(year: number, month: number, day: number): Date | null {
  if (year < 1300 || year > 1600 || month < 1 || month > 12 || day < 1 || day > 30) return null;
  // Near enough from the mean lengths, then found exactly by the calendar itself.
  const epoch = Date.UTC(622, 6, 16);
  const estimate = epoch + ((year - 1) * 354.36667 + (month - 1) * 29.5306 + (day - 1)) * DAY;
  for (let shift = 0; shift <= 6; shift += 1) {
    for (const sign of shift === 0 ? [0] : [-1, 1]) {
      const date = new Date(Math.round(estimate / DAY) * DAY + sign * shift * DAY);
      const parts = hijriParts(date);
      if (parts && parts[0] === year && parts[1] === month && parts[2] === day) return date;
    }
  }
  return null;
}

/** Day-first numbers as a date: a Hijri year (13xx–15xx) as Hijri. */
function numeric(day: number, month: number, year: number): Date | null {
  if (year >= 1300 && year < 1600) return fromHijri(year, month, day);
  return gregorian(year < 100 ? 2000 + year : year, month, day);
}

/** Every date written in `line`. */
export function findDates(line: string): Date[] {
  const text = asciiDigits(line).replace(/[‏‎؜]/g, '');
  const found: Date[] = [];
  const push = (date: Date | null) => {
    if (date && !found.some((one) => one.getTime() === date.getTime())) found.push(date);
  };
  // 2026-10-21, 2026/10/21
  for (const m of text.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    push(year >= 1300 && year < 1600 ? fromHijri(year, month, day) : gregorian(year, month, day));
  }
  // 21/10/2026, 21-10-2026, 21.10.26, 15/04/1448
  for (const m of text.matchAll(
    /(?<![\d/.-])(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?![\d/.-])/g,
  )) {
    push(numeric(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  // 21 October 2026, 21 Oct. 2026
  for (const m of text.matchAll(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g,
  )) {
    const month = EN_MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1;
    if (month) push(gregorian(Number(m[3]), month, Number(m[1])));
  }
  // October 21, 2026
  for (const m of text.matchAll(
    /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g,
  )) {
    const month = EN_MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1;
    if (month) push(gregorian(Number(m[3]), month, Number(m[2])));
  }
  // ٢١ أكتوبر ٢٠٢٦ · ١٥ ربيع الآخر ١٤٤٨ هـ
  for (const [names, hijri] of [
    [HIJRI_MONTHS, true],
    [AR_MONTHS, false],
  ] as const) {
    for (const [name, month] of names) {
      const pattern = new RegExp(
        `(\\d{1,2})\\s+(?:من\\s+)?(?:شهر\\s+)?${name}\\s+(?:عام\\s+|سنة\\s+)?(\\d{4})`,
        'g',
      );
      for (const m of text.matchAll(pattern)) {
        const [day, year] = [Number(m[1]), Number(m[2])];
        push(
          hijri || (year >= 1300 && year < 1600)
            ? fromHijri(year, month, day)
            : gregorian(year, month, day),
        );
      }
    }
  }
  return found;
}

export interface Line {
  key: string;
  name: string;
  page: number;
  text: string;
}

export interface LooseEnd extends Line {
  /** The date, at midnight UTC. */
  date: Date;
  /** Whole days from today: negative when it has passed. */
  days: number;
}

function midnight(now: Date): number {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * The lines with a date from a week ago to a month ahead: one per
 * document and date, passed ones first, then the soonest.
 */
export function looseEnds(lines: readonly Line[], now: Date = new Date(), most = 5): LooseEnd[] {
  const today = midnight(now);
  const seen = new Set<string>();
  const ends: LooseEnd[] = [];
  for (const line of lines) {
    for (const date of findDates(line.text)) {
      const days = Math.round((date.getTime() - today) / DAY);
      if (days < -BACK_DAYS || days > AHEAD_DAYS) continue;
      const id = `${line.key}#${date.getTime()}`;
      if (seen.has(id)) continue;
      seen.add(id);
      ends.push({ ...line, date, days });
    }
  }
  return ends
    .sort((a, b) => (a.days < 0 === b.days < 0 ? a.days - b.days : a.days < 0 ? -1 : 1))
    .slice(0, most);
}

/** An item's own id, to keep it hidden once the person dismissed it. */
export function endId(end: Pick<LooseEnd, 'key' | 'date'>): string {
  return `${end.key}#${end.date.toISOString().slice(0, 10)}`;
}
