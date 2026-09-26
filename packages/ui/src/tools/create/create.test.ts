import { describe, expect, it, vi } from 'vitest';
import { CREATE_ACCEPT, DEFAULT_SETTINGS, createErrorKey, createKind, createPdfs, move } from './create';
import type { EngineClient } from '../../services/engine';
import en from '../../i18n/en.json';
import ar from '../../i18n/ar.json';

describe('create PDF helpers', () => {
  it('recognises every supported format by extension', () => {
    expect(createKind('Report.DOCX')).toBe('word');
    expect(createKind('a.xlsx')).toBe('excel');
    expect(createKind('deck.pptx')).toBe('powerpoint');
    expect(createKind('page.htm')).toBe('web');
    expect(createKind('notes.md')).toBe('markdown');
    expect(createKind('scan.tif')).toBe('picture');
    expect(createKind('data.tsv')).toBe('table');
    expect(createKind('old.doc')).toBeNull();
    expect(createKind('file.pdf')).toBeNull();
    expect(CREATE_ACCEPT).toContain('.docx');
    expect(CREATE_ACCEPT).toContain('image/tiff');
  });

  it('reorders within bounds', () => {
    expect(move([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(move([1, 2, 3], 2, -2)).toEqual([3, 1, 2]);
    expect(move([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(move([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
  });

  it('calls create.fromFiles with copies of the files and the settings', async () => {
    const callStatic = vi.fn(async () => ({
      json: { documents: [{ name: 'a.pdf', pageCount: 2, byteLength: 3 }] },
      blobs: [new Uint8Array([1, 2, 3])],
    }));
    const engine = { callStatic } as unknown as EngineClient;
    const bytes = new Uint8Array([9, 9]);
    const out = await createPdfs(engine, [{ name: 'a.md', bytes }], { ...DEFAULT_SETTINGS, pageNumbers: true }, 'ar');
    expect(out).toEqual([{ name: 'a.pdf', pageCount: 2, bytes: new Uint8Array([1, 2, 3]) }]);
    const [method, params, blobs] = callStatic.mock.calls[0] as unknown as [string, Record<string, unknown>, Uint8Array[]];
    expect(method).toBe('create.fromFiles');
    expect(params).toMatchObject({ files: [{ name: 'a.md' }], pageSize: 'auto', merge: true, pageNumbers: true, locale: 'ar' });
    expect(blobs[0]).not.toBe(bytes);
    expect(Array.from(blobs[0]!)).toEqual([9, 9]);
  });

  it('maps engine error codes to translated messages', () => {
    for (const code of ['unsupported_format', 'malformed_input', 'limit_exceeded', 'whatever', undefined]) {
      const key = createErrorKey(code);
      expect(en[key]).toBeTruthy();
      expect(ar[key]).toBeTruthy();
    }
  });
});
