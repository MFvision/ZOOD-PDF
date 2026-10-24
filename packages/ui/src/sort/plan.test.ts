import { describe, expect, it } from 'vitest';
import {
  documentStarts,
  folderSuggestion,
  mergeSuggestions,
  namingLine,
  renameSuggestion,
  saysNothing,
  seriesOf,
  splitSuggestions,
  suggest,
  topicOfText,
  topicsOf,
} from './plan';
import type { FileKind, FileLook, SortFile, Topic } from './plan';

const file = (index: number, name: string, kind: FileKind = 'pdf', day = '2026-10-21'): SortFile => ({
  index,
  name,
  path: `/home/me/Downloads/${name}`,
  size: 100,
  day,
  kind,
  made: false,
});
const look = (texts: string[], pages = texts.length, title = ''): FileLook => ({ pages, texts, title, locked: false });
const word = (topic: Topic) => ({ invoices: 'Invoice', bank: 'Bank statement', contracts: 'Contract', ids: 'ID', travel: 'Travel', medical: 'Medical', cvs: 'CV', certificates: 'Certificate' })[topic];

describe('series', () => {
  it('finds the name a series shares, and each one’s place', () => {
    expect(seriesOf('scan 2.pdf')).toMatchObject({ key: 'scan', number: 2, numbered: true });
    expect(seriesOf('scan0003.jpg')).toMatchObject({ key: 'scan', number: 3 });
    expect(seriesOf('Contract page 1.pdf')).toMatchObject({ base: 'Contract', number: 1 });
    expect(seriesOf('عقد صفحة ٢.pdf')).toMatchObject({ key: 'عقد', number: 2 });
    expect(seriesOf('report (2).pdf')).toMatchObject({ key: 'report', numbered: true });
    expect(seriesOf('report 2026.pdf')).toMatchObject({ key: 'report 2026', numbered: false });
    expect(seriesOf('report.pdf')).toMatchObject({ key: 'report', numbered: false });
  });

  it('merges pages of one document, in order, and never camera photos', () => {
    const files = [
      file(0, 'scan 2.pdf'),
      file(1, 'scan 1.pdf'),
      file(2, 'IMG_2031.jpg', 'images'),
      file(3, 'IMG_2032.jpg', 'images'),
      file(4, 'page 1.png', 'images'),
      file(5, 'contract.pdf'),
      file(6, 'Scanned Document 1.jpeg', 'images'),
      file(7, 'Scanned Document 2.jpeg', 'images'),
    ];
    const merges = mergeSuggestions(files);
    expect(merges).toHaveLength(2);
    expect(merges[0]).toMatchObject({ files: [1, 0], as: 'pdf', name: 'scan' });
    expect(merges[1]).toMatchObject({ files: [6, 7], as: 'images', name: 'Scanned Document' });
  });

  it('does not merge two files of different kinds, or one alone', () => {
    expect(mergeSuggestions([file(0, 'scan 1.pdf'), file(1, 'scan 2.png', 'images')])).toEqual([]);
    expect(mergeSuggestions([file(0, 'scan 1.pdf')])).toEqual([]);
  });
});

describe('split', () => {
  it('finds where a new invoice starts by its number', () => {
    const texts = ['Tax Invoice No: 1001\nJarir', 'continued', 'Tax Invoice No: 1002', 'فاتورة ضريبية رقم: 77'];
    expect(documentStarts(texts)).toEqual([0, 2, 3]);
  });

  it('finds a page one again', () => {
    expect(documentStarts(['Page 1 of 2', 'Page 2 of 2', 'Page 1 of 1'])).toEqual([0, 2]);
    expect(documentStarts(['صفحة ١ من ٢', 'صفحة ٢ من ٢', 'صفحة 1 من 3'])).toEqual([0, 2]);
  });

  it('suggests parts covering every page, unread ones with the last', () => {
    const looks = new Map([[0, look(['Invoice # A1', 'Invoice # A2'], 4)]]);
    const [split] = splitSuggestions([file(0, 'bills.pdf')], looks);
    expect(split?.parts).toEqual([[0], [1, 2, 3]]);
    expect(splitSuggestions([file(0, 'one.pdf')], new Map([[0, look(['Invoice # A1', 'more'])]]))).toEqual([]);
  });
});

describe('names and topics', () => {
  it('knows names that say nothing', () => {
    for (const name of ['IMG_2034.jpg', 'scan0001.pdf', 'Document (3).pdf', 'download.pdf', 'صورة ٢٠٢٦.jpg', 'Screenshot 2026-10-21 at 10.22.31 AM.png'])
      expect(saysNothing(name), name).toBe(true);
    for (const name of ['Jarir invoice.pdf', 'عقد الإيجار.pdf', 'CV Mohammed.pdf']) expect(saysNothing(name), name).toBe(false);
  });

  it('reads a topic in either language', () => {
    expect(topicOfText('TAX INVOICE')).toBe('invoices');
    expect(topicOfText('كشف حساب بنكي')).toBe('bank');
    expect(topicOfText('عقد إيجار')).toBe('contracts');
    expect(topicOfText('Boarding pass')).toBe('travel');
    expect(topicOfText('my cv')).toBe('cvs');
    expect(topicOfText('a novel')).toBeNull();
  });

  it('takes a short line of words to name a document', () => {
    expect(namingLine(['12345\nJarir Bookstore Riyadh Branch\nTotal 50'])).toBe('Jarir Bookstore Riyadh Branch');
    expect(namingLine([''], 'Lease agreement 2026')).toBe('Lease agreement 2026');
    expect(namingLine(['1/2\n---'])).toBe('');
  });

  it('renames only names that say nothing, with the topic once and the day', () => {
    const files = [file(0, 'scan0001.pdf'), file(1, 'Lease.pdf'), file(2, 'IMG_1.jpg', 'images')];
    const looks = new Map([[0, look(['Invoice\nJarir Bookstore'])]]);
    const topics = topicsOf(files, looks);
    const rename = renameSuggestion(files, looks, topics, word);
    expect(rename?.names).toEqual([{ file: 0, name: 'Invoice - Jarir Bookstore - 2026-10-21' }]);
  });
});

describe('folders and the whole', () => {
  it('puts each file on a shelf by topic, else by kind, the biggest first', () => {
    const files = [file(0, 'invoice 1.pdf'), file(1, 'invoice 2.pdf'), file(2, 'a.png', 'images'), file(3, 'notes.pdf')];
    const folders = folderSuggestion(files, topicsOf(files, new Map()));
    expect(folders?.shelves).toEqual([
      { shelf: 'invoices', files: [0, 1] },
      { shelf: 'images', files: [2] },
      { shelf: 'pdf', files: [3] },
    ]);
    expect(folderSuggestion([file(0, 'a.pdf')], new Map())).toBeNull();
  });

  it('suggests merges, splits, names and folders together', () => {
    const files = [file(0, 'scan 1.pdf'), file(1, 'scan 2.pdf'), file(2, 'bills.pdf'), file(3, 'IMG_1.jpg', 'images')];
    const looks = new Map([[2, look(['Invoice No: 1', 'Invoice No: 2'])]]);
    const kinds = suggest(files, looks, word).map((s) => s.kind);
    expect(kinds).toEqual(['merge', 'split', 'folders']);
    // The model's guess fills in a topic the rules did not find.
    const guessed = new Map<number, Topic>([[3, 'ids']]);
    const folders = suggest(files, looks, word, guessed).find((s) => s.kind === 'folders');
    expect(folders && 'shelves' in folders && folders.shelves.some((s) => s.shelf === 'ids')).toBe(true);
  });
});
