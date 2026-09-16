import { describe, expect, it } from 'vitest';
import { createRuntime, handleRequest, toCoreError } from './handlers';
import type { ResultMap } from './protocol';
import { createMockModule, MOCK_PAGE_COUNT, MOCK_SENTENCE, mockBandRows } from './mock';

function runtime() {
  return createRuntime(createMockModule(), { kind: 'mock', version: 'mock-0.0.0' });
}

function openMock(rt: ReturnType<typeof runtime>) {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer;
  return handleRequest(rt, { id: 1, kind: 'open', bytes }).result as ResultMap['open'];
}

describe('core worker handlers with the mock module', () => {
  it('reports the mock status on init', () => {
    expect(handleRequest(runtime(), { id: 1, kind: 'init' }).result).toEqual({
      kind: 'mock',
      version: 'mock-0.0.0',
    });
  });

  it('opens a three-page A4 document with metadata', () => {
    const info = openMock(runtime());
    expect(info.pageCount).toBe(MOCK_PAGE_COUNT);
    expect(info.pageSizes).toEqual([
      [595, 842],
      [595, 842],
      [595, 842],
    ]);
    expect(info.metadata.pages).toBe(3);
    expect(info.metadata.encrypted).toBe(false);
  });

  it('renders a light-gray page with a darker band and transfers the buffer', () => {
    const rt = runtime();
    const { doc } = openMock(rt);
    const { result, transfer } = handleRequest(rt, { id: 2, kind: 'render_page', doc, index: 1, scale: 0.5 });
    const page = result as ResultMap['render_page'];
    expect(page.width).toBe(298);
    expect(page.height).toBe(421);
    expect(page.rgba.length).toBe(298 * 421 * 4);
    expect(transfer).toEqual([page.rgba.buffer]);
    const [bandStart] = mockBandRows(page.height, 1);
    expect(page.rgba[0]).toBe(235);
    expect(page.rgba[bandStart * page.width * 4]).toBe(170);
    expect(page.rgba[3]).toBe(255);
  });

  it('extracts the fixed Arabic sentence and rtl text lines', () => {
    const rt = runtime();
    const { doc } = openMock(rt);
    const text = handleRequest(rt, { id: 3, kind: 'extract_text', doc, index: 0 }).result as string;
    expect(text.split('\n')[0]).toBe(MOCK_SENTENCE);
    const lines = handleRequest(rt, { id: 4, kind: 'text_lines', doc, index: 0 })
      .result as ResultMap['text_lines'];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]?.direction).toBe('rtl');
  });

  it('search returns page 0 and free removes the handle', () => {
    const rt = runtime();
    const { doc } = openMock(rt);
    expect(handleRequest(rt, { id: 5, kind: 'search', doc, query: 'ورّاق' }).result).toEqual([0]);
    handleRequest(rt, { id: 6, kind: 'free', doc });
    expect(() => handleRequest(rt, { id: 7, kind: 'page_count', doc })).toThrowError(/not open/);
  });

  it('normalizes errors into stable codes', () => {
    expect(toCoreError(Object.assign(new Error('bad'), { code: 'E_PASSWORD' }))).toEqual({
      code: 'E_PASSWORD',
      message: 'bad',
    });
    expect(toCoreError(new Error('E_PARSE: broken xref'))).toEqual({
      code: 'E_PARSE',
      message: 'E_PARSE: broken xref',
    });
    expect(toCoreError('boom').code).toBe('E_UNKNOWN');
  });
});
