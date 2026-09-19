import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createKind, createPdf, createdFileName, pdfDate, pictureKind } from './createPdf';
import type { CreateEnvironment, CreateFile } from './createPdf';

const fixture = (name: string): CreateFile => {
  const bytes = readFileSync(fileURLToPath(new URL(`../../../../tests/fixtures/create/${name}`, import.meta.url)));
  return { name, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
};

/** The core faked at its boundary: each call is logged, and answers with a one-page PDF named for it. */
function fakeCore(options: { decode?: boolean } = {}) {
  const calls: { op: string; args: Record<string, unknown>; blobs: number }[] = [];
  const env: CreateEnvironment = {
    async callStatic<T>(op: string, args: unknown, blobs: ArrayBuffer[]) {
      calls.push({ op, args: args as Record<string, unknown>, blobs: blobs.length });
      const pdf = new TextEncoder().encode(`%PDF-1.7 ${op}`).buffer as ArrayBuffer;
      if (op === 'create.images') return { result: { pages: blobs.length, leftOut: [] } as T, blobs: [pdf] };
      if (op === 'pages.combine') return { result: { pageCount: blobs.length } as T, blobs: [pdf] };
      return { result: { pages: 1, missingGlyphs: 0, picturesLeftOut: 0 } as T, blobs: [pdf] };
    },
    fonts: async () => [{ name: 'Amiri', bytes: new ArrayBuffer(4) }],
    decodePicture: async () => (options.decode ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) : null),
    now: new Date(Date.UTC(2026, 8, 19, 12, 0, 0)),
  };
  return { env, calls };
}

describe('what a file is', () => {
  it('knows Office files, pictures, web pages and text by their content, not only their name', () => {
    const kind = (name: string, renamed = name) => createKind(renamed, new Uint8Array(fixture(name).bytes));
    expect(kind('report-ar.docx', 'report.bin')).toBe('docx');
    expect(kind('budget-ar.xlsx', 'budget')).toBe('xlsx');
    expect(kind('slides-ar.pptx')).toBe('pptx');
    expect(kind('scan-2pages.tiff', 'scan.dat')).toBe('image');
    expect(kind('picture.webp')).toBe('image');
    expect(kind('page-ar.html', 'page.txt')).toBe('text');
    expect(kind('page-ar.html', 'page')).toBe('html');
    expect(kind('notes-ar.md')).toBe('markdown');
    expect(kind('cities-ar.csv')).toBe('csv');
    // A PDF is opened, not made; a binary file is neither.
    expect(createKind('x.pdf', new TextEncoder().encode('%PDF-1.7'))).toBeNull();
    expect(createKind('x.txt', new Uint8Array([1, 0, 2, 0]))).toBeNull();
    expect(pictureKind(new TextEncoder().encode('\0\0\0\x18ftypheic'))).toBe('browser');
  });

  it('names the new file after the first one, and dates it', () => {
    expect(createdFileName(['تقرير.docx'])).toBe('تقرير.pdf');
    expect(createdFileName(['a.png', 'b.png', 'c.png'])).toBe('a + 2.pdf');
    expect(pdfDate(new Date(Date.UTC(2026, 8, 19, 7, 5, 3)))).toBe('D:20260919070503Z');
  });
});

describe('making the PDF', () => {
  it('typesets a document with the faces and the page it says, in the right language', async () => {
    const { env, calls } = fakeCore();
    const result = await createPdf([fixture('report-ar.docx')], { paper: 'auto', orientation: 'auto', margin: 'small' }, env);
    expect(result.name).toBe('report-ar.pdf');
    expect(calls.map((c) => c.op)).toEqual(['create.document']);
    const args = calls[0]!.args as { page: { width: number }; lang: string; fonts: number[]; pictures: number[]; footer: unknown[] };
    expect(args.page.width).toBeCloseTo(595.3);
    expect(args.lang).toBe('ar');
    expect(args.fonts).toEqual([0]);
    expect(args.pictures).toEqual([1]);
    expect(args.footer.length).toBeGreaterThan(0);
    expect(calls[0]!.blobs).toBe(2);
  });

  it('turns paper as asked, but never a slide', async () => {
    const { env, calls } = fakeCore();
    await createPdf([fixture('notes-ar.md')], { paper: 'letter', orientation: 'landscape', margin: 'small' }, env);
    expect((calls[0]!.args as { page: { width: number; height: number } }).page).toMatchObject({ width: 792, height: 612 });
  });

  it('puts pictures in a row together, and joins every part in order', async () => {
    const { env, calls } = fakeCore();
    const result = await createPdf(
      [fixture('photo-rotated.jpg'), fixture('picture.gif'), fixture('notes-ar.txt'), fixture('scan-2pages.tiff')],
      { paper: 'a4', orientation: 'auto', margin: 'normal' },
      env,
    );
    expect(calls.map((c) => c.op)).toEqual(['create.images', 'create.document', 'create.images', 'pages.combine']);
    expect(calls[0]!.args).toMatchObject({ paper: { width: 595.28 }, margin: 36, orientation: 'auto' });
    expect(calls[0]!.blobs).toBe(2);
    expect(calls[3]!.blobs).toBe(3);
    expect(result.name).toBe('photo-rotated + 3.pdf');
  });

  it('names what it could not read, and makes the rest', async () => {
    const { env } = fakeCore();
    const broken: CreateFile = { name: 'broken.docx', bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]).buffer };
    const heic: CreateFile = { name: 'photo.heic', bytes: new TextEncoder().encode('\0\0\0\x18ftypheic').buffer as ArrayBuffer };
    const result = await createPdf([broken, heic, fixture('notes-ar.txt')], { paper: 'auto', orientation: 'auto', margin: 'small' }, env);
    expect(result.report.unreadable).toEqual(['broken.docx', 'photo.heic']);
    await expect(createPdf([broken], { paper: 'auto', orientation: 'auto', margin: 'small' }, env)).rejects.toThrow(/E_CREATE/);
  });

  it('takes a picture only a browser reads once the browser has made it a PNG', async () => {
    const { env, calls } = fakeCore({ decode: true });
    const heic: CreateFile = { name: 'photo.heic', bytes: new TextEncoder().encode('\0\0\0\x18ftypheic').buffer as ArrayBuffer };
    const result = await createPdf([heic], { paper: 'auto', orientation: 'auto', margin: 'small' }, env);
    expect(result.report.unreadable).toEqual([]);
    expect(calls.map((c) => c.op)).toEqual(['create.images']);
  });
});
