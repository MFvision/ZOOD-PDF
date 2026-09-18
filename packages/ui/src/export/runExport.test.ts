import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { ParagraphData, PageSize, RenderedPageData, TextLineData } from '../core/types';
import { MAX_PAGE_PIXELS, exportCurrentFile } from './runExport';
import type { ExportRequest, ExportSource, ExportableDocument } from './runExport';

/**
 * The export path with the core faked at its boundary. The file's bytes stand
 * for what they would hold: the fake core "opens" them by name.
 */

interface FakePage {
  text: string;
  size?: PageSize;
}

const FILES: Record<string, FakePage[]> = {
  // The invoice after "Apply redactions": the title is gone from the file.
  redacted: [{ text: 'رقم الفاتورة: INV-2026-0042\nالعميل: شركة زود للتقنية' }, { text: 'الإجمالي المستحق: 3,450.00 ر.س' }],
  // The same invoice as Warraq opened it, before the redaction.
  original: [{ text: 'فاتورة ضريبية مبسطة\nرقم الفاتورة: INV-2026-0042\nالعميل: شركة زود للتقنية' }, { text: 'الإجمالي المستحق: 3,450.00 ر.س' }],
  scan: [{ text: '' }, { text: ' \n ' }],
  poster: [{ text: 'ملصق', size: [5000, 5000] }],
};

const bytesOf = (name: string): ArrayBuffer => new TextEncoder().encode(name).buffer as ArrayBuffer;

function linesOf(text: string): TextLineData[] {
  return text
    .split('\n')
    .map((line, i) => ({ text: line, x: 300, y: 100 + i * 40, width: 200, height: 16, direction: 'rtl' as const }));
}

function fakeDocument(name: string, log: string[], failOn?: 'extract_text'): ExportableDocument & { free(): Promise<void> } {
  const pages = FILES[name] ?? [];
  return {
    pageCount: pages.length,
    pageSizes: pages.map((page) => page.size ?? [595, 842]),
    extract_text: async (index) => {
      if (failOn === 'extract_text') throw new Error('E_PARSE: broken page');
      return pages[index]!.text;
    },
    text_lines: async (index) => linesOf(pages[index]!.text),
    paragraphs: async (): Promise<ParagraphData[]> => [],
    render_page: async (index, scale): Promise<RenderedPageData> => {
      log.push(`render ${index} at ${scale.toFixed(4)}`);
      const rgba = new Uint8ClampedArray(new ArrayBuffer(2 * 2 * 4)).fill(255);
      rgba[0] = rgba[1] = rgba[2] = 0;
      return { width: 2, height: 2, rgba };
    },
    free: async () => {
      log.push(`free ${name}`);
    },
  };
}

function source(current: string | null, options: { password?: string; failOn?: 'extract_text' } = {}) {
  const log: string[] = [];
  const src: ExportSource & { document: ExportableDocument } = {
    client: {
      open: async (bytes, password) => {
        const name = new TextDecoder().decode(bytes);
        log.push(`open ${name} with ${password ?? 'no password'}`);
        if (FILES[name] === undefined) throw Object.assign(new Error('E_PASSWORD: needs a password'), { code: 'E_PASSWORD' });
        return fakeDocument(name, log, options.failOn);
      },
    },
    currentFileBytes: async () => (current === null ? null : bytesOf(current)),
    documentPassword: options.password,
    // What Warraq opened: stale once EmbedPDF has changed the file.
    document: fakeDocument('original', log),
  };
  return { src, log };
}

const request = (format: ExportRequest['format'], extra: Partial<ExportRequest> = {}): ExportRequest => ({
  format,
  dpi: 150,
  name: 'فاتورة.pdf',
  pageLabel: (page) => `Page ${page}`,
  pagesWord: 'pages',
  ...extra,
});

