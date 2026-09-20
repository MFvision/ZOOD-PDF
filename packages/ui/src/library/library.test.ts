import { describe, expect, it } from 'vitest';
import { LIBRARY_ACCEPT, folderOfKey, kindOfName, readableFile } from './kinds';
import { badRange, filterCount, noFilters, toFilters, toggle } from './filters';
import { markSpans, snippet } from './snippet';
import { addRule, applyRules, parseTags, removeRule } from './rules';
import { indexFiles, unchanged } from './run';
import type { FileState } from './run';
import { emptyMeta, memoryStore, tidyMeta } from './store';
import { sourcesFromFiles } from './sources';
import type { Ingest, IngestSource } from './ingest';
import type { LibraryKind, LibraryOps, SearchHit } from './ops';
import type { FileRecord } from './store';

/**
 * The Library panel's own logic, away from the screen: what a hit's line
 * looks like once its matches are marked, what the filters ask the core for,
 * which files a run reads and which it leaves alone, and what the tag rules
 * do. The core itself is faked here — its behaviour is proven by its own
 * tests — so these say exactly what the panel does with the answers.
 */

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
  key: 'f/one.pdf',
  name: 'one.pdf',
  page: 1,
  line: 0,
  text: 'فاتورة رقم ١٢',
  spans: [[0, 6]],
  score: 1,
  date: undefined,
  kind: 'pdf',
  tags: [],
  ...over,
});

type Fake = LibraryOps & { added: string[]; tags: Map<string, string[]>; hits: SearchHit[]; failOn?: string };

/** A core that remembers what it was told, enough for the panel to be driven. */
function fakeOps(): Fake {
  const fake: Fake = {
    added: [],
    tags: new Map<string, string[]>(),
    hits: [],
    failOn: undefined,
    open: () => Promise.resolve({ handle: 1, documents: 0, words: 0 }),
    add: (_handle, request) => {
      if (fake.failOn === request.key) return Promise.reject(new Error('E_READ: broken'));
      if (request.name.includes('locked')) {
        return Promise.resolve({ added: false, skipped: 'password', pages: 0, chars: 0, guessedKind: request.kind });
      }
      fake.added.push(request.key);
      const guessed: LibraryKind = request.kind === 'pdf' && request.name.includes('scan') ? 'scan' : request.kind;
      return Promise.resolve({ added: true, pages: 2, chars: 100, guessedKind: guessed });
    },
    forget: (_handle, keys) => {
      for (const key of keys) fake.tags.delete(key);
      return Promise.resolve({ documents: fake.added.length - keys.length });
    },
    search: (_handle, query, options) => {
      const all = fake.hits.filter((one) => one.text.includes(query)).map((one) => ({ ...one, tags: fake.tags.get(one.key) ?? one.tags }));
      const from = options?.offset ?? 0;
      return Promise.resolve({ total: all.length, hits: all.slice(from, from + (options?.limit ?? 25)) });
    },
    document: (_handle, key) =>
      Promise.resolve({ key, name: key, kind: 'pdf', pages: 1, chars: 1, tags: fake.tags.get(key) ?? [], indexed: 0, modified: 0 }),
    tag: (_handle, key, change) => {
      const now = new Set(fake.tags.get(key) ?? []);
      for (const one of change.add ?? []) now.add(one);
      for (const one of change.remove ?? []) now.delete(one);
      fake.tags.set(key, [...now]);
      return Promise.resolve({ tags: [...now] });
    },
    stats: () => Promise.resolve({ documents: fake.added.length, pages: 0, words: 0, bytes: 0, kinds: {}, tags: {} }),
    save: () => Promise.resolve({ bytes: 4, data: new ArrayBuffer(4) }),
    close: () => Promise.resolve(),
  };
  return fake;
}

const source = (name: string, over: Partial<IngestSource> = {}): IngestSource => ({
  key: `folder/${name}`,
  name,
  size: 10,
  modified: 1000,
  bytes: () => Promise.resolve(new ArrayBuffer(4)),
  ...over,
});

