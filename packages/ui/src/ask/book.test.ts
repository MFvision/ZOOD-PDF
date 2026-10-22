import { describe, expect, it } from 'vitest';
import {
  asksFirst,
  bookEnding,
  bookOptions,
  controlNamed,
  controlOptions,
  entryNamed,
  intentOf,
  partsOf,
  stepOf,
  stepWords,
  withoutAsking,
} from './book';
import type { BookEntry, Control } from './book';

const entry = (id: string, label: string, enabled = true): BookEntry => ({ id, label, menu: 'File', enabled });

/** A slice of the editor's book, as the English menus name it. */
const BOOK: BookEntry[] = [
  entry('open', 'Open…'),
  entry('save', 'Save'),
  entry('print', 'Print…'),
  entry('close', 'Close'),
  entry('find', 'Find…'),
  entry('goto', 'Go to page…'),
  entry('zoom-in', 'Zoom in'),
  entry('zoom-out', 'Zoom out'),
  entry('read-aloud', 'Read aloud'),
  entry('settings', 'Settings…'),
  entry('theme-dark', 'Theme: Dark'),
  entry('theme-light', 'Theme: Light'),
  entry('tool-organize', 'Organize pages'),
  entry('tool-compress', 'Compress'),
  entry('tool-export', 'Convert'),
  entry('redo', 'Redo', false),
  entry('home', 'Home'),
];

describe("Ask ZOOD's command book", () => {
  it('tells "show me" from "do it" and from a plain question', () => {
    expect(intentOf('show me how to compress')).toBe('show');
    expect(intentOf('وريني كيف أطبع')).toBe('show');
    expect(intentOf('do it for me: save')).toBe('do');
    expect(intentOf('سوها لي احفظ الملف')).toBe('do');
    expect(intentOf('turn on dark mode')).toBe('do');
    expect(intentOf('what is a watermark')).toBeNull();
  });

  it('takes the asking off and cuts a request into its parts', () => {
    expect(withoutAsking('Do it for me: save')).toBe('save');
    expect(partsOf('do it for me: rotate the pages then compress it')).toEqual(['rotate the pages', 'compress it']);
    expect(partsOf('سوها لي دور الصفحات ثم احفظ')).toEqual(['دور الصفحات', 'احفظ']);
    expect(partsOf('zoom in, then go to page 4 and read aloud')).toEqual(['zoom in', 'go to page 4', 'read aloud']);
  });

  it('matches each part without any model', () => {
    expect(stepOf('go to page 12', BOOK)).toEqual({ id: 'goto', label: 'Go to page…', page: 12 });
    expect(stepOf('dark mode', BOOK)?.id).toBe('theme-dark');
    expect(stepOf('turn off dark mode', BOOK)?.id).toBe('theme-light');
    expect(stepOf('compress it', BOOK)?.id).toBe('tool-compress');
    expect(stepOf('find invoice', BOOK)).toEqual({ id: 'find', label: 'Find…', query: 'invoice' });
    expect(stepOf('read aloud', BOOK)?.id).toBe('read-aloud');
    expect(stepOf('اقرا لي', BOOK)?.id).toBe('read-aloud');
    expect(stepOf('احفظ الملف', BOOK)?.id).toBe('save');
    expect(stepOf('print', BOOK)?.id).toBe('print');
    expect(stepOf('organize pages', BOOK)?.id).toBe('tool-organize');
    // What the book does not have is left for the models.
    expect(stepOf('summarize this', BOOK)).toBeNull();
    expect(stepOf('print this document', BOOK)?.id).toBe('print');
    // A name that is only a small part of what was said is not the command: a document to find.
    expect(stepOf('open the rent contract', BOOK)).toBeNull();
  });

  it('never picks a command that is off, nor one of two that tie', () => {
    expect(entryNamed('redo', BOOK)).toBeNull();
    expect(entryNamed('zoom', [entry('zoom-in', 'Zoom'), entry('zoom-out', 'Zoom')])).toBeNull();
  });

  it('asks before closing, saving over the file or printing', () => {
    expect(asksFirst({ id: 'save', label: 'Save' })).toBe(true);
    expect(asksFirst({ id: 'close', label: 'Close' })).toBe(true);
    expect(asksFirst({ id: 'zoom-in', label: 'Zoom in' })).toBe(false);
    expect(asksFirst({ id: 'cloud-save-onedrive', label: 'Save to OneDrive' })).toBe(true);
  });

  it('gives the decider the commands that are on, with their Arabic', () => {
    const options = bookOptions(BOOK);
    expect(options.redo).toBeUndefined();
    expect(options.save).toContain('احفظ');
    expect(options['tool-compress']).toContain('Compress');
    expect(options.none).toBeTruthy();
  });

  it('says a step plainly', () => {
    expect(stepWords({ id: 'goto', label: 'Go to page…', page: 5 })).toBe('Go to page 5');
    expect(stepWords({ id: 'find', label: 'Find…', query: 'fee' })).toBe('Find: fee');
    expect(bookEnding('menu', 'en', { name: 'Save', menu: 'File' })).toBe('Choose Save in the File menu.');
    expect(bookEnding('disabled', 'ar', { name: 'حفظ' })).toBe('«حفظ» غير متاح الآن.');
  });
});

describe('buttons of other apps, by their names', () => {
  const controls: Control[] = [
    { name: 'File', role: 'menu item', x: 20, y: 10 },
    { name: 'Print', role: 'button', x: 400, y: 80 },
    { name: 'Print preview', role: 'button', x: 450, y: 80 },
    { name: 'Share', role: 'button', x: 900, y: 40 },
    { name: 'إرسال', role: 'button', x: 600, y: 900 },
  ];

  it('finds the button a part names, the fullest name first', () => {
    expect(controlNamed('click Print', controls)?.x).toBe(400);
    expect(controlNamed('open print preview', controls)?.x).toBe(450);
    expect(controlNamed('press the share button', controls)?.name).toBe('Share');
    expect(controlNamed('اضغط على إرسال', controls)?.name).toBe('إرسال');
    expect(controlNamed('click Save', controls)).toBeNull();
  });

  it('lists each name once for the decider', () => {
    const options = controlOptions([...controls, { name: 'Print', role: 'button', x: 1, y: 1 }]);
    expect(Object.values(options).filter((name) => name === 'Print')).toHaveLength(1);
    expect(options.none).toBeTruthy();
  });
});
