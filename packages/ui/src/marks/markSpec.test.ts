import { describe, expect, it } from 'vitest';
import { batesSample, DEFAULT_FORM, formOf, formatDate, hasContent, inDigits, pageNumberSample, pagesLabel, parsePages, pdfDate, specOf } from './markSpec';
import en from '../i18n/en.json';
import ar from '../i18n/ar.json';
import { interpolate } from '../i18n/messages';

const NOW = new Date(Date.UTC(2026, 8, 18, 9, 30, 5));

describe('pages as a person types them', () => {
  it('reads ranges, open ends, Arabic-Indic digits and the Arabic comma', () => {
    expect(parsePages('', 9)).toEqual([]);
    expect(parsePages('1-3, 5', 9)).toEqual([0, 1, 2, 4]);
    expect(parsePages('7-', 9)).toEqual([6, 7, 8]);
    expect(parsePages('-2', 9)).toEqual([0, 1]);
    expect(parsePages('١-٢، ٤', 9)).toEqual([0, 1, 3]);
  });

  it('refuses what is not pages of this file', () => {
    expect(parsePages('0', 9)).toBeNull();
    expect(parsePages('3-1', 9)).toBeNull();
    expect(parsePages('10', 9)).toBeNull();
    expect(parsePages('a', 9)).toBeNull();
    expect(parsePages(',', 9)).toBeNull();
  });

  it('writes them back compactly', () => {
    expect(pagesLabel([0, 1, 2, 4, 6, 7])).toBe('1–3, 5, 7–8');
    expect(pagesLabel([3])).toBe('4');
  });
});

describe('dates in either calendar and either digits', () => {
  it('writes the Hijri date in Arabic-Indic digits', () => {
    const hijri = formatDate(NOW, 'hijri', 'arabic', true);
    expect(hijri).toMatch(/[٠-٩]/);
    expect(hijri).toContain('١٤٤٨');
    expect(hijri).not.toMatch(/[0-9]/);
  });

  it('writes the Gregorian date in Western digits, in English or Arabic', () => {
    expect(formatDate(NOW, 'gregorian', 'western', false)).toBe('18 September 2026');
    const arabic = formatDate(NOW, 'gregorian', 'western', true);
    expect(arabic).toContain('2026');
    expect(arabic).toMatch(/[؀-ۿ]/);
  });

  it('stamps a mark with a PDF date', () => {
    expect(pdfDate(NOW)).toBe('D:20260918093005Z');
  });
});

describe('the form becomes what marks.add reads, and back', () => {
  it('a watermark carries its look, and a picture its width instead of text', () => {
    const spec = specOf({ ...DEFAULT_FORM, watermarkText: ' مسودة ' }, { fileName: 'a.pdf', now: NOW });
    expect(spec).toMatchObject({ kind: 'watermark', text: 'مسودة', rotation: 45, opacity: 0.3, front: true });
    const picture = specOf({ ...DEFAULT_FORM, watermarkSource: 'picture', imageWidth: 25 }, { fileName: 'a.pdf', now: NOW });
    expect(picture.text).toBeUndefined();
    expect(picture.imageWidth).toBe(0.25);
  });

  it('an Arabic header gets its date in Arabic, the file name, and its slots as typed', () => {
    const form = { ...DEFAULT_FORM, section: 'band' as const, slots: ['التقرير', '', '{date}'] as [string, string, string], calendar: 'hijri' as const };
    const spec = specOf(form, { fileName: 'تقرير.pdf', now: NOW });
    expect(spec).toMatchObject({ kind: 'header', fileName: 'تقرير.pdf', slots: ['التقرير', '', '{date}'] });
    expect(String(spec.date)).toContain('ربيع');
  });

  it('page numbers and Bates numbers keep their numbering', () => {
    const numbers = specOf({ ...DEFAULT_FORM, section: 'pageNumber', numberFormat: 'pageOfArabic', skipFirst: true, startNumber: 3 }, { fileName: '', now: NOW });
    expect(numbers).toMatchObject({ kind: 'pageNumber', format: 'pageOfArabic', skipFirst: true, start: 3 });
    const bates = specOf({ ...DEFAULT_FORM, section: 'bates', batesPrefix: 'WRQ-', batesDigits: 99 }, { fileName: '', now: NOW });
    expect(bates).toMatchObject({ kind: 'bates', prefix: 'WRQ-', width: 20 });
  });

  it('a saved mark reads back into the same form', () => {
    for (const form of [
      { ...DEFAULT_FORM, watermarkText: 'سري', rotation: 30, opacity: 55 },
      { ...DEFAULT_FORM, section: 'band' as const, band: 'footer' as const, slots: ['a', '{page}', 'c'] as [string, string, string], direction: 'rtl' as const },
      { ...DEFAULT_FORM, section: 'pageNumber' as const, numberFormat: 'roman' as const, numberPosition: 'topRight' as const },
      { ...DEFAULT_FORM, section: 'bates' as const, batesPrefix: 'X', batesStart: 40 },
    ]) {
      const back = formOf(JSON.parse(JSON.stringify(specOf(form, { fileName: 'f.pdf', now: NOW }))));
      expect(back).toEqual(form);
    }
  });

  it('knows when there is nothing to draw', () => {
    expect(hasContent(DEFAULT_FORM, false)).toBe(false);
    expect(hasContent({ ...DEFAULT_FORM, watermarkSource: 'picture' }, true)).toBe(true);
    expect(hasContent({ ...DEFAULT_FORM, section: 'band' }, false)).toBe(false);
    expect(hasContent({ ...DEFAULT_FORM, section: 'pageNumber' }, false)).toBe(true);
  });
});

describe('what a page-number or Bates mark is shown as', () => {
  it('shows a format in the digits the mark will draw, not the ones its label was written in', () => {
    const label = (dictionary: Record<string, string>, numerals: 'western' | 'arabic') =>
      interpolate(dictionary['marks.format.pageOfArabic']!, pageNumberSample(numerals));
    // Western digits, the default: «صفحة ١ من ٩» would promise what is not drawn.
    expect(label(ar, 'western')).toBe('صفحة 1 من 9');
    expect(label(ar, 'arabic')).toBe('صفحة ١ من ٩');
    expect(label(en, 'western')).toBe('صفحة 1 من 9');
    expect(interpolate(ar['marks.format.ofTotal'], pageNumberSample('arabic'))).toBe('١ / ٩');
    expect(inDigits(2026, 'arabic')).toBe('٢٠٢٦');
  });

  it('summarises a listed mark from its own start, pages and digits', () => {
    // Three pages from 41, the first left unnumbered: 41 to 42.
    expect(pageNumberSample('arabic', 41, 3, true)).toEqual({ page: '٤١', pages: '٤٢' });
    expect(pageNumberSample('western', 1, 3)).toEqual({ page: '1', pages: '3' });
    expect(batesSample({ prefix: 'WRQ-', start: 41, width: 6 })).toBe('WRQ-000041');
    expect(batesSample({ prefix: 'A', suffix: '-X', start: 7, width: 1 })).toBe('A7-X');
    expect(batesSample({})).toBe('000001');
  });
});
