import { describe, expect, it } from 'vitest';
import ar from '../i18n/ar.json';
import en from '../i18n/en.json';
import { PDFA_LEVELS, groupFindings, mmToPoints, pageList, standardFileName } from './model';

describe('the Standards panel’s pieces', () => {
  it('names a copy after the file and its standard', () => {
    expect(standardFileName('فاتورة.pdf', 'PDFA-2b')).toBe('فاتورة-PDFA-2b.pdf');
    expect(standardFileName('report.PDF', 'PDFX-4')).toBe('report-PDFX-4.pdf');
    expect(standardFileName('.pdf', 'PDFA-1b')).toBe('document-PDFA-1b.pdf');
  });

  it('groups pages into runs a person reads', () => {
    expect(pageList([4, 0, 1, 2, 9, 1])).toEqual([[0, 1, 2], [4], [9]]);
    expect(pageList([])).toEqual([]);
  });

  it('groups findings by rule, each detail and page once', () => {
    const groups = groupFindings([
      { clause: '6.2.11.4.1', rule: 'fontNotEmbedded', detail: 'Arial', page: 0, object: '5 0' },
      { clause: '6.2.4.3', rule: 'deviceColour', detail: 'DeviceRGB', page: 0, object: null },
      { clause: '6.2.11.4.1', rule: 'fontNotEmbedded', detail: 'Arial', page: 2, object: '5 0' },
      { clause: '6.2.11.4.1', rule: 'fontNotEmbedded', detail: 'Tahoma', page: null, object: '9 0' },
    ]);
    expect(groups.map((g) => g.rule)).toEqual(['fontNotEmbedded', 'deviceColour']);
    expect(groups[0]).toMatchObject({ details: ['Arial', 'Tahoma'], pages: [0, 2] });
  });

  it('turns millimetres of bleed into points', () => {
    expect(mmToPoints(3)).toBe(8.5);
    expect(mmToPoints(0)).toBe(0);
  });

  it('describes every level in both languages', () => {
    for (const level of PDFA_LEVELS) {
      expect(en).toHaveProperty(`standards.level.${level}`);
      expect(ar).toHaveProperty(`standards.level.${level}`);
    }
  });
});
