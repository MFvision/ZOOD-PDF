import { describe, expect, it } from 'vitest';
import { assemble, needsRetrieval, retrievePassages } from './retrieval';

const pages = [
  { page: 1, text: 'l1\nl2\nl3\nl4\nl5\nl6\nl7' },
  { page: 2, text: 'm1\nm2\nm3\nm4\nm5' },
  { page: 3, text: 'n1\nn2' },
];

describe('assemble', () => {
  it('keeps the lines around each hit, in page order, with a gap between separate passages', () => {
    const { passages, pages: which } = assemble(pages, [{ page: 2, line: 1, text: 'm2' }, { page: 1, line: 5, text: 'l6' }], 1000);
    expect(which).toEqual([1, 2]);
    expect(passages[0]!.text).toBe('l4\nl5\nl6\nl7');
    expect(passages[1]!.text).toBe('m1\nm2\nm3\nm4');
  });

  it('joins passages that touch, and separates those that do not', () => {
    const { passages } = assemble(pages, [{ page: 1, line: 0, text: 'l1' }, { page: 1, line: 6, text: 'l7' }], 1000);
    expect(passages[0]!.text).toBe('l1\nl2\nl3\n…\nl5\nl6\nl7');
  });

  it('takes the best hits first, and stops at the budget', () => {
    const { passages, characters } = assemble(pages, [{ page: 3, line: 0, text: 'n1' }, { page: 1, line: 0, text: 'l1' }], 8);
    expect(passages).toEqual([{ page: 3, text: 'n1\nn2' }]);
    expect(characters).toBe(6);
  });

  it('falls back to the start of the document when nothing matched', () => {
    const { passages } = assemble(pages, [], 10);
    expect(passages).toEqual([{ page: 1, text: 'l1\nl2\nl3' }]);
  });

  it('ignores a hit on a line the page does not have', () => {
    expect(assemble(pages, [{ page: 9, line: 0, text: '' }, { page: 1, line: 99, text: '' }], 10).passages[0]!.text).toBe('l1\nl2\nl3');
  });
});

describe('retrievePassages', () => {
  it('opens an index of its own, adds the pages as text, searches the question, and closes it', async () => {
    const calls: string[] = [];
    const client = {
      async callStatic<T>(op: string, args: unknown): Promise<{ result: T; blobs: ArrayBuffer[] }> {
        calls.push(op);
        if (op === 'library.open') return { result: { handle: 7 } as T, blobs: [] };
        if (op === 'library.add') {
          const a = args as { handle: number; text: { page: number; text: string }[] };
          expect(a.handle).toBe(7);
          expect(a.text.map((p) => p.page)).toEqual([1, 2, 3]);
          return { result: { added: true } as T, blobs: [] };
        }
        if (op === 'library.search') {
          expect((args as { query: string }).query).toBe('m3?');
          return { result: { hits: [{ page: 2, line: 2, text: 'm3' }] } as T, blobs: [] };
        }
        return { result: {} as T, blobs: [] };
      },
    };
    const found = await retrievePassages(client, pages, 'm3?', 1000);
    expect(calls).toEqual(['library.open', 'library.add', 'library.search', 'library.close']);
    expect(found.passages).toEqual([{ page: 2, text: 'm1\nm2\nm3\nm4\nm5' }]);
  });

  it('says when the whole document does not fit', () => {
    expect(needsRetrieval(pages, 1000)).toBe(false);
    expect(needsRetrieval(pages, 10)).toBe(true);
  });
});
