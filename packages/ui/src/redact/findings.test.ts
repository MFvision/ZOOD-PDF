import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import { translate } from '../i18n/messages';
import type { Lang, TKey, TParams } from '../i18n/messages';
import { ANNOTATION_KINDS, HIDDEN_KINDS, PATTERNS, PROPERTY_KEYS, defaultChoices, detailText, marksOf, placed } from './findings';
import type { FoundMatch, HiddenReport } from './findings';

const t =
  (lang: Lang = 'en') =>
  (key: TKey, params?: TParams) =>
    translate(lang, key, params);

describe('search-and-redact results', () => {
  const matches: FoundMatch[] = [
    { page: 0, text: 'Haddad', before: 'Nadia ', after: '', kind: 'text', artifact: false, rects: [{ x: 1, y: 2, width: 3, height: 4 }] },
    { page: 2, text: 'a@b.sa', before: '', after: '', kind: 'email', artifact: true, rects: [{ x: 5, y: 6, width: 7, height: 8 }] },
    { page: 3, text: 'x', before: '', after: '', kind: 'text', artifact: false, rects: [] },
  ];

  it('marks only the chosen matches, with their pages and boxes', () => {
    expect(marksOf(matches, new Set([1]))).toEqual([{ page: 2, text: 'a@b.sa', rects: [{ x: 5, y: 6, width: 7, height: 8 }] }]);
    expect(marksOf(matches, new Set())).toEqual([]);
  });

  it('knows a match the reader could not place, to be marked by hand', () => {
    expect(matches.map(placed)).toEqual([true, true, false]);
  });

  it('names every pattern and every kind of hidden information in the interface', () => {
    for (const kind of PATTERNS) expect(en).toHaveProperty(`redact.kind.${kind}`);
    for (const kind of HIDDEN_KINDS) expect(en).toHaveProperty(`redact.hidden.kind.${kind}`);
    for (const kind of ANNOTATION_KINDS) expect(en).toHaveProperty(`redact.hidden.subtype.${kind}`);
    for (const key of PROPERTY_KEYS) expect(en).toHaveProperty(`redact.hidden.property.${key}`);
  });
});

describe('remove hidden information', () => {
  const report: HiddenReport = {
    findings: [
      { kind: 'metadata', count: 2, details: [{ property: 'Title', value: 'Budget 2026', date: null }, { word: 'XMP', count: 1 }] },
      { kind: 'hiddenText', count: 3, details: [{ word: 'invisible', count: 3 }] },
    ],
    revisions: 1,
    unreachable: 0,
    signed: false,
    protected: false,
  };

  it('chooses everything found but hidden text, which may be a scan’s OCR layer', () => {
    expect([...defaultChoices(report)]).toEqual(['metadata']);
  });

  it("says the core's words, annotation kinds and property keys in the interface's language", () => {
    expect(detailText({ word: 'invisible', count: 3 }, t(), 'en')).toBe('Invisible: 3');
    expect(detailText({ word: 'XMP', count: 1 }, t(), 'en')).toBe('XMP metadata: 1');
    expect(detailText({ word: 'OpenAction', count: 1 }, t(), 'en')).toBe('An action run on opening');
    expect(detailText({ subtype: 'Highlight', count: 2 }, t(), 'en')).toBe('Highlights: 2');
    expect(detailText({ subtype: 'Highlight', count: 2 }, t('ar'), 'ar')).toBe('تظليل: 2');
    expect(detailText({ property: 'Title', value: 'Budget 2026', date: null }, t(), 'en')).toBe('Title: Budget 2026');
    expect(detailText({ property: 'Author', value: 'نادية', date: null }, t('ar'), 'ar')).toBe('المؤلف: نادية');
    expect(detailText({ word: 'white', count: 1 }, t('ar'), 'ar')).toBe('نصوص بيضاء على خلفية بيضاء: 1');
  });

  it('writes a date property as a date, not in PDF syntax', () => {
    const detail = { property: 'CreationDate', value: "D:20240101120000+03'00'", date: '2024-01-01T09:00:00Z' };
    const english = detailText(detail, t(), 'en');
    expect(english).toMatch(/^Created: .*2024/);
    expect(english).not.toContain('D:2024');
    expect(detailText(detail, t('ar'), 'ar')).toMatch(/^تاريخ الإنشاء: /);
  });

  it("leaves the file's own names and keys as the file has them", () => {
    // A layer the file calls "white" is a name, not the core's word.
    expect(detailText({ name: 'white' }, t(), 'en')).toBe('white');
    expect(detailText({ name: 'XMP' }, t('ar'), 'ar')).toBe('XMP');
    expect(detailText({ subtype: 'MyStamp', count: 1 }, t(), 'en')).toBe('MyStamp (1)');
    expect(detailText({ property: 'Department', value: 'Finance', date: null }, t(), 'en')).toBe('Department: Finance');
  });
});
