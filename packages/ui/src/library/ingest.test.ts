import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CoreClient, RemoteDocument } from '../core/client';
import { CoreClientError } from '../core/client';
import { INGEST_LIMITS, ingestFiles } from './ingest';
import type { IngestedFile, LibraryFile } from './ingest';
import { sourceKind } from './kinds';
import { memoryLedger } from './ledger';
import { ReaderBusy, inlineReader } from './reader';
import type { Reader } from './reader';

/** A file of `tests/fixtures/create` (made by its `make_fixtures.py`). */
const fixtureBytes = (name: string): ArrayBuffer => {
  const bytes = readFileSync(fileURLToPath(new URL(`../../../../tests/fixtures/create/${name}`, import.meta.url)));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

/**
 * A stand-in PDF: the header a sniffer looks for, and the pages' text after
 * it, so the fake core can answer `extract_text` without a real engine. The
 * real thing is read by the core in the e2e.
 */
function fakePdf(pages: readonly string[], password?: string): ArrayBuffer {
  return new TextEncoder().encode(`%PDF-1.7\n${JSON.stringify({ pages, password })}`).buffer as ArrayBuffer;
}

interface CoreCall {
  op: string;
  args: Record<string, unknown>;
}

/** The core faked at its boundary: it reads the stand-in PDFs and logs every op. */
function fakeCore(options: { images?: number } = {}) {
  const calls: CoreCall[] = [];
  const opened: { password?: string }[] = [];
  const rendered: number[] = [];
  let handles = 0;
  const client: Pick<CoreClient, 'open' | 'callStatic'> = {
    async open(bytes, password) {
      const text = new TextDecoder().decode(bytes instanceof ArrayBuffer ? bytes : bytes.buffer);
      const body = JSON.parse(text.slice(text.indexOf('\n') + 1)) as { pages: string[]; password?: string };
      if (body.password && body.password !== password) throw new CoreClientError('E_PASSWORD', 'a password is needed');
      opened.push({ password });
      handles += 1;
      const doc = {
        id: handles,
        pageCount: body.pages.length,
        pageSizes: body.pages.map(() => [595, 842] as const),
        extract_text: (index: number) => Promise.resolve(body.pages[index] ?? ''),
        render_page: (index: number) => {
          rendered.push(index);
          return Promise.resolve({ width: 8, height: 11, rgba: new Uint8ClampedArray(8 * 11 * 4) });
        },
        free: () => Promise.resolve(),
      };
      return doc as unknown as RemoteDocument;
    },
    async callStatic<T>(op: string, args: unknown) {
      calls.push({ op, args: args as Record<string, unknown> });
      if (op === 'create.images') {
        const pages = options.images ?? 1;
        return { result: { pages, leftOut: [] } as T, blobs: [fakePdf(Array.from({ length: pages }, () => ''))] };
      }
      const add = args as { text?: { page: number; text: string }[]; pages?: number };
      const chars = (add.text ?? []).reduce((sum, page) => sum + page.text.length, 0);
      return { result: { added: true, pages: add.pages ?? 0, chars } as T, blobs: [] };
    },
  };
  return { client, calls, opened, rendered, added: () => calls.filter((call) => call.op === 'library.add') };
}

const file = (name: string, bytes: ArrayBuffer, over: Partial<LibraryFile> = {}): LibraryFile => ({
  key: `/library/${name}`,
  name,
  size: bytes.byteLength,
  modified: 1_700_000_000_000,
  read: () => Promise.resolve(bytes.slice(0)),
  ...over,
});

/** One run, with the reader in this thread and no recognition (Tesseract needs a browser). */
async function ingest(files: readonly LibraryFile[], over: Partial<Parameters<typeof ingestFiles>[0]> = {}) {
  const core = over.client ? null : fakeCore();
  const run = await ingestFiles({
    handle: 7,
    files,
    client: over.client ?? core!.client,
    recognize: false,
    reader: inlineReader(),
    ledger: memoryLedger(),
    ...over,
  });
  return { run, core: core! };
}

const textOf = (call: CoreCall): string =>
  ((call.args.text ?? []) as { text: string }[]).map((page) => page.text).join('\n');

describe('what a file in the Library is', () => {
  it('knows PDFs, Office files, pictures, web pages and text by their content', () => {
    const kind = (name: string, renamed = name) => sourceKind(renamed, new Uint8Array(fixtureBytes(name)));
    expect(sourceKind('anything.bin', new Uint8Array(fakePdf(['x'])))).toBe('pdf');
    expect(kind('report-ar.docx', 'report.bin')).toBe('docx');
    expect(kind('budget-ar.xlsx')).toBe('xlsx');
    expect(kind('slides-ar.pptx')).toBe('pptx');
    expect(kind('scan-invoice.tiff', 'scan.dat')).toBe('image');
    expect(kind('photo-rotated.jpg')).toBe('image');
    expect(kind('page-ar.html')).toBe('html');
    expect(kind('notes-ar.md')).toBe('markdown');
    expect(kind('notes-ar.txt')).toBe('text');
    expect(kind('cities-ar.csv')).toBe('csv');
    // Nothing the Library reads: a binary file with no signature it knows.
    expect(sourceKind('x.bin', new Uint8Array([1, 0, 2, 0, 7]))).toBeNull();
  });
});

describe('each kind read into the text the index takes', () => {
  it('reads a Word document — its title, its headings and its table', async () => {
    const { run, core } = await ingest([file('report-ar.docx', fixtureBytes('report-ar.docx'))]);
    expect(run.added).toBe(1);
    const [add] = core.added();
    expect(add!.args.kind).toBe('word');
    expect(add!.args.handle).toBe(7);
    expect(add!.args.key).toBe('/library/report-ar.docx');
    const text = textOf(add!);
    expect(text).toContain('التقرير السنوي لمكتبة ورّاق');
    expect(text).toContain('مقدمة');
    // A table's cells come through, parted so two words never run together.
    expect(text).toContain('الصنف');
    expect(text).toContain('المجموع');
    expect(run.files[0]!.chars).toBeGreaterThan(200);
  });

  it('reads a spreadsheet, a presentation, a web page, Markdown, text and CSV', async () => {
    const kinds: [string, string, string][] = [
      ['budget-ar.xlsx', 'excel', 'الميزانية'],
      ['slides-ar.pptx', 'powerpoint', 'عرض مكتبة ورّاق'],
      ['page-ar.html', 'html', 'صفحة ورّاق'],
      ['notes-ar.md', 'markdown', 'ملاحظات'],
      ['notes-ar.txt', 'text', 'هذا نص عادي بالعربية'],
      ['cities-ar.csv', 'text', 'الرياض'],
    ];
    for (const [name, kind, word] of kinds) {
      const { run, core } = await ingest([file(name, fixtureBytes(name))]);
      expect(run.added, name).toBe(1);
      const [add] = core.added();
      expect(add!.args.kind, name).toBe(kind);
      expect(textOf(add!), name).toContain(word);
    }
  });

  it('gives a presentation a page for each slide, so a hit points at the right one', async () => {
    const { core } = await ingest([file('slides-ar.pptx', fixtureBytes('slides-ar.pptx'))]);
    const pages = (core.added()[0]!.args.text ?? []) as { page: number }[];
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.map((page) => page.page)).toEqual([...pages.map((page) => page.page)].sort((a, b) => a - b));
    expect(pages[0]!.page).toBe(1);
  });

  it('reads a PDF page by page with the core, and numbers the pages from one', async () => {
    const bytes = fakePdf(['أول صفحة من التقرير', 'الصفحة الثانية']);
    const { run, core } = await ingest([file('report.pdf', bytes)]);
    expect(run.added).toBe(1);
    const [add] = core.added();
    expect(add!.args.kind).toBe('pdf');
    expect(add!.args.pages).toBe(2);
    expect(add!.args.text).toEqual([
      { page: 1, text: 'أول صفحة من التقرير' },
      { page: 2, text: 'الصفحة الثانية' },
    ]);
  });

  it('calls a PDF whose pages carry no text a scan, and still indexes it', async () => {
    const { run, core } = await ingest([file('scan.pdf', fakePdf(['', '']))]);
    expect(run.added).toBe(1);
    const [add] = core.added();
    // A scan with no text layer must still be found by the filter for exactly that.
    expect(add!.args.kind).toBe('scan');
    expect(add!.args.text).toEqual([]);
    expect(add!.args.pages).toBe(2);
  });

  it('makes a picture a PDF through Create PDF, and indexes it as a picture', async () => {
    const bytes = fixtureBytes('scan-invoice.tiff');
    const { run, core } = await ingest([file('scan-invoice.tiff', bytes)]);
    expect(run.added).toBe(1);
    expect(core.calls.map((call) => call.op)).toEqual(['create.images', 'library.add']);
    expect(core.added()[0]!.args.kind).toBe('image');
  });

  it('indexes every page of a multi-page picture', async () => {
    const core = fakeCore({ images: 2 });
    const run = await ingestFiles({
      handle: 1,
      files: [file('scan-2pages.tiff', fixtureBytes('scan-2pages.tiff'))],
      client: core.client,
      recognize: false,
      reader: inlineReader(),
      ledger: memoryLedger(),
    });
    expect(run.added).toBe(1);
    expect(core.added()[0]!.args.pages).toBe(2);
  });
});

