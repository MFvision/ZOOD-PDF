import type { SuggestionKind } from './plan';

/**
 * What the person said to a Sort window, through Ask ZOOD: which suggestions
 * to do and which to leave, in Saudi Arabic or English. Fixed words, no
 * model: "merge them but don't rename", "ادمجها ولا تغير الأسماء", "كلها",
 * "تراجع". Words it does not know are said back as a question, never guessed.
 */

export type SortAnswer =
  | { kind: 'do'; all: boolean; only: SuggestionKind[]; skip: SuggestionKind[] }
  | { kind: 'undo' }
  | { kind: 'close' }
  | { kind: 'unknown' };

/** Word starts, after "و" / "ف" / "ال" come off an Arabic word. */
const KIND_WORDS: Record<SuggestionKind, readonly string[]> = {
  merge: ['merge', 'combine', 'join', 'together', 'ادمج', 'دمج', 'تدمج', 'اجمع', 'جمع', 'تجمع', 'ضم', 'اضم', 'تضم'],
  split: ['split', 'separat', 'break', 'افصل', 'فصل', 'تفصل', 'قسم', 'قسّم', 'تقسم', 'فرق', 'فرّق', 'تفرق'],
  folders: ['folder', 'organi', 'sort', 'tidy', 'مجلد', 'رتب', 'رتّب', 'ترتب', 'ترتيب', 'نظم', 'نظّم', 'تنظم', 'تنظيم'],
  rename: ['rename', 'name', 'سم', 'سمّ', 'تسمي', 'تسمية', 'اسم', 'أسم', 'اسماء', 'أسماء', 'الاسم'],
};
const ALL = ['all', 'everything', 'yes', 'ok', 'okay', 'sure', 'go', 'كل', 'كلها', 'كله', 'نعم', 'ايه', 'إيه', 'اي', 'أي', 'تمام', 'موافق', 'نفذ', 'نفّذ', 'سو', 'سوي', 'سوّ', 'يلا', 'طيب', 'اوكي', 'أوكي'];
const NOT = ['dont', "don't", 'do not', 'no', 'not', 'without', 'skip', 'except', 'leave', 'لا', 'ما', 'بدون', 'بلاش', 'مو', 'غير', 'عدا', 'خل', 'خلي', 'اترك'];
const UNDO = ['undo', 'back', 'تراجع', 'رجع', 'ارجع', 'رجّع', 'رجعها', 'ارجعها'];
const CLOSE = ['close', 'cancel', 'stop', 'nevermind', 'اقفل', 'سكر', 'الغ', 'الغي', 'إلغاء', 'الغاء', 'خلاص'];
/** A new clause: what was "not" before it is done with. */
const BREAK = ['but', 'and', 'then', 'also', 'لكن', 'بس', 'ثم', 'وبعدين', 'بعدين', 'كمان'];

const lower = (text: string) => text.toLowerCase().replace(/[’‘]/g, "'").replace(/[ًٌٍَُِّْـ]/g, '');

/** The forms a word may be said in: itself, and without "و", "ف", "ب", "ال". */
function forms(token: string): string[] {
  const found = new Set([token]);
  for (const prefix of ['و', 'ف']) if (token.startsWith(prefix) && token.length >= 3) found.add(token.slice(1));
  for (const form of [...found]) if (form.startsWith('ال') && form.length > 4) found.add(form.slice(2));
  return [...found];
}

const startsAny = (token: string, list: readonly string[]) => forms(token).some((form) => list.some((word) => form.startsWith(lower(word))));
const isAny = (token: string, list: readonly string[]) => forms(token).some((form) => list.some((word) => form === lower(word)));

export function readAnswer(said: string): SortAnswer {
  // An answer to a Sort window is a few words: a page of them is read no further.
  const text = lower(said.slice(0, 1000)).replace(/\b(do not|don't)\b/g, 'dont').replace(/\b(put back|never mind)\b/g, (m) => m.replace(' ', ''));
  const tokens = text.split(/[\s,.!?؟،:;]+/).filter(Boolean);
  if (tokens.length === 0) return { kind: 'unknown' };
  const only = new Set<SuggestionKind>();
  const skip = new Set<SuggestionKind>();
  let all = false;
  let not = false;
  let undo = false;
  let close = false;
  for (const token of tokens) {
    if (isAny(token, BREAK)) {
      not = false;
      continue;
    }
    if (isAny(token, NOT)) {
      not = true;
      continue;
    }
    if (startsAny(token, UNDO)) {
      undo = true;
      continue;
    }
    const kind = (Object.keys(KIND_WORDS) as SuggestionKind[]).find((k) => startsAny(token, KIND_WORDS[k]));
    if (kind) {
      (not ? skip : only).add(kind);
      // "don't merge or split": "not" holds to the end of the clause.
      continue;
    }
    if (isAny(token, ALL)) all = true;
    else if (isAny(token, CLOSE)) close = true;
  }
  if (undo && only.size === 0) return { kind: 'undo' };
  for (const kind of skip) only.delete(kind);
  // "No, leave it": nothing to do.
  if (only.size === 0 && skip.size === 0 && !all) return close || not ? { kind: 'close' } : { kind: 'unknown' };
  // "Do it but don't rename": all, less what was not wanted.
  if (only.size === 0) all = true;
  return { kind: 'do', all, only: [...only], skip: [...skip] };
}
