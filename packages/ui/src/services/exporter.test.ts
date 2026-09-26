import { describe, expect, it, vi } from 'vitest';
import { EXPORT_FORMATS, exportFileName, parsePageRange, runExport, toAsciiDigits } from './exporter';
import type { EngineClient, Reply } from './engine';

describe('page ranges', () => {
  it('accepts Western, Arabic-Indic and Persian digits and Arabic separators', () => {
    expect(parsePageRange('', 5)).toEqual([0, 1, 2, 3, 4]);
    expect(parsePageRange('1-3, 5', 5)).toEqual([0, 1, 2, 4]);
    expect(parsePageRange('١-٣، ٥', 5)).toEqual([0, 1, 2, 4]);
    expect(parsePageRange('۲ – ۳', 5)).toEqual([1, 2]);
    expect(parsePageRange('4,2,2', 5)).toEqual([3, 1]);
    expect(parsePageRange('3-', 5)).toEqual([2, 3, 4]);
  });

  it('rejects ranges outside the document or malformed input', () => {
    expect(parsePageRange('0', 5)).toBeNull();
    expect(parsePageRange('6', 5)).toBeNull();
    expect(parsePageRange('3-1', 5)).toBeNull();
    expect(parsePageRange('a', 5)).toBeNull();
    expect(parsePageRange('1-2-3', 5)).toBeNull();
  });

  it('normalises digits', () => {
    expect(toAsciiDigits('٠١٢٣٤٥٦٧٨٩ ۰۱۲')).toBe('0123456789 012');
  });
});

describe('export formats', () => {
  it('lists the seven formats with engine methods', () => {
    expect(EXPORT_FORMATS.map((f) => f.id)).toEqual(['docx', 'xlsx', 'pptx', 'html', 'markdown', 'text', 'png']);
    for (const f of EXPORT_FORMATS) expect(f.ext).toMatch(/^[a-z]+$/);
  });

  it('names files after the document', () => {
    expect(exportFileName('تقرير.pdf', 'docx')).toBe('تقرير.docx');
    expect(exportFileName('report.PDF', 'md')).toBe('report.md');
    expect(exportFileName('noext', 'txt')).toBe('noext.txt');
    expect(exportFileName('a.pdf', 'png', 3)).toBe('a-3.png');
  });
});

function fakeEngine(): EngineClient & { calls: { method: string; params: unknown; blobs: number }[] } {
  const calls: { method: string; params: unknown; blobs: number }[] = [];
  return {
    calls,
    open: vi.fn(async () => ({ json: {}, blobs: [] })),
    close: vi.fn(async () => {}),
    terminate: vi.fn(),
    call: vi.fn(async (_doc: string, method: string, params: unknown, blobs: Uint8Array[] = []) => {
      calls.push({ method, params, blobs: blobs.length });
      return { json: { extension: 'docx' }, blobs: [new Uint8Array([80, 75])] } as Reply<never>;
    }),
    callStatic: vi.fn(async (method: string, params: unknown, blobs: Uint8Array[] = []) => {
      calls.push({ method, params, blobs: blobs.length });
      return { json: {}, blobs: [new Uint8Array([80, 75, 3, 4])] } as Reply<never>;
    }),
  } as unknown as EngineClient & { calls: { method: string; params: unknown; blobs: number }[] };
}

describe('runExport', () => {
  it('opens a private engine copy, calls export.<format> with 0-based pages and closes it', async () => {
    const engine = fakeEngine();
    const out = await runExport({ engine, bytes: new Uint8Array([1]), name: 'a.pdf', format: 'docx', pages: [0, 2], title: 'a' });
    expect(out.name).toBe('a.docx');
    expect(engine.calls).toEqual([{ method: 'export.docx', params: { pages: [0, 2], title: 'a' }, blobs: 0 }]);
    expect(engine.close).toHaveBeenCalled();
  });

  it('PNG: one page is a PNG, several pages are zipped by the engine', async () => {
    const engine = fakeEngine();
    const render = vi.fn(async () => new Uint8Array([137, 80, 78, 71]));
    const one = await runExport({ engine, bytes: new Uint8Array([1]), name: 'a.pdf', format: 'png', pages: [1], renderPage: render });
    expect(one.name).toBe('a-2.png');
    expect(one.bytes[0]).toBe(137);
    const many = await runExport({ engine, bytes: new Uint8Array([1]), name: 'a.pdf', format: 'png', pages: [0, 1], renderPage: render });
    expect(many.name).toBe('a.zip');
    expect(engine.calls.at(-1)).toEqual({ method: 'export.zip', params: { names: ['a-1.png', 'a-2.png'] }, blobs: 2 });
  });
});
