/**
 * Choices said aloud, and chosen by voice.
 *
 * When Ask ZOOD was not sure what was meant it said only "Which one did you
 * mean?" or "Did you mean one of these?", and the choices were on the screen
 * alone: someone listening, not looking, heard a question with nothing to
 * answer it with (owner, 2026-10-31). Now the choices are read out, in order,
 * and the answer can be spoken back: "the second", «الأول», or a choice's name.
 */

const ORDINALS: Readonly<Record<'ar' | 'en', readonly string[]>> = {
  en: ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'],
  ar: ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس'],
};

/**
 * The question and its choices as one thing to say. Two choices read as a
 * question ("Which one did you mean: Compress, or Organise?"); more are
 * numbered ("First, Protect. Second, Compress."), so "the second" answers.
 * `other` is the way out ("Something else"), said last.
 */
export function sayChoices(question: string, names: readonly string[], lang: 'ar' | 'en', other?: string): string {
  const shown = names.map((name) => name.trim()).filter(Boolean);
  if (shown.length === 0) return question;
  const ask = question.replace(/[?؟]\s*$/, '');
  if (shown.length === 2 && !other) {
    return lang === 'ar' ? `${ask}: ${shown[0]}، أم ${shown[1]}؟` : `${ask}: ${shown[0]}, or ${shown[1]}?`;
  }
  const ordinals = ORDINALS[lang];
  const listed = shown.map((name, i) => `${ordinals[i] ?? String(i + 1)}: ${name}.`).join(' ');
  const end = other ? (lang === 'ar' ? ` أو قل: ${other}.` : ` Or say: ${other}.`) : '';
  return `${question} ${listed}${end}`;
}

/** Letters only, the forms of alef and yaa as one, so «الأولى» meets «الاولى». */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** How each place is said, in both languages, as `plain` leaves it. */
const PLACES: readonly (readonly string[])[] = [
  ['first', 'one', '1', '١', 'number one', 'the first', 'الاول', 'الاولي', 'واحد', 'رقم واحد', 'اول', 'اول واحد'],
  ['second', 'two', '2', '٢', 'number two', 'the second', 'الثاني', 'الثانيه', 'اثنين', 'اثنان', 'رقم اثنين', 'ثاني', 'الثاني واحد'],
  ['third', 'three', '3', '٣', 'number three', 'the third', 'الثالث', 'الثالثه', 'ثلاثه', 'رقم ثلاثه', 'ثالث'],
  ['fourth', 'four', '4', '٤', 'number four', 'the fourth', 'الرابع', 'الرابعه', 'اربعه', 'رقم اربعه', 'رابع'],
  ['fifth', 'five', '5', '٥', 'number five', 'the fifth', 'الخامس', 'الخامسه', 'خمسه', 'رقم خمسه', 'خامس'],
  ['sixth', 'six', '6', '٦', 'number six', 'the sixth', 'السادس', 'السادسه', 'سته', 'رقم سته', 'سادس'],
];
const LAST = ['last', 'the last', 'last one', 'الاخير', 'الاخيره', 'اخر واحد'];

/** Filler around an answer: "the second one please", «أبي الثاني». */
const FILLER = /\b(?:the|one|please|option|choice|i mean|i meant|i want|go with|number)\b|(?:^|\s)(?:ابي|ابغي|اريد|ابغا|خيار|الخيار|رقم|لو سمحت|من فضلك|يا|طيب)(?=\s|$)/g;

/**
 * Which of `names` the words choose, from 0, or null when they choose none:
 * by place ("the second", «الثالث», "2"), "the last", or by the choice's
 * own name said whole ("compress"). Only a short answer counts: a new
 * request that happens to contain "first" is a new request.
 */
export function pickByWords(words: string, names: readonly string[]): number | null {
  const said = plain(words);
  if (!said || said.split(' ').length > 6) return null;
  const bare = said.replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < Math.min(names.length, PLACES.length); i += 1) {
    if (PLACES[i]!.some((way) => bare === way || said === way)) return i;
  }
  if (names.length > 0 && LAST.some((way) => bare === way || said === way)) return names.length - 1;
  const named = names
    .map((name, i) => ({ i, name: plain(name) }))
    .filter(({ name }) => name.length > 1 && (bare === name || said === name || bare.includes(name)));
  return named.length === 1 ? named[0]!.i : null;
}

/** Whether the words are a choice's own name, said alone ("something else", «شيء آخر»). */
export function namesIt(words: string, name: string): boolean {
  const said = plain(words);
  const wanted = plain(name);
  if (!said || !wanted) return false;
  return said === wanted || said.replace(FILLER, ' ').replace(/\s+/g, ' ').trim() === wanted;
}
