import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import { translate } from '../i18n/messages';
import type { TKey, TParams } from '../i18n/messages';
import { HIDDEN_KINDS, PATTERNS, defaultChoices, detailText, marksOf } from './findings';
import type { FoundMatch, HiddenReport } from './findings';

const t = (key: TKey, params?: TParams) => translate('en', key, params);

describe('search-and-redact results', () => {
  const matches: FoundMatch[] = [
    { page: 0, text: 'Haddad', before: 'Nadia ', after: '', kind: 'text', rects: [{ x: 1, y: 2, width: 3, height: 4 }] },
    { page: 2, text: 'a@b.sa', before: '', after: '', kind: 'email', rects: [{ x: 5, y: 6, width: 7, height: 8 }] },
  ];

  it('marks only the chosen matches, with their pages and boxes', () => {
    expect(marksOf(matches, new Set([1]))).toEqual([{ page: 2, text: 'a@b.sa', rects: [{ x: 5, y: 6, width: 7, height: 8 }] }]);
    expect(marksOf(matches, new Set())).toEqual([]);
  });

  it('names every pattern and every kind of hidden information in the interface', () => {
    for (const kind of PATTERNS) expect(en).toHaveProperty(`redact.kind.${kind}`);
    for (const kind of HIDDEN_KINDS) expect(en).toHaveProperty(`redact.hidden.kind.${kind}`);
  });
});

describe('remove hidden information', () => {
  const report: HiddenReport = {
    findings: [
      { kind: 'metadata', count: 2, details: ['Title: Budget 2026', 'XMP (1)'] },
      { kind: 'hiddenText', count: 3, details: ['invisible (3)'] },
    ],
    revisions: 1,
    unreachable: 0,
    signed: false,
    protected: false,
  };

  it('chooses everything found but hidden text, which may be a scan’s OCR layer', () => {
    expect([...defaultChoices(report)]).toEqual(['metadata']);
  });

  it("says the core's words in the interface's language and leaves the file's own", () => {
    expect(detailText('invisible (3)', t)).toBe('3 invisible');
    expect(detailText('XMP (1)', t)).toBe('XMP metadata (1)');
    expect(detailText('OpenAction', t)).toBe('An action run on opening');
    expect(detailText('Title: Budget 2026', t)).toBe('Title: Budget 2026');
    expect(detailText('report (2).pdf', t)).toBe('report (2).pdf');
  });
});