const pdfIngest: Ingest = (one) =>
  Promise.resolve(
    one.name.endsWith('.pdf')
      ? { read: 'bytes', kind: 'pdf', bytes: new ArrayBuffer(4) }
      : { read: 'skipped', reason: 'reader' },
  );

describe('marking the words a search matched', () => {
  it('marks a span counted in characters, not in bytes', () => {
    // "فاتورة" is six letters and twelve bytes: a byte offset would mark the
    // wrong half of the line, which is the whole reason spans are characters.
    expect(markSpans('فاتورة رقم ١٢', [[0, 6]])).toEqual([
      { text: 'فاتورة', match: true },
      { text: ' رقم ١٢', match: false },
    ]);
    expect(markSpans('the invoice number', [[4, 7]])).toEqual([
      { text: 'the ', match: false },
      { text: 'invoice', match: true },
      { text: ' number', match: false },
    ]);
  });

  it('merges spans that touch or overlap, and keeps them in order', () => {
    expect(markSpans('abcdefgh', [[4, 2], [0, 2], [1, 2]])).toEqual([
      { text: 'abc', match: true },
      { text: 'd', match: false },
      { text: 'ef', match: true },
      { text: 'gh', match: false },
    ]);
  });

  it('clamps anything the index says that the line cannot hold', () => {
    expect(markSpans('short', [[3, 99]])).toEqual([
      { text: 'sho', match: false },
      { text: 'rt', match: true },
    ]);
    expect(markSpans('short', [[9, 2]])).toEqual([{ text: 'short', match: false }]);
    expect(markSpans('short', [[-4, 2]])).toEqual([{ text: 'sh', match: true }, { text: 'ort', match: false }]);
    expect(markSpans('short', [])).toEqual([{ text: 'short', match: false }]);
    expect(markSpans('', [[0, 3]])).toEqual([]);
  });

  it('cuts a long line to a window around the first match', () => {
    const line = `${'a'.repeat(200)}فاتورة${'b'.repeat(200)}`;
    const cut = snippet(line, [[200, 6]], { before: 10, after: 20 });
    expect(cut.cutStart).toBe(true);
    expect(cut.cutEnd).toBe(true);
    expect(cut.parts.filter((part) => part.match).map((part) => part.text)).toEqual(['فاتورة']);
    expect(cut.parts.map((part) => part.text).join('')).toBe(`${'a'.repeat(10)}فاتورة${'b'.repeat(14)}`);
  });

  it('leaves a short line whole', () => {
    const cut = snippet('فاتورة رقم ١٢', [[0, 6]]);
    expect(cut.cutStart).toBe(false);
    expect(cut.cutEnd).toBe(false);
    expect(cut.parts.map((part) => part.text).join('')).toBe('فاتورة رقم ١٢');
  });
});

describe('what the filters ask the core for', () => {
  it('asks for nothing while nothing is set', () => {
    expect(toFilters(noFilters())).toBeUndefined();
    expect(filterCount(noFilters())).toBe(0);
  });

  it('sends only the filters that are really set', () => {
    const state = { ...noFilters(), kinds: ['scan' as LibraryKind], from: '2020-01-01', to: '20', scannedOnly: true };
    expect(toFilters(state)).toEqual({ kinds: ['scan'], from: '2020-01-01', scannedOnly: true });
    expect(filterCount(state)).toBe(3);
  });

  it('shows a range typed the wrong way round instead of sending it', () => {
    expect(badRange({ ...noFilters(), from: '2024-05-01', to: '2024-01-01' })).toBe(true);
    expect(badRange({ ...noFilters(), from: '2024-01-01', to: '2024-05-01' })).toBe(false);
  });

  it('turns one item of a filter on and off again', () => {
    expect(toggle(['pdf'], 'scan')).toEqual(['pdf', 'scan']);
    expect(toggle(['pdf', 'scan'], 'pdf')).toEqual(['scan']);
  });
});

