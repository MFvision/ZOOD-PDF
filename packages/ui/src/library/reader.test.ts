import { describe, expect, it, vi } from 'vitest';
import type { ReadDocument } from '../create/blocks';
import { LEDGER_LIMIT, memoryLedger, shortHash, unchanged } from './ledger';
import { boundPages, documentPages, wordsAsText } from './pageText';
import { ReaderBusy, inlineReader, startReader, workerReader } from './reader';
import type { WorkerAnswer, WorkerJob } from './ingest.worker';
import { doWork, hashBytes, thumbnailOf, thumbnailSize } from './work';

/**
 * A worker that answers whatever the test tells it to, so the deadline and
 * the restart after one can be proven without a browser.
 */
class FakeWorker {
  onmessage: ((event: { data: WorkerAnswer }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly jobs: WorkerJob[] = [];
  terminated = false;

  constructor(private readonly answer: (job: WorkerJob, self: FakeWorker) => void) {}

  postMessage(job: WorkerJob): void {
    this.jobs.push(job);
    this.answer(job, this);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(answer: WorkerAnswer): void {
    this.onmessage?.({ data: answer });
  }
}

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe('the reader worker', () => {
  it('runs a job and gives the answer back', async () => {
    const made: FakeWorker[] = [];
    const reader = workerReader(() => {
      const worker = new FakeWorker((job, self) => setTimeout(() => self.reply({ id: job.id, ok: true, reply: { job: 'hash', hash: 'abcd' } }), 0));
      made.push(worker);
      return worker as unknown as Worker;
    });
    await expect(reader.work({ job: 'hash', bytes: bytesOf('x') })).resolves.toEqual({ job: 'hash', hash: 'abcd' });
    expect(made).toHaveLength(1);
    reader.close();
    expect(made[0]!.terminated).toBe(true);
  });

  it('hands a failure on as an error, with the worker still running', async () => {
    const made: FakeWorker[] = [];
    const reader = workerReader(() => {
      const worker = new FakeWorker((job, self) => setTimeout(() => self.reply({ id: job.id, ok: false, message: 'E_ZIP: broken' }), 0));
      made.push(worker);
      return worker as unknown as Worker;
    });
    await expect(reader.work({ job: 'hash', bytes: bytesOf('x') })).rejects.toThrow('E_ZIP');
    await expect(reader.work({ job: 'hash', bytes: bytesOf('y') })).rejects.toThrow('E_ZIP');
    expect(made).toHaveLength(1);
    reader.close();
  });

  it('drops a worker that never answers, and starts another for the next file', async () => {
    vi.useFakeTimers();
    try {
      const made: FakeWorker[] = [];
      const reader = workerReader(() => {
        // The first worker says nothing at all; the second answers.
        const first = made.length === 0;
        const worker = new FakeWorker((job, self) => {
          if (!first) setTimeout(() => self.reply({ id: job.id, ok: true, reply: { job: 'hash', hash: 'ok' } }), 0);
        });
        made.push(worker);
        return worker as unknown as Worker;
      }, 50);
      const hung = reader.work({ job: 'hash', bytes: bytesOf('x') });
      const caught = hung.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(60);
      expect(await caught).toBeInstanceOf(ReaderBusy);
      expect(made[0]!.terminated).toBe(true);
      const next = reader.work({ job: 'hash', bytes: bytesOf('y') });
      await vi.advanceTimersByTimeAsync(1);
      await expect(next).resolves.toEqual({ job: 'hash', hash: 'ok' });
      expect(made).toHaveLength(2);
      reader.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses work once it is closed', async () => {
    const reader = inlineReader();
    reader.close();
    await expect(reader.work({ job: 'hash', bytes: bytesOf('x') })).rejects.toThrow('E_READER');
  });

  it('does the work in this thread where the host has no worker at all', async () => {
    expect(typeof Worker).not.toBe('function');
    const reader = startReader();
    const reply = await reader.work({ job: 'hash', bytes: bytesOf('التقرير') });
    expect(reply.job === 'hash' && reply.hash).toHaveLength(64);
    reader.close();
  });
});

describe('the jobs themselves', () => {
  it('hashes bytes the same way every time, and differently for different bytes', async () => {
    const one = await hashBytes(bytesOf('التقرير'));
    expect(one).toHaveLength(64);
    expect(await hashBytes(bytesOf('التقرير'))).toBe(one);
    expect(await hashBytes(bytesOf('التقرير.'))).not.toBe(one);
  });

  it('cleans a page up and measures how crooked it is, in one job', async () => {
    // A page of paper with a row of ink across it: straight, so no turn.
    const [width, height] = [60, 40];
    const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let x = 5; x < 55; x += 1) {
      for (let y = 18; y < 22; y += 1) {
        const at = (y * width + x) * 4;
        rgba[at] = rgba[at + 1] = rgba[at + 2] = 0;
      }
    }
    const worked = await doWork({
      job: 'prepare',
      page: { width, height, rgba: rgba.buffer as ArrayBuffer },
      cleanup: { background: false, contrast: true, binarize: false, despeckle: false, borders: false },
      dpi: 150,
    });
    expect(worked.reply.job).toBe('prepare');
    if (worked.reply.job !== 'prepare') return;
    expect(worked.reply.angle).toBe(0);
    expect(worked.reply.page.rgba.byteLength).toBe(width * height * 4);
    // The pixels come back to be handed on, not copied.
    expect(worked.transfer).toEqual([worked.reply.page.rgba]);
  });

  it('sizes a thumbnail by its longer side, and never enlarges a small page', () => {
    expect(thumbnailSize(1000, 1400, 192)).toEqual({ width: 137, height: 192 });
    expect(thumbnailSize(1400, 1000, 192)).toEqual({ width: 192, height: 137 });
    expect(thumbnailSize(100, 50, 192)).toEqual({ width: 100, height: 50 });
    expect(thumbnailSize(0, 0, 192)).toEqual({ width: 0, height: 0 });
  });

  it('draws no thumbnail where there is no canvas, rather than failing', async () => {
    expect(typeof OffscreenCanvas).not.toBe('function');
    await expect(thumbnailOf({ width: 4, height: 4, rgba: new ArrayBuffer(64) }, 192)).resolves.toEqual({ image: null, mime: 'image/jpeg' });
  });
});

describe('what the Library writes down about a file', () => {
  const mark = { size: 10, modified: 5, hash: shortHash('a'.repeat(64)), indexed: 1 };

  it('calls a file unchanged only when its size, its date and its content all agree', () => {
    expect(unchanged(mark, { size: 10, modified: 5 }, 'a'.repeat(64))).toBe(true);
    expect(unchanged(mark, { size: 11, modified: 5 }, 'a'.repeat(64))).toBe(false);
    expect(unchanged(mark, { size: 10, modified: 6 }, 'a'.repeat(64))).toBe(false);
    expect(unchanged(mark, { size: 10, modified: 5 }, 'b'.repeat(64))).toBe(false);
    expect(unchanged(undefined, { size: 10, modified: 5 }, 'a'.repeat(64))).toBe(false);
    // With no digest on this platform nothing is ever called unchanged.
    expect(unchanged(mark, { size: 10, modified: 5 }, '')).toBe(false);
  });

  it('forgets a file when asked, and keeps only as many as it may', () => {
    const ledger = memoryLedger();
    ledger.remember('/a', mark);
    expect(ledger.mark('/a')).toBeDefined();
    ledger.forget(['/a']);
    expect(ledger.mark('/a')).toBeUndefined();
    for (let k = 0; k < LEDGER_LIMIT + 20; k += 1) ledger.remember(`/f${k}`, { ...mark, indexed: k });
    expect(Object.keys(ledger.all())).toHaveLength(LEDGER_LIMIT);
    // The oldest went first.
    expect(ledger.mark('/f0')).toBeUndefined();
    expect(ledger.mark(`/f${LEDGER_LIMIT + 19}`)).toBeDefined();
    ledger.clear();
    expect(Object.keys(ledger.all())).toHaveLength(0);
  });
});

describe('a document turned into the pages the index takes', () => {
  const read = (blocks: ReadDocument['blocks'], over: Partial<ReadDocument> = {}): ReadDocument => ({
    blocks,
    pictures: [],
    picturesLeftOut: 0,
    truncated: false,
    ...over,
  });

  it('starts a new page at a break and at a page of its own size, numbering from one', () => {
    const { pages } = documentPages(
      read([
        { type: 'text', text: 'الأولى' },
        { type: 'pageBreak' },
        { type: 'text', text: 'الثانية' },
        { type: 'page', width: 720, height: 540 },
        { type: 'text', text: 'الثالثة' },
      ]),
    );
    expect(pages).toEqual([
      { page: 1, text: 'الأولى' },
      { page: 2, text: 'الثانية' },
      { page: 3, text: 'الثالثة' },
    ]);
  });

  it('takes a table cell for cell, and the title and running head once', () => {
    const { pages } = documentPages(
      read([{ type: 'table', rows: [[{ text: 'الصنف' }, { text: 'العدد' }]] }], {
        title: 'التقرير',
        header: [{ type: 'text', text: 'ورّاق' }],
      }),
    );
    expect(pages[0]!.text).toBe('التقرير\nورّاق\nالصنف\tالعدد');
  });

  it('leaves out what is past its bounds, and says it did', () => {
    const many = Array.from({ length: 4 }, (_, k) => ({ page: k + 1, text: 'abcdefghij' }));
    expect(boundPages(many, { pages: 2, charsPerPage: 4, chars: 100 })).toEqual({
      pages: [
        { page: 1, text: 'abcd' },
        { page: 2, text: 'abcd' },
      ],
      truncated: true,
    });
    expect(boundPages(many, { pages: 9, charsPerPage: 99, chars: 15 }).pages).toEqual([
      { page: 1, text: 'abcdefghij' },
      { page: 2, text: 'abcde' },
    ]);
    // A page with nothing on it is no page at all.
    expect(boundPages([{ page: 1, text: '   ' }], { pages: 9, charsPerPage: 9, chars: 9 }).pages).toEqual([]);
  });

  it('puts the words Tesseract read back into lines', () => {
    expect(wordsAsText([{ text: 'المصدر ' }, { text: 'يعمل' }, { text: 'دون ' }, { text: 'حساب' }])).toBe('المصدر يعمل\nدون حساب');
  });
});