describe('what the run costs and what it remembers', () => {
  it('does not read a file again whose size, date and content are unchanged', async () => {
    const ledger = memoryLedger();
    const bytes = fixtureBytes('notes-ar.txt');
    const only = [file('notes-ar.txt', bytes)];
    const first = await ingest(only, { ledger });
    expect(first.run.added).toBe(1);
    const again = await ingest(only, { ledger });
    expect(again.run.added).toBe(0);
    expect(again.run.files[0]!.skipped).toBe('unchanged');
    expect(again.core.calls).toEqual([]);
    // Changed on disk — a different date and different bytes — and it is read again.
    const changed = [file('notes-ar.txt', fixtureBytes('notes-ar.md'), { modified: 1_800_000_000_000 })];
    expect((await ingest(changed, { ledger })).run.added).toBe(1);
  });

  it('stops where it is asked to and resumes there, without reading what was done', async () => {
    const controller = new AbortController();
    const ledger = memoryLedger();
    const files = ['notes-ar.txt', 'notes-ar.md', 'cities-ar.csv'].map((name) => file(name, fixtureBytes(name)));
    const stopped = await ingest(files, {
      ledger,
      signal: controller.signal,
      onFile: () => controller.abort(),
    });
    expect(stopped.run.added).toBe(1);
    expect(stopped.run.remaining).toEqual([files[1]!.key, files[2]!.key]);

    // Given the whole list again, the one that finished is skipped, not redone.
    const resumed = await ingest(files, { ledger });
    expect(resumed.run.added).toBe(2);
    expect(resumed.run.files.map((f) => f.skipped)).toEqual(['unchanged', undefined, undefined]);
  });

  it('draws a thumbnail of the first page, and never of a file that needed a password', async () => {
    const plain = await ingest([file('a.pdf', fakePdf(['نص']))]);
    expect(plain.core.rendered).toEqual([0]);
    const locked = await ingest([file('b.pdf', fakePdf(['نص'], 'secret'), { password: 'secret' })]);
    expect(locked.run.added).toBe(1);
    expect(locked.core.rendered).toEqual([]);
    expect(locked.core.opened.map((o) => o.password)).toEqual(['secret']);
  });

  it('says how far it has got, per file and per page', async () => {
    const seen: string[] = [];
    await ingest([file('a.pdf', fakePdf(['one', 'two']))], {
      onProgress: (progress) => seen.push(`${progress.file}/${progress.of} ${progress.stage}${progress.page ? ` p${progress.page}/${progress.pages}` : ''}`),
    });
    expect(seen).toContain('1/1 reading p1/2');
    expect(seen).toContain('1/1 reading p2/2');
    expect(seen).toContain('1/1 indexing');
  });
});

