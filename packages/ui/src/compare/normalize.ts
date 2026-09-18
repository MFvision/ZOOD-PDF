/**
 * How two words are judged the same when comparing versions of a document.
 *
 * The rules mirror Warraq's search, `packages/core/warraq-text/src/normalize.rs`
 * (`is_mark_or_control`, `is_presentation_form`, `normalize_char`), so a word
 * the search finds is a word the comparison matches:
 *
 * - always: Arabic presentation forms (U+FB50–U+FDFF, U+FE70–U+FEFF) become
 *   the letters they stand for (NFKC), as `normalize_char` always does — ﻻ is
 *   لا. The whole word is also put in canonical form (NFC) first, so alef
 *   followed by a combining hamza is the same word as أ written as one letter;
 *   the two are the same text, differently encoded.
 * - `ignoreMarks` (`SearchNormalization::ignore_marks`): drops exactly what
 *   `is_mark_or_control` drops — tashkeel U+064B–U+065F, the dagger alef
 *   U+0670, Quranic marks U+06D6–U+06ED, tatweel U+0640, combining marks
 *   U+0300–U+036F and U+20D0–U+20FF, and the invisible direction and width
 *   controls U+200B–U+200F, U+202A–U+202E, U+2066–U+2069, U+FEFF.
 * - `unifyLetters` (`unify_alef`, `unify_taa_marbuta`, `unify_yaa`): أ إ آ ٱ → ا,
 *   ة → ه, ى → ي, and Persian ی → ي with them, as `unify_yaa` does. The core
 *   folds keheh ک → ك always; here that waits for this option too, because
 *   the two letters look different on the page.
 *
 * Deliberately not mirrored: the search also folds Arabic-Indic digits to
 * ASCII and ignores case. Those are visible edits to a document — "٢٠٢٦"
 * rewritten as "2026" — and a comparison has to show them.
 */

export interface CompareOptions {
  /** Ignore tashkeel, tatweel and the other marks and controls search ignores. */
  ignoreMarks: boolean;
  /** Count the alef variants, taa marbuta and haa, alef maqsura and yaa as one letter each. */
  unifyLetters: boolean;
}

export const EXACT: CompareOptions = { ignoreMarks: false, unifyLetters: false };

/** `is_mark_or_control` in normalize.rs, range for range. */
export function isMarkOrControl(codePoint: number): boolean {
  return (
    (codePoint >= 0x064b && codePoint <= 0x065f) ||
    codePoint === 0x0670 ||
    (codePoint >= 0x06d6 && codePoint <= 0x06ed) ||
    codePoint === 0x0640 ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  );
}

/** `is_presentation_form` in normalize.rs. */
export function isPresentationForm(codePoint: number): boolean {
  return (codePoint >= 0xfb50 && codePoint <= 0xfdff) || (codePoint >= 0xfe70 && codePoint <= 0xfeff);
}

/** The letter mappings of `normalize_char` that `unifyLetters` turns on. */
const LETTERS: Readonly<Record<string, string>> = {
  'أ': 'ا',
  'إ': 'ا',
  'آ': 'ا',
  'ٱ': 'ا',
  'ة': 'ه',
  'ى': 'ي',
  'ی': 'ي',
  'ک': 'ك',
};

/**
 * One presentation form as the letters it stands for. Once, not recursively:
 * some code points in these blocks have no compatibility decomposition (the
 * ornate parentheses ﴾ ﴿ around Quranic verses, U+FEFF), and NFKC hands them
 * back unchanged.
 */
function foldPresentationForm(char: string): string {
  return char.normalize('NFKC');
}

/**
 * The form of `word` that comparison matches on. The empty string means the
 * word has nothing left to compare — a lone tatweel, with marks ignored.
 */
export function comparisonKey(word: string, options: CompareOptions): string {
  let key = '';
  for (const char of word.normalize('NFC')) {
    const codePoint = char.codePointAt(0) ?? 0;
    const letters = isPresentationForm(codePoint) ? foldPresentationForm(char) : char;
    for (const letter of letters) {
      if (options.ignoreMarks && isMarkOrControl(letter.codePointAt(0) ?? 0)) continue;
      key += options.unifyLetters ? (LETTERS[letter] ?? letter) : letter;
    }
  }
  return key;
}
