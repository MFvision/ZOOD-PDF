import { describe, expect, it } from 'vitest';
import { badRange, filterCount, noFilters, toFilters, toggle } from './filters';
import { markSpans, snippet } from './snippet';
import { addRule, parseTags, removeRule, ruleKey, ruleWords } from './rules';
import { emptyMeta, memoryStore, tidyMeta } from './store';
import type { FolderRecord, LibraryMeta } from './store';
import { keepNativePath } from '../core/host-tauri';
import { fileForKey, filesFromPicker, folderOf, heldFiles, isDevicePath, keysUnder, mustChooseAgain, readableFile } from './sources';
import type { LibraryKind } from './kinds';
import type { TagRule } from './ops';

/**
 * The Library panel's own logic, away from the screen: what a hit's line
 * looks like once its matches are marked, what the filters ask the core for,
 * what a rule a person typed becomes, and what the store keeps on this
 * device. Reading the files is `ingest.test.ts`, and the index and its
 * search are the core's own tests; these say exactly what the panel does
 * with the answers.
 */

/** The bytes of a string, so a test can say what the core would have sent. */
const bytes = (text: string): number => new TextEncoder().encode(text).length;

describe('marking the words a search matched', () => {
  it('reads the core’s places as bytes, not as letters', () => {
    // The core counts a line the way Rust holds it: in UTF-8 bytes. Every
    // Arabic letter is two of them, so taking a byte offset for a string
    // index would mark the wrong half of the line — this is that bug's test.
    const line = 'فاتورة رقم ١٢';
    const marked = markSpans(line, [[0, bytes('فاتورة')]]);
    expect(marked).toEqual([
      { text: 'فاتورة', match: true },
      { text: ' رقم ١٢', match: false },
    ]);
    // A word further along the line, after Arabic that is wider in bytes.
    const second = markSpans(line, [[bytes('فاتورة رقم '), bytes('١٢')]]);
    expect(second.filter((part) => part.match).map((part) => part.text)).toEqual(['١٢']);
  });

  it('marks Latin text, where a byte and a letter are the same thing', () => {
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
    // A span that starts before the line is nonsense, and is dropped rather
    // than guessed at: the line still reads, with nothing marked.
    expect(markSpans('short', [[-4, 2]])).toEqual([{ text: 'short', match: false }]);
    expect(markSpans('short', [])).toEqual([{ text: 'short', match: false }]);
    expect(markSpans('', [[0, 3]])).toEqual([]);
    // A place inside a letter, which only a damaged index would give: it
    // goes back to where that letter starts instead of splitting it.
    expect(markSpans('فاتورة', [[1, 2]])).toEqual([{ text: 'ف', match: true }, { text: 'اتورة', match: false }]);
  });

  it('cuts a long line to a window around the first match', () => {
    const line = `${'a'.repeat(200)}فاتورة${'b'.repeat(200)}`;
    const cut = snippet(line, [[200, bytes('فاتورة')]], { before: 10, after: 20 });
    expect(cut.cutStart).toBe(true);
    expect(cut.cutEnd).toBe(true);
    expect(cut.parts.filter((part) => part.match).map((part) => part.text)).toEqual(['فاتورة']);
    expect(cut.parts.map((part) => part.text).join('')).toBe(`${'a'.repeat(10)}فاتورة${'b'.repeat(14)}`);
  });

  it('leaves a short line whole', () => {
    const cut = snippet('فاتورة رقم ١٢', [[0, bytes('فاتورة')]]);
    expect(cut.cutStart).toBe(false);
    expect(cut.cutEnd).toBe(false);
    expect(cut.parts.map((part) => part.text).join('')).toBe('فاتورة رقم ١٢');
    expect(cut.parts.filter((part) => part.match).map((part) => part.text)).toEqual(['فاتورة']);
  });

  it('never splits a pair of surrogates at the edge of the window', () => {
    const line = `${'a'.repeat(50)}😀${'b'.repeat(50)}`;
    const cut = snippet(line, [[54, 1]], { before: 3, after: 3 });
    expect([...cut.parts.map((part) => part.text).join('')].every((one) => one !== '\ud83d')).toBe(true);
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

describe('the tag rules a person writes', () => {
  it('makes a rule of what was typed, once, and only with both halves', () => {
    const one = addRule([], ' فاتورة، إيصال ', ' فواتير ', true);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ tag: 'فواتير', words: ['فاتورة', 'إيصال'], scope: 'both', enabled: true });
    expect(addRule(one, 'فاتورة, إيصال', 'فواتير', true)).toHaveLength(1);
    expect(addRule(one, '', 'فواتير', true)).toHaveLength(1);
    expect(addRule(one, 'عقد', '', true)).toHaveLength(1);
    expect(addRule(one, 'عقد', 'عقود', false)[1]).toMatchObject({ scope: 'text' });
    expect(removeRule(one, 0)).toHaveLength(0);
  });

  it('reads the words and tags a person typed', () => {
    expect(parseTags('فواتير، عقود, عقود\nمهم')).toEqual(['فواتير', 'عقود', 'مهم']);
    expect(parseTags('   ')).toEqual([]);
  });

  it('shows a rule as a line, and tells two rules apart in a list', () => {
    const rule: TagRule = { tag: 'فواتير', words: ['فاتورة', 'إيصال'] };
    expect(ruleWords(rule)).toBe('فاتورة، إيصال');
    expect(ruleKey(rule, 0)).not.toBe(ruleKey({ ...rule, tag: 'عقود' }, 0));
  });
});

describe('the files a person adds', () => {
  it('takes the kinds it reads, counts the rest, and keeps each file by its key', () => {
    const picked = [
      new File([new Uint8Array([1])], 'one.pdf'),
      new File([new Uint8Array([1])], 'notes.txt'),
      new File([new Uint8Array([1])], 'archive.zip'),
    ];
    const { files, ignored, held } = filesFromPicker(picked, 'folder-1');
    expect(files.map((one) => one.key)).toEqual(['folder-1/one.pdf', 'folder-1/notes.txt']);
    expect(ignored).toBe(1);
    expect(held.get('folder-1/one.pdf')?.name).toBe('one.pdf');
    expect(readableFile('report.PDF')).toBe(true);
    expect(readableFile('archive.zip')).toBe(false);
  });

  it('knows which folder a key came from, and which keys a folder holds', () => {
    const folder: FolderRecord = { id: 'f1', label: 'Papers', source: 'files' };
    const other: FolderRecord = { id: '/Users/me/Reports', label: 'Reports', source: 'path' };
    const meta: LibraryMeta = {
      folders: [folder, other],
      files: {
        'f1/a.pdf': { key: 'f1/a.pdf', name: 'a.pdf', folder: 'f1', kind: 'pdf' },
        'f1/deep/b.pdf': { key: 'f1/deep/b.pdf', name: 'b.pdf', folder: 'f1', kind: 'pdf' },
        '/Users/me/Reports/c.pdf': { key: '/Users/me/Reports/c.pdf', name: 'c.pdf', folder: '/Users/me/Reports', kind: 'pdf' },
      },
    };
    expect(folderOf(meta, 'f1/deep/b.pdf')?.id).toBe('f1');
    expect(folderOf(meta, '/Users/me/Reports/c.pdf')?.id).toBe('/Users/me/Reports');
    expect(folderOf(meta, 'nowhere/d.pdf')).toBeUndefined();
    expect(keysUnder(meta, folder)).toEqual(['f1/a.pdf', 'f1/deep/b.pdf']);
    expect(keysUnder(meta, other)).toEqual(['/Users/me/Reports/c.pdf']);
  });

  it('keys a file the desktop picked by its own path, under the folder it was added to', () => {
    const word = keepNativePath(new File([new Uint8Array([1])], 'letter.docx'), 'C:\\Users\\me\\letter.docx');
    const { files } = filesFromPicker([word, new File([new Uint8Array([1])], 'b.pdf')], 'files');
    expect(files.map((one) => one.key)).toEqual(['C:\\Users\\me\\letter.docx', 'files/b.pdf']);
    const meta: LibraryMeta = {
      folders: [{ id: 'files', label: 'Chosen files', source: 'files' }, { id: 'C:\\Users', label: 'Users', source: 'path' }],
      files: { 'C:\\Users\\me\\letter.docx': { key: 'C:\\Users\\me\\letter.docx', name: 'letter.docx', folder: 'files', kind: 'docx' as LibraryKind } },
    };
    expect(folderOf(meta, 'C:\\Users\\me\\letter.docx')?.id).toBe('files');
    expect(isDevicePath('C:\\Users\\me\\letter.docx')).toBe(true);
    expect(isDevicePath('\\\\server\\share\\a.pdf')).toBe(true);
    expect(isDevicePath('/Users/me/a.pdf')).toBe(true);
    expect(isDevicePath('files/a.pdf')).toBe(false);
    expect(isDevicePath('dir:Papers/a.pdf')).toBe(false);
  });

  it('opens a file added this session from anywhere, and asks again only for one it no longer has', async () => {
    const meta: LibraryMeta = {
      folders: [{ id: 'files', label: 'Chosen files', source: 'files' }],
      files: { 'files/a.pdf': { key: 'files/a.pdf', name: 'a.pdf', folder: 'files', kind: 'pdf' } },
    };
    expect(mustChooseAgain(meta, 'files/a.pdf')).toBe(true);
    const file = new File([new Uint8Array([1])], 'a.pdf');
    heldFiles.set('files/a.pdf', file);
    try {
      expect(mustChooseAgain(meta, 'files/a.pdf')).toBe(false);
      expect(await fileForKey(meta, 'files/a.pdf')).toBe(file);
    } finally {
      heldFiles.delete('files/a.pdf');
    }
  });
});

describe('what the store keeps on this device', () => {
  it('gives back an index and its records, and really forgets them', async () => {
    const store = memoryStore();
    expect(await store.readIndex()).toBeNull();
    await store.writeIndex(new ArrayBuffer(8));
    await store.writeMeta({ folders: [], files: { a: { key: 'a', name: 'a.pdf', folder: '', kind: 'pdf' } } });
    expect((await store.readIndex())?.byteLength).toBe(8);
    expect(Object.keys((await store.readMeta()).files)).toEqual(['a']);
    await store.forgetEverything();
    expect(await store.readIndex()).toBeNull();
    expect(await store.readMeta()).toEqual(emptyMeta());
  });

  it('makes sense of whatever came back, however old or broken', () => {
    expect(tidyMeta(null)).toEqual(emptyMeta());
    expect(tidyMeta({ folders: 'no', files: { a: 1 } })).toEqual(emptyMeta());
    const good = tidyMeta({ folders: [{ id: 'f', label: 'F', source: 'files' }], files: { a: { key: 'a', name: 'a.pdf', folder: '', kind: 'pdf' } } });
    expect(good.folders).toHaveLength(1);
    expect(Object.keys(good.files)).toEqual(['a']);
  });

  it('hands back a copy, so an edit of what was read does not change what is kept', async () => {
    const store = memoryStore();
    await store.writeMeta({ folders: [{ id: 'f', label: 'F', source: 'files' }], files: {} });
    const read = await store.readMeta();
    read.folders[0]!.label = 'changed';
    expect((await store.readMeta()).folders[0]?.label).toBe('F');
  });
});
