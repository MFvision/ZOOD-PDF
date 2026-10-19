import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import ar from '../i18n/ar.json';
import { QUICK_TOOLS, combinedName, findQuickTool, partName, ringToolsFor, splitGroups, splitProblem, startingOptions, toolsFor } from './plan';

const ids = (names: string[]) => toolsFor(names).map((tool) => tool.id);

describe('the quick tools', () => {
  it('offers the PDF tools for PDFs, Combine from two', () => {
    expect(ids(['a.pdf'])).toEqual([
      'compress',
      'word',
      'excel',
      'powerpoint',
      'text',
      'images',
      'ocr',
      'rotate',
      'split',
      'extract',
      'resize',
      'numbers',
      'watermark',
      'sign',
      'protect',
      'unlock',
    ]);
    expect(ids(['a.pdf', 'B.PDF'])).toContain('combine');
  });

  it('offers Convert to PDF for pictures and documents, and nothing for a mix', () => {
    expect(ids(['scan.jpg', 'notes.docx'])).toEqual(['topdf']);
    expect(ids(['a.pdf', 'scan.jpg'])).toEqual([]);
    expect(ids(['archive.zip'])).toEqual([]);
    expect(ids([])).toEqual([]);
  });

  it('starts each tool on its step with its own options', () => {
    expect(startingOptions(findQuickTool('word')!)).toMatchObject({ format: 'docx' });
    expect(startingOptions(findQuickTool('images')!)).toMatchObject({ format: 'png' });
    expect(startingOptions(findQuickTool('compress')!)).toMatchObject({ level: 'balanced' });
    expect(startingOptions(findQuickTool('extract')!)).toMatchObject({ pages: { which: 'list', list: '1-' } });
    expect(findQuickTool('format-disk')).toBeUndefined();
  });

  it('names a file made of several after the first', () => {
    expect(combinedName('C:\\docs\\تقرير.pdf', '-مدمج')).toBe('تقرير-مدمج.pdf');
    expect(combinedName('scan.JPG', '-together')).toBe('scan-together.pdf');
  });

  it('has every name and suffix in both languages', () => {
    for (const tool of QUICK_TOOLS) {
      const keepsName = ['word', 'excel', 'powerpoint', 'text', 'images', 'topdf', 'sign'].includes(tool.id);
      for (const key of [tool.labelKey, tool.noteKey, ...(keepsName ? [] : [`quick.suffix.${tool.id}`])]) {
        expect(key in en, key).toBe(true);
        expect(key in ar, key).toBe(true);
      }
    }
  });

  it('runs at once unless it needs something only the person can say', () => {
    const asks = QUICK_TOOLS.filter((tool) => tool.mode === 'ask').map((tool) => tool.id);
    expect(asks).toEqual(['split', 'extract', 'resize', 'watermark', 'protect', 'unlock']);
    expect(findQuickTool('sign')!.mode).toBe('editor');
    expect(findQuickTool('excel')).toMatchObject({ mode: 'instant', step: 'export', options: { format: 'xlsx' } });
    expect(startingOptions(findQuickTool('numbers')!)).toMatchObject({ form: { section: 'pageNumber' } });
    expect(startingOptions(findQuickTool('watermark')!)).toMatchObject({ form: { section: 'watermark', watermarkText: '' } });
  });

  it('keeps the ring to a few tools', () => {
    expect(ringToolsFor(['a.pdf']).length).toBeLessThanOrEqual(10);
    expect(ringToolsFor(['a.pdf', 'b.pdf']).map((tool) => tool.id)).toContain('combine');
    expect(ringToolsFor(['a.png']).map((tool) => tool.id)).toEqual(['topdf']);
  });

  it('splits every so many pages, or by parts', () => {
    expect(splitGroups({ how: 'every', every: 2, ranges: '' }, 5)).toEqual([[0, 1], [2, 3], [4]]);
    expect(splitGroups({ how: 'ranges', every: 1, ranges: '1-2, 4-' }, 6)).toEqual([[0, 1], [3, 4, 5]]);
    expect(splitGroups({ how: 'ranges', every: 1, ranges: '١-٢، ٣' }, 3)).toEqual([[0, 1], [2]]);
    expect(splitGroups({ how: 'ranges', every: 1, ranges: '9-' }, 3)).toBeNull();
    expect(splitGroups({ how: 'every', every: 1, ranges: '' }, 100_000)!.length).toBe(500);
    expect(splitProblem({ how: 'ranges', every: 1, ranges: '' })).toBe('quick.problem.split');
    expect(splitProblem({ how: 'ranges', every: 1, ranges: '1-x' })).toBe('quick.problem.split');
    expect(splitProblem({ how: 'ranges', every: 1, ranges: '1-3, 4-' })).toBeNull();
    expect(partName('C:\\docs\\تقرير.pdf', '-جزء', 2)).toBe('تقرير-جزء2.pdf');
  });
});
