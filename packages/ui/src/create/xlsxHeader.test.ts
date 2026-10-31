import { describe, expect, it } from 'vitest';
import { looksLikeHeader } from './xlsx';

describe('looksLikeHeader', () => {
  const body = [
    [{ text: '000123' }, { text: 'Ahmed' }, { text: '12,500', align: 'end' as const }],
    [{ text: '000124' }, { text: 'Sara' }, { text: '9,800', align: 'end' as const }],
  ];

  it('takes a bold row of words over the data as column titles', () => {
    expect(looksLikeHeader([[{ text: 'ID', bold: true }, { text: 'الاسم', bold: true }, { text: 'Salary', bold: true }], ...body])).toBe(true);
    expect(looksLikeHeader([[{ text: 'ID', fill: '#DDEEFF' }, { text: 'Name', fill: '#DDEEFF' }, { text: '' }], ...body])).toBe(true);
  });

  it('leaves plain rows, figures, a single title and short sheets alone', () => {
    expect(looksLikeHeader([[{ text: 'ID' }, { text: 'Name' }, { text: 'Salary' }], ...body])).toBe(false);
    expect(looksLikeHeader([[{ text: '2025', bold: true }, { text: '2026', bold: true }, { text: '' }], ...body])).toBe(false);
    expect(looksLikeHeader([[{ text: 'Staff list', bold: true, span: 3 }], ...body])).toBe(false);
    expect(looksLikeHeader([[{ text: 'ID', bold: true }, { text: 'Name', bold: true }], body[0]!])).toBe(false);
  });
});
