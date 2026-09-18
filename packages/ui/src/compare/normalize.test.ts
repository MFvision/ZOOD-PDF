import { describe, expect, it } from 'vitest';
import { EXACT, comparisonKey, isMarkOrControl } from './normalize';

const MARKS = { ignoreMarks: true, unifyLetters: false };
const LETTERS = { ignoreMarks: false, unifyLetters: true };
const BOTH = { ignoreMarks: true, unifyLetters: true };

/**
 * The same rules as Warraq's search (`warraq-text/src/normalize.rs`), one at a
 * time, and each one only when its option is on.
 */
describe('comparison keys', () => {
  it('compare words exactly when no option is on', () => {
    expect(comparisonKey('الْعِلْمُ', EXACT)).toBe('الْعِلْمُ');
    expect(comparisonKey('أحمد', EXACT)).toBe('أحمد');
    expect(comparisonKey('الـعـربـيـة', EXACT)).toBe('الـعـربـيـة');
  });

  it('drop tashkeel, U+064B to U+065F, when marks are ignored', () => {
    // fathatan … sukun, and the rest of the block up to U+065F
    for (let codePoint = 0x064b; codePoint <= 0x065f; codePoint += 1) {
      expect(comparisonKey(`ب${String.fromCodePoint(codePoint)}`, MARKS), codePoint.toString(16)).toBe('ب');
    }
    expect(comparisonKey('الْعِلْمُ نُورٌ', MARKS)).toBe('العلم نور');
  });

  it('drop the dagger alef, U+0670, when marks are ignored', () => {
    expect(comparisonKey('هٰذا', MARKS)).toBe('هذا');
    expect(comparisonKey('هٰذا', EXACT)).toBe('هٰذا');
  });

  it('drop tatweel, U+0640, when marks are ignored', () => {
    expect(comparisonKey('الـعـربـيـة', MARKS)).toBe('العربية');
    // A word of nothing but tatweel has nothing left to compare.
    expect(comparisonKey('ـــ', MARKS)).toBe('');
  });

  it('drop Quranic marks and invisible direction controls with them, as the search does', () => {
    expect(comparisonKey('ٱلرَّحِيمِۖ', MARKS)).toBe('ٱلرحيم'); // U+06D6, small high ligature
    expect(comparisonKey('‏كتاب‎', MARKS)).toBe('كتاب');
    expect(comparisonKey('⁧كتاب⁩', MARKS)).toBe('كتاب');
    expect(isMarkOrControl(0x0627)).toBe(false); // alef is a letter
    expect(isMarkOrControl(0x0660)).toBe(false); // Arabic-Indic zero is a digit
  });

  it('count أ إ آ ٱ as ا when letters are unified', () => {
    expect(comparisonKey('أحمد', LETTERS)).toBe('احمد');
    expect(comparisonKey('إلى', LETTERS)).toBe('الي');
    expect(comparisonKey('آخر', LETTERS)).toBe('اخر');
    expect(comparisonKey('ٱلله', LETTERS)).toBe('الله');
  });

  it('count ة as ه when letters are unified', () => {
    expect(comparisonKey('مكتبة', LETTERS)).toBe('مكتبه');
    expect(comparisonKey('مكتبة', EXACT)).toBe('مكتبة');
  });

  it('count ى as ي, and the Persian ی and ک with their Arabic letters, when letters are unified', () => {
    expect(comparisonKey('موسى', LETTERS)).toBe('موسي');
    expect(comparisonKey('فارسی', LETTERS)).toBe('فارسي');
    expect(comparisonKey('کتاب', LETTERS)).toBe('كتاب');
    expect(comparisonKey('کتاب', EXACT)).toBe('کتاب');
  });

  it('keep each option to its own rule', () => {
    expect(comparisonKey('إِلَى', MARKS)).toBe('إلى');
    expect(comparisonKey('إِلَى', LETTERS)).toBe('اِلَي');
    expect(comparisonKey('إِلَى', BOTH)).toBe('الي');
  });

  it('never fold digits or case, which are visible edits', () => {
    expect(comparisonKey('٢٠٢٦', BOTH)).toBe('٢٠٢٦');
    expect(comparisonKey('World', BOTH)).toBe('World');
  });

  it('always read presentation forms as the letters they stand for', () => {
    expect(comparisonKey('ﻻ', EXACT)).toBe('لا'); // lam-alef ligature
    expect(comparisonKey('ﻪﻠﻟﺍ', EXACT)).toBe('هللا');
    expect(comparisonKey('ﺃ', LETTERS)).toBe('ا'); // isolated alef with hamza above
  });

  it('keep the ornate parentheses around a verse, which have no other form', () => {
    // NFKC hands these back unchanged; the core's recursive fold never returns on them.
    expect(comparisonKey('﴿الحمد﴾', BOTH)).toBe('﴿الحمد﴾');
  });

  it('match the same text however it is encoded', () => {
    // alef + combining hamza above is أ written as one letter
    expect(comparisonKey('أحمد', EXACT)).toBe(comparisonKey('أحمد', EXACT));
    expect(comparisonKey('أحمد', MARKS)).toBe('أحمد');
  });
});