describe('exporting the file as it is now', () => {
  it('reads the current bytes, never the copy Warraq opened, so redacted text stays out', async () => {
    const { src, log } = source('redacted', { password: 'كلمة' });
    for (const format of ['txt', 'md', 'html', 'docx'] as const) {
      const result = await exportCurrentFile(src, request(format));
      const text = format === 'docx' ? strFromU8(unzipSync(result!.bytes)['word/document.xml']!) : strFromU8(result!.bytes);
      expect(text, format).toContain('العميل');
      expect(text, format).not.toContain('فاتورة ضريبية مبسطة');
    }
    // Opened from the current bytes with the file's password, and freed each time.
    expect(log.filter((entry) => entry.startsWith('open'))).toEqual(Array(4).fill('open redacted with كلمة'));
    expect(log.filter((entry) => entry.startsWith('free'))).toEqual(Array(4).fill('free redacted'));
  });

  it('frees the temporary document when reading it fails', async () => {
    const { src, log } = source('redacted', { failOn: 'extract_text' });
    await expect(exportCurrentFile(src, request('txt'))).rejects.toThrow(/E_PARSE/);
    expect(log).toContain('free redacted');
  });

  it('says so when there is no file, and opens nothing', async () => {
    const { src, log } = source(null);
    await expect(exportCurrentFile(src, request('txt'))).rejects.toThrow(/E_NO_FILE/);
    expect(log).toEqual([]);
  });

  it('passes a password it is given instead of the one the file was opened with', async () => {
    const { src, log } = source('redacted', { password: 'old' });
    await exportCurrentFile(src, request('txt'), 'new');
    expect(log[0]).toBe('open redacted with new');
  });

  it('lets a wrong password surface as E_PASSWORD, for the panel to ask', async () => {
    const { src } = source('locked-in-protect');
    await expect(exportCurrentFile(src, request('txt'))).rejects.toMatchObject({ code: 'E_PASSWORD' });
  });
});

describe('what each format hands over', () => {
  it('names the file after the document, Arabic name and all', async () => {
    const { src } = source('redacted');
    const expected = {
      txt: ['فاتورة.txt', 'text/plain;charset=utf-8'],
      md: ['فاتورة.md', 'text/markdown;charset=utf-8'],
      html: ['فاتورة.html', 'text/html;charset=utf-8'],
      docx: ['فاتورة.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    } as const;
    for (const [format, [name, mime]] of Object.entries(expected)) {
      const result = await exportCurrentFile(src, request(format as ExportRequest['format']));
      expect(result?.fileName, format).toBe(name);
      expect(result?.kind.mime, format).toBe(mime);
      expect(result?.kind.filter.extensions, format).toEqual([format]);
    }
  });

  it('starts plain text with a byte-order mark and marks every page', async () => {
    const { src } = source('redacted');
    const result = await exportCurrentFile(src, request('txt'));
    expect([...result!.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(strFromU8(result!.bytes.subarray(3))).toBe(
      '— 1 —\n\nرقم الفاتورة: INV-2026-0042\nالعميل: شركة زود للتقنية\n\n— 2 —\n\nالإجمالي المستحق: 3,450.00 ر.س\n',
    );
  });

  it('reports each page as it goes', async () => {
    const { src } = source('redacted');
    const progress: string[] = [];
    await exportCurrentFile(src, request('md', { onProgress: (done, total) => progress.push(`${done}/${total}`) }));
    expect(progress).toEqual(['1/2', '2/2']);
  });

  it('writes no text file for a document without text', async () => {
    const { src, log } = source('scan');
    for (const format of ['txt', 'md', 'html', 'docx'] as const) {
      expect(await exportCurrentFile(src, request(format)), format).toBeNull();
    }
    expect(log.filter((entry) => entry.startsWith('free'))).toHaveLength(4);
  });
});

describe('page images', () => {
  it('draws every page at the chosen resolution, in one zip named for the pages', async () => {
    const { src, log } = source('redacted');
    const progress: number[] = [];
    const result = await exportCurrentFile(src, request('png', { dpi: 300, onProgress: (done) => progress.push(done) }));
    expect(result?.fileName).toBe('فاتورة (pages).zip');
    expect(result?.kind.mime).toBe('application/zip');
    expect(log.filter((entry) => entry.startsWith('render'))).toEqual(['render 0 at 4.1667', 'render 1 at 4.1667']);
    expect(progress).toEqual([1, 2]);
    const files = unzipSync(result!.bytes);
    expect(Object.keys(files)).toEqual(['فاتورة-1.png', 'فاتورة-2.png']);
    for (const png of Object.values(files)) expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(result?.reduced).toBe(false);
  });

  it('gives a one-page document a single PNG', async () => {
    const { src } = source('poster');
    const result = await exportCurrentFile(src, request('png', { dpi: 72 }));
    expect(result?.fileName).toBe('فاتورة.png');
    expect(result?.kind.mime).toBe('image/png');
    expect([...result!.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('draws a page too large for the resolution at one that fits, and says so', async () => {
    const { src, log } = source('poster');
    const result = await exportCurrentFile(src, request('png', { dpi: 300 }));
    const scale = Number(/at ([\d.]+)/.exec(log.find((entry) => entry.startsWith('render'))!)![1]);
    expect((5000 * scale) ** 2).toBeLessThanOrEqual(MAX_PAGE_PIXELS * 1.001);
    expect(scale).toBeLessThan(300 / 72);
    expect(result?.reduced).toBe(true);
  });
});