describe('the kinds of file the Library reads', () => {
  it('knows a file by its name, and leaves the rest alone', () => {
    expect(kindOfName('report.PDF')).toBe('pdf');
    expect(kindOfName('photo.jpeg')).toBe('image');
    expect(kindOfName('sheet.xlsx')).toBe('excel');
    expect(kindOfName('notes.md')).toBe('markdown');
    expect(kindOfName('archive.zip')).toBeNull();
    expect(readableFile('archive.zip')).toBe(false);
    expect(LIBRARY_ACCEPT).toContain('.pdf');
  });

  it('reads a key back as the folder it came from', () => {
    expect(folderOfKey('/Users/me/Papers/one.pdf')).toBe('/Users/me/Papers');
    expect(folderOfKey('abc/one.pdf')).toBe('abc');
    expect(folderOfKey('one.pdf')).toBe('');
  });
});

describe('reading files into the index', () => {
  it('reads each file once and leaves an unchanged one alone', async () => {
    const ops = fakeOps();
    const known: Record<string, FileRecord> = {
      'folder/old.pdf': { key: 'folder/old.pdf', name: 'old.pdf', folder: 'folder', kind: 'pdf', size: 10, modified: 1000, indexed: 5 },
    };
    const states = new Map<string, FileState>();
    const outcome = await indexFiles({
      ops,
      handle: 1,
      ingest: pdfIngest,
      sources: [source('new.pdf'), source('old.pdf')],
      known,
      onState: (key, state) => void states.set(key, state),
    });
    expect(outcome.added).toBe(1);
    expect(outcome.unchanged).toBe(1);
    expect(ops.added).toEqual(['folder/new.pdf']);
    expect(states.get('folder/old.pdf')).toEqual({ state: 'unchanged' });
    expect(outcome.records).toHaveLength(2);
  });

  it('reads a file again once its size or date has moved', () => {
    const before: FileRecord = { key: 'k', name: 'n', folder: 'f', kind: 'pdf', size: 10, modified: 1000, indexed: 1 };
    expect(unchanged(source('n'), before)).toBe(true);
    expect(unchanged(source('n', { size: 11 }), before)).toBe(false);
    expect(unchanged(source('n', { modified: 2000 }), before)).toBe(false);
    expect(unchanged(source('n'), undefined)).toBe(false);
  });

  it('records why a file was not read and carries on', async () => {
    const ops = fakeOps();
    ops.failOn = 'folder/broken.pdf';
    const states = new Map<string, FileState>();
    const outcome = await indexFiles({
      ops,
      handle: 1,
      ingest: pdfIngest,
      sources: [source('notes.txt'), source('broken.pdf'), source('locked.pdf'), source('fine.pdf')],
      known: {},
      onState: (key, state) => void states.set(key, state),
    });
    expect(states.get('folder/notes.txt')).toEqual({ state: 'skipped', reason: 'reader' });
    expect(states.get('folder/broken.pdf')).toEqual({ state: 'failed', detail: 'E_READ: broken' });
    expect(states.get('folder/locked.pdf')).toEqual({ state: 'skipped', reason: 'core', detail: 'password' });
    expect(states.get('folder/fine.pdf')).toEqual({ state: 'added', pages: 2 });
    expect(outcome).toMatchObject({ added: 1, skipped: 2, failed: 1, cancelled: 0 });
  });

  it('stops when asked, keeps what it read, and marks the rest not done', async () => {
    const ops = fakeOps();
    const stop = new AbortController();
    const states = new Map<string, FileState>();
    const outcome = await indexFiles({
      ops,
      handle: 1,
      ingest: (one, options) => {
        if (one.name === 'b.pdf') stop.abort();
        return pdfIngest(one, options);
      },
      sources: [source('a.pdf'), source('b.pdf'), source('c.pdf'), source('d.pdf')],
      known: {},
      signal: stop.signal,
      onState: (key, state) => void states.set(key, state),
    });
    expect(outcome.added).toBe(2);
    expect(outcome.cancelled).toBe(2);
    expect(states.get('folder/c.pdf')).toEqual({ state: 'cancelled' });
    // What was read is in the index, so starting again picks up where it stopped.
    expect(outcome.records.map((one) => one.name)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('keeps the kind the core guessed, so a PDF with no text is a scan', async () => {
    const ops = fakeOps();
    const outcome = await indexFiles({
      ops,
      handle: 1,
      ingest: pdfIngest,
      sources: [source('scan-of-a-letter.pdf')],
      known: {},
      onState: () => undefined,
    });
    expect(outcome.records[0]?.kind).toBe('scan');
  });
});

describe('the tag rules', () => {
  it('keeps a rule once, and only when both halves are written', () => {
    const one = addRule([], ' فاتورة ', ' فواتير ');
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ word: 'فاتورة', tag: 'فواتير' });
    expect(addRule(one, 'فاتورة', 'فواتير')).toHaveLength(1);
    expect(addRule(one, '', 'فواتير')).toHaveLength(1);
    expect(removeRule(one, one[0]!.id)).toHaveLength(0);
  });

  it('reads the tags a person typed', () => {
    expect(parseTags('فواتير، عقود, عقود\nمهم')).toEqual(['فواتير', 'عقود', 'مهم']);
    expect(parseTags('   ')).toEqual([]);
  });

  it('tags every document whose text holds the word, and never twice', async () => {
    const ops = fakeOps();
    ops.hits = [hit({ key: 'a', text: 'فاتورة رقم ١' }), hit({ key: 'b', text: 'فاتورة رقم ٢' }), hit({ key: 'c', text: 'عقد إيجار' })];
    const rules = addRule([], 'فاتورة', 'فواتير');
    const first = await applyRules(ops, 1, rules);
    expect(first.tagged).toBe(2);
    expect(ops.tags.get('a')).toEqual(['فواتير']);
    expect(ops.tags.get('c')).toBeUndefined();
    // Run again: they already carry it, so nothing is written.
    expect((await applyRules(ops, 1, rules)).tagged).toBe(0);
  });

  it('can be held to the files a run has just added', async () => {
    const ops = fakeOps();
    ops.hits = [hit({ key: 'a', text: 'فاتورة ١' }), hit({ key: 'b', text: 'فاتورة ٢' })];
    const outcome = await applyRules(ops, 1, addRule([], 'فاتورة', 'فواتير'), ['b']);
    expect(outcome.keys).toEqual(['b']);
  });
});

describe('what the store keeps on this device', () => {
  it('gives back an index and its records, and really forgets them', async () => {
    const store = memoryStore();
    expect(await store.readIndex()).toBeNull();
    await store.writeIndex(new ArrayBuffer(8));
    await store.writeMeta({ ...emptyMeta(), files: { a: { key: 'a', name: 'a', folder: '', kind: 'pdf', modified: 1, indexed: 1 } } });
    expect((await store.readIndex())?.byteLength).toBe(8);
    expect(Object.keys((await store.readMeta()).files)).toEqual(['a']);
    await store.forgetEverything();
    expect(await store.readIndex()).toBeNull();
    expect(await store.readMeta()).toEqual(emptyMeta());
  });

  it('makes sense of whatever came back, however old or broken', () => {
    expect(tidyMeta(null)).toEqual(emptyMeta());
    expect(tidyMeta({ folders: 'no', rules: [{ id: 'r' }], files: { a: 1 } })).toEqual(emptyMeta());
    const good = tidyMeta({ folders: [{ id: 'f', label: 'F', source: 'files' }], rules: [{ id: 'r', word: 'w', tag: 't' }], files: {} });
    expect(good.folders).toHaveLength(1);
    expect(good.rules).toHaveLength(1);
  });
});

describe('the files a person adds', () => {
  it('takes the kinds it reads, counts the rest, and keeps each file by its key', () => {
    const files = [
      new File([new Uint8Array([1])], 'one.pdf'),
      new File([new Uint8Array([1])], 'notes.txt'),
      new File([new Uint8Array([1])], 'archive.zip'),
    ];
    const { sources, ignored, held } = sourcesFromFiles(files, 'folder-1');
    expect(sources.map((one) => one.key)).toEqual(['folder-1/one.pdf', 'folder-1/notes.txt']);
    expect(ignored).toBe(1);
    expect(held.get('folder-1/one.pdf')?.name).toBe('one.pdf');
  });
});
