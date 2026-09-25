import { describe, expect, it } from 'vitest';
import en from './en.json';
import ar from './ar.json';
import { createTranslator, detectLocale, dirFor, formatMessage, formatNumber, formatDate } from './index';

describe('message catalogues', () => {
  it('en.json and ar.json have identical key sets', () => {
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
  });

  it('have no empty values', () => {
    for (const [locale, catalogue] of Object.entries({ en, ar })) {
      for (const [key, value] of Object.entries(catalogue)) {
        expect(typeof value, `${locale}:${key}`).toBe('string');
        expect((value as string).trim(), `${locale}:${key}`).not.toBe('');
      }
    }
  });

  it('use the same placeholders in both languages', () => {
    const names = (s: string) => [...s.matchAll(/\{(\w+)(?=[,}])/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(names(ar[key]), key).toEqual(names(en[key]));
    }
  });

  it('never call the app anything but ZOOD PDF / زود PDF', () => {
    expect(en['app.name']).toBe('ZOOD PDF');
    expect(ar['app.name']).toBe('زود PDF');
    expect(ar['home.hero.title']).toBe('ملفات PDF، من جديد');
    expect(en['home.hero.title']).toBe('PDF, reimagined');
  });
});

describe('formatMessage', () => {
  it('substitutes simple arguments', () => {
    expect(formatMessage('Hello {name}', 'en', { name: 'Sara' })).toBe('Hello Sara');
  });

  it('formats numbers with locale digits', () => {
    expect(formatMessage('Page {page} of {total}', 'ar', { page: 3, total: 12 })).toBe('Page ٣ of ١٢');
    expect(formatMessage('Page {page} of {total}', 'en', { page: 3, total: 12 })).toBe('Page 3 of 12');
  });

  it('selects English plural forms', () => {
    const msg = '{count, plural, one {# file} other {# files}}';
    expect(formatMessage(msg, 'en', { count: 1 })).toBe('1 file');
    expect(formatMessage(msg, 'en', { count: 4 })).toBe('4 files');
  });

  it('selects all six Arabic plural categories', () => {
    const msg =
      '{count, plural, zero {لا ملفات} one {ملف واحد} two {ملفان} few {# ملفات} many {# ملفًا} other {# ملف}}';
    expect(formatMessage(msg, 'ar', { count: 0 })).toBe('لا ملفات');
    expect(formatMessage(msg, 'ar', { count: 1 })).toBe('ملف واحد');
    expect(formatMessage(msg, 'ar', { count: 2 })).toBe('ملفان');
    expect(formatMessage(msg, 'ar', { count: 5 })).toBe('٥ ملفات');
    expect(formatMessage(msg, 'ar', { count: 11 })).toBe('١١ ملفًا');
    expect(formatMessage(msg, 'ar', { count: 100 })).toBe('١٠٠ ملف');
  });

  it('prefers exact =n matches', () => {
    expect(formatMessage('{n, plural, =0 {none} one {one} other {#}}', 'en', { n: 0 })).toBe('none');
  });

  it('leaves unknown arguments visible rather than crashing', () => {
    expect(formatMessage('Hi {who}', 'en', {})).toBe('Hi {who}');
  });
});

describe('locale helpers', () => {
  it('maps locales to text direction', () => {
    expect(dirFor('ar')).toBe('rtl');
    expect(dirFor('en')).toBe('ltr');
  });

  it('detects the browser language', () => {
    expect(detectLocale(['ar-SA', 'en'])).toBe('ar');
    expect(detectLocale(['fr-FR', 'en-GB'])).toBe('en');
    expect(detectLocale(['de'])).toBe('en');
    expect(detectLocale([])).toBe('en');
  });

  it('formats numbers and dates per locale', () => {
    expect(formatNumber(2026, 'ar')).toBe('٢٬٠٢٦');
    expect(formatNumber(2026, 'en')).toBe('2,026');
    const d = new Date(Date.UTC(2026, 8, 25, 12));
    expect(formatDate(d, 'ar')).toMatch(/[٠-٩]/);
    expect(formatDate(d, 'en')).toMatch(/2026/);
  });

  it('creates a typed translator', () => {
    const t = createTranslator('ar');
    expect(t('app.name')).toBe('زود PDF');
    expect(t('doc.pageOf', { page: 1, total: 9 })).toBe('صفحة ١ من ٩');
  });
});