describe('every file is hostile input', () => {
  const carriesOn = (run: { files: IngestedFile[]; added: number }) => {
    expect(run.added).toBe(1);
    expect(run.files).toHaveLength(2);
  };

  it('skips a file the core refuses, with its reason, and carries on', async () => {
    const corrupt = file('corrupt.pdf', new TextEncoder().encode('%PDF-1.7\nnot a document at all').buffer as ArrayBuffer);
    const { run } = await ingest([corrupt, file('ok.txt', fixtureBytes('notes-ar.txt'))]);
    carriesOn(run);
    expect(run.files[0]!.added).toBe(false);
    expect(run.files[0]!.skipped).toBe('unreadable');
    expect(run.failed).toBe(1);
  });

  it('skips something that only looks like an Office file, and carries on', async () => {
    const zipSignature = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00]);
    const { run } = await ingest([file('broken.docx', zipSignature.buffer as ArrayBuffer), file('ok.txt', fixtureBytes('notes-ar.txt'))]);
    carriesOn(run);
    expect(run.files[0]!.skipped).toBe('unsupported');
  });

  it('skips a file it cannot even open, and one whose password it does not have', async () => {
    const unreadable = file('gone.pdf', new ArrayBuffer(0), { read: () => Promise.reject(new Error('E_IO: no such file')) });
    const locked = file('locked.pdf', fakePdf(['نص'], 'secret'));
    const { run } = await ingest([unreadable, locked, file('ok.txt', fixtureBytes('notes-ar.txt'))]);
    expect(run.files.map((f) => f.skipped)).toEqual(['unreadable', 'needsPassword', undefined]);
    expect(run.added).toBe(1);
  });

  it('will not read a file larger than the bound, and reads nothing of it', async () => {
    const huge = file('huge.pdf', fakePdf(['نص']), { read: () => Promise.resolve(new ArrayBuffer(INGEST_LIMITS.bytes + 1)) });
    const { run, core } = await ingest([huge, file('ok.txt', fixtureBytes('notes-ar.txt'))]);
    carriesOn(run);
    expect(run.files[0]!.skipped).toBe('tooLarge');
    expect(core.opened).toEqual([]);
  });

  it('drops a reader that will not finish, and carries on with the next file', async () => {
    const inline = inlineReader();
    const slow: Reader = {
      work: (request) => (request.job === 'read' ? Promise.reject(new ReaderBusy()) : inline.work(request)),
      close: () => inline.close(),
    };
    const { run } = await ingest([file('a.md', fixtureBytes('notes-ar.md')), file('b.pdf', fakePdf(['نص']))], { reader: slow });
    expect(run.files[0]!.skipped).toBe('tooSlow');
    expect(run.added).toBe(1);
  });

  it('keeps only as many pages and characters of one file as the bounds allow', async () => {
    const many = Array.from({ length: 40 }, (_, k) => `صفحة ${k + 1} من الملف الطويل`);
    const { run, core } = await ingest([file('long.pdf', fakePdf(many))], {
      limits: { text: { pages: 5, charsPerPage: 10, chars: 30 } },
    });
    const pages = (core.added()[0]!.args.text ?? []) as { text: string }[];
    expect(pages.length).toBeLessThanOrEqual(5);
    expect(pages.every((page) => page.text.length <= 10)).toBe(true);
    expect(pages.reduce((sum, page) => sum + page.text.length, 0)).toBeLessThanOrEqual(30);
    expect(run.files[0]!.truncated).toBe(true);
  });

  it('says so when the core refuses the file, and does not write it down as read', async () => {
    const ledger = memoryLedger();
    const core = fakeCore();
    const refusing: Pick<CoreClient, 'open' | 'callStatic'> = {
      open: core.client.open,
      callStatic: (op, args, blobs) =>
        op === 'library.add'
          ? Promise.reject(new CoreClientError('E_INDEX', 'the index is full'))
          : core.client.callStatic(op, args, blobs),
    };
    const one = [file('a.pdf', fakePdf(['نص']))];
    const run = await ingestFiles({ handle: 1, files: one, client: refusing, recognize: false, reader: inlineReader(), ledger });
    expect(run.files[0]!.skipped).toBe('notIndexed');
    expect(run.files[0]!.problem).toBe('E_INDEX');
    expect(ledger.mark(one[0]!.key)).toBeUndefined();
  });
});
