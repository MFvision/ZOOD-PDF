import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import ar from '../i18n/ar.json';
import { QUICK_TOOLS, combinedName, findQuickTool, startingOptions, toolsFor } from './plan';

const ids = (names: string[]) => toolsFor(names).map((tool) => tool.id);

describe('the quick tools', () => {
  it('offers the PDF tools for PDFs, Combine from two', () => {
    expect(ids(['a.pdf'])).toEqual(['compress', 'word', 'images', 'ocr', 'rotate', 'extract', 'protect']);
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
      for (const key of [tool.labelKey, tool.noteKey, `quick.suffix.${tool.id}`]) {
        expect(key in en, key).toBe(true);
        expect(key in ar, key).toBe(true);
      }
    }
  });
});
