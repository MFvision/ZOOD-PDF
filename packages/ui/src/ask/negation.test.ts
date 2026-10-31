import { describe, expect, it } from 'vitest';
import { BOOK_WORDS } from './book';
import type { BookEntry } from './book';
import { fuzzyPick } from './fuzzy';
import { refusal } from './negation';
import { TOOLS } from '../tools/tools';

describe('a request that says what not to do', () => {
  it('does nothing when it only says what not to do', () => {
    for (const words of [
      "don't delete page 3",
      'do not delete page 3',
      'Don’t undo',
      'dont save',
      'please don’t close the file',
      'never print',
      "don't turn on dark mode",
      "don't turn off auto save",
      'no dark mode',
      'no undo',
      'not now',
      'no thanks',
      "don't open youtube",
      "I don't want to compress it",
      'zood, do not merge the files',
      'لا تحذف الصفحة',
      'لا تحذف الصفحة ٣',
      'لا تحذِفْ الصفحـــة',
      'لا تتراجع',
      'لا تطبع',
      'لاتحفظ',
      'يا زود لا تسكر الملف',
      'لو سمحت لا تضغط الملف',
      'ما ابي احفظ',
      'ما ابغى أطبعه',
      'بلاش تحفظ',
      'مو لازم تحفظ',
      'لا تشغل الوضع الليلي',
      'لا تفتح يوتيوب',
    ])
      expect(refusal(words), words).toBe('all');
  });

  it('is left to the model when a "don\'t" goes with something to do', () => {
    for (const words of [
      "save, but don't print",
      "rotate page 2 and don't delete it",
      'احفظ ولا تطبع',
      'احفظ بس لا تسكر الملف',
      "don't save, print",
      "delete page 3, no wait, don't",
    ])
      expect(refusal(words), words).toBe('some');
  });

  it('is an ordinary request otherwise', () => {
    for (const words of [
      'delete page 3',
      'احذف الصفحة ٣',
      "don't forget to save",
      'لا تنسى تحفظ الملف',
      'no, open the settings',
      'لا، افتح الاعدادات',
      'not only',
      'notify me',
      'number the pages',
      'نون',
      'لابتوب',
      'ما هو الضغط',
      'لا',
      'no',
      'never mind',
      "don't you think it's long?",
      'find and replace',
      'بسم الله',
      '',
      '   ',
    ])
      expect(refusal(words), words).toBeNull();
  });

  it('is quick on hostile words', () => {
    for (const words of [' '.repeat(200_000), 'لا '.repeat(50_000), "don't ".repeat(30_000), ',,,'.repeat(50_000), 'a'.repeat(200_000)]) {
      const start = performance.now();
      refusal(words);
      expect(performance.now() - start).toBeLessThan(100);
    }
  });
});

describe('the words one by one', () => {
  const entries: BookEntry[] = [
    ...Object.keys(BOOK_WORDS).map((id) => ({ id, label: id, menu: '', enabled: true })),
    ...TOOLS.map((tool) => ({ id: `tool-${tool.id}`, label: tool.id, menu: '', enabled: true })),
  ];

  it('never reads an Arabic «لا» as the one-tap setting turned off', () => {
    for (const words of ['لا تحفظ', 'لا تحذف الصفحة', 'لا تطبع', 'لا تسكر الملف', 'لا تروح للصفحة ٥']) {
      const picked = fuzzyPick(words, entries);
      expect(picked?.kind === 'setting' ? picked.ask.entry.id : null, words).not.toBe('oneTap');
    }
  });
});
