import { describe, expect, it } from 'vitest';
import { comparePages, passagesOf, wordsOf } from './comparison';
import type { Passage } from './comparison';
import { diffWords } from './diff';
import { EXACT } from './normalize';

/** A passage as the panel shows it: … unchanged [-removed-] {+added+} … */
function show(passage: Passage): string {
  const parts = passage.parts.map((part) =>
    part.kind === 'same' ? part.text : part.kind === 'removed' ? `[-${part.text}-]` : `{+${part.text}+}`,
  );
  return [passage.before && '…', ...parts, passage.after && '…'].filter(Boolean).join(' ');
}

const TITLE = 'كلمة رئيس مجموعة البنك الدولي ديفيد مالباس';
const SENTENCE = 'هذه جملة جديدة كتبها اختبار المقارنة';
const BODY = 'صباح الخير. يسعدني أن ألتقي بكم عبر شبكة الإنترنت. سألقي كلمة، ثم يسعدني أن أتلقَّى الأسئلة.';

describe('comparing pages', () => {
  it('reports nothing for the same text, however it is broken into lines', () => {
    const result = comparePages([`${TITLE}\n${BODY}`], [`${TITLE} ${BODY.replace('. ', '.\n')}`], EXACT);
    expect(result).toEqual({ olderPages: 1, newerPages: 1, olderWords: 23, newerWords: 23, changed: [], added: 0, removed: 0 });
  });

  it('counts the words of each version, so pages without text are not called unchanged', () => {
    expect(comparePages(['', ' \n '], [''], EXACT)).toMatchObject({ olderWords: 0, newerWords: 0, changed: [] });
  });

  it('finds the one changed page, what was added and what was removed', () => {
    const older = ['الصفحة الأولى', `${TITLE}\n06/13/2021\n${BODY}`, 'الصفحة الثالثة'];
    const newer = ['الصفحة الأولى', `${SENTENCE}\n06/13/2021\n${BODY}`, 'الصفحة الثالثة'];
    const result = comparePages(older, newer, EXACT);
    expect(result.changed).toHaveLength(1);
    const [page] = result.changed;
    expect(page).toMatchObject({ page: 2, inOlder: true, inNewer: true, added: 6, removed: 7 });
    expect(result).toMatchObject({ added: 6, removed: 7 });
    // Eight unchanged words after the change, and a mark that the page goes on.
    expect(page!.passages.map(show)).toEqual([`[-${TITLE}-] {+${SENTENCE}+} 06/13/2021 صباح الخير. يسعدني أن ألتقي بكم عبر …`]);
  });

  it('shows unchanged words either side of a change, and says where more were left out', () => {
    const words = Array.from({ length: 40 }, (_, i) => `ك${i + 1}`);
    const changed = [...words.slice(0, 20), 'جديد', ...words.slice(21)];
    const [page] = comparePages([words.join(' ')], [changed.join(' ')], EXACT, 3).changed;
    expect(page!.passages.map(show)).toEqual(['… ك18 ك19 ك20 [-ك21-] {+جديد+} ك22 ك23 ك24 …']);
  });

  it('keeps two nearby changes in one passage and splits distant ones', () => {
    const words = Array.from({ length: 30 }, (_, i) => `ك${i + 1}`);
    const near = words.map((w, i) => (i === 5 || i === 9 ? `${w}+` : w));
    const far = words.map((w, i) => (i === 2 || i === 25 ? `${w}+` : w));
    const nearPage = comparePages([words.join(' ')], [near.join(' ')], EXACT, 2).changed[0]!;
    expect(nearPage.passages.map(show)).toEqual(['… ك4 ك5 [-ك6-] {+ك6++} ك7 ك8 ك9 [-ك10-] {+ك10++} ك11 ك12 …']);
    const farPage = comparePages([words.join(' ')], [far.join(' ')], EXACT, 2).changed[0]!;
    expect(farPage.passages.map(show)).toEqual([
      'ك1 ك2 [-ك3-] {+ك3++} ك4 ك5 …',
      '… ك24 ك25 [-ك26-] {+ك26++} ك27 ك28 …',
    ]);
  });

  it('shows a page only one version has as wholly added or removed', () => {
    const result = comparePages(['أ ب', 'ج د'], ['أ ب', 'ج د', 'هـ و ز'], EXACT);
    expect(result).toMatchObject({ olderPages: 2, newerPages: 3, added: 3, removed: 0 });
    expect(result.changed).toEqual([
      { page: 3, inOlder: false, inNewer: true, added: 3, removed: 0, passages: [{ before: false, after: false, parts: [{ kind: 'added', text: 'هـ و ز' }] }] },
    ]);
    const fewer = comparePages(['أ ب', 'ج د'], ['أ ب'], EXACT);
    expect(fewer.changed[0]).toMatchObject({ page: 2, inOlder: true, inNewer: false, removed: 2 });
  });

  it('sees a change in tashkeel alone only while diacritics count', () => {
    const plain = [`${SENTENCE}\n${BODY}`];
    const marked = [`هَذِهِ جُمْلَةٌ جَدِيدَةٌ كَتَبَهَا اخْتِبَارُ\nالْمُقَارَنَةِ\n${BODY}`];
    const exact = comparePages(plain, marked, EXACT);
    expect(exact.changed).toHaveLength(1);
    expect(exact.changed[0]!.passages.map(show)).toEqual([
      `[-${SENTENCE}-] {+هَذِهِ جُمْلَةٌ جَدِيدَةٌ كَتَبَهَا اخْتِبَارُ الْمُقَارَنَةِ+} صباح الخير. يسعدني أن ألتقي بكم عبر شبكة …`,
    ]);
    expect(comparePages(plain, marked, { ignoreMarks: true, unifyLetters: false }).changed).toEqual([]);
  });

  it('sees أ and ا, ة and ه, ى and ي as one letter only when asked', () => {
    const older = ['إلى المكتبة الكبرى'];
    const newer = ['الي المكتبه الكبري'];
    expect(comparePages(older, newer, EXACT).changed[0]).toMatchObject({ added: 3, removed: 3 });
    expect(comparePages(older, newer, { ignoreMarks: false, unifyLetters: true }).changed).toEqual([]);
  });

  it('shows words as each version has them, and compares them by key', () => {
    const before = wordsOf('الْكِتَابُ ـ مفيد', { ignoreMarks: true, unifyLetters: false });
    // The lone tatweel has nothing to compare and is left out.
    expect(before).toEqual({ shown: ['الْكِتَابُ', 'مفيد'], keys: ['الكتاب', 'مفيد'] });
    const after = wordsOf('الكتاب مفيد جدا', { ignoreMarks: true, unifyLetters: false });
    const passages = passagesOf(diffWords(before.keys, after.keys), before.shown, after.shown);
    // Unchanged words are shown as the newer version has them.
    expect(passages.map(show)).toEqual(['الكتاب مفيد {+جدا+}']);
  });
});
