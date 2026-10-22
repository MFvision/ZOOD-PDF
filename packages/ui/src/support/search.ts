import type { Lang } from '../i18n/messages';
import type { Article } from './articles';

/**
 * Finds the articles that answer a question, in Arabic or English, with no
 * model: words are folded (hamza forms, taa marbuta, alef maqsura, diacritics,
 * the article «ال», case), and each article is scored by how many of the
 * question's words its title, keywords and steps hold. Fast, and the same on
 * every device; the on-device AI, when there is one, explains the best match.
 */

const DIACRITICS = /[ً-ٰٟـ]/g;
const STOP = new Set([
  'how', 'do', 'i', 'to', 'a', 'an', 'the', 'can', 'my', 'in', 'of', 'on', 'it', 'is', 'and', 'or', 'what', 'where', 'with', 'for', 'me', 'you', 'please', 'want', 'need',
  'كيف', 'كيفيه', 'ابي', 'ابغى', 'ابغي', 'اريد', 'وين', 'اين', 'ما', 'ماذا', 'هل', 'في', 'من', 'على', 'الى', 'او', 'و', 'عن', 'مع', 'ممكن', 'لو', 'سمحت', 'طريقه', 'اسوي', 'اعمل', 'لي', 'هذا', 'هذه',
]);

export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(DIACRITICS, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
}

/** The words that carry meaning, folded, with «ال» and «و» taken off the front. */
export function words(text: string): string[] {
  return fold(text)
    .split(/\s+/)
    .map((word) => (word.length > 4 && word.startsWith('وال') ? word.slice(3) : word.length > 3 && word.startsWith('ال') ? word.slice(2) : word))
    .map((word) => (word.length > 4 && /^[بلفو]ال/.test(word) ? word.slice(3) : word))
    .filter((word) => word.length > 1 && !STOP.has(word));
}

/** A word matches another when one starts with the other (plurals, «ملف» and «ملفات», "merge" and "merging"). */
function starts(a: string, b: string): boolean {
  if (a === b) return true;
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  return short.length >= 3 && long.startsWith(short);
}

/** An Arabic verb as asked («أوقّع», «ندمج») against its stem («وقع», «دمج»): the present-tense letter off the front. */
function stem(word: string): string {
  return word.length >= 4 && /^[اينت][\u0621-\u064A]/.test(word) ? word.slice(1) : word;
}

function near(a: string, b: string): boolean {
  return starts(a, b) || starts(stem(a), b) || starts(a, stem(b));
}

export interface Found {
  article: Article;
  score: number;
}

function field(article: Article, lang: Lang): { strong: string[]; weak: string[] } {
  const other: Lang = lang === 'ar' ? 'en' : 'ar';
  return {
    strong: words([article.title[lang], article.title[other], ...article.keywords].join(' ')),
    weak: words([article.summary[lang], ...article.steps.map((step) => step[lang])].join(' ')),
  };
}

export function searchArticles(question: string, list: readonly Article[], lang: Lang, limit = 4): Found[] {
  const asked = [...new Set(words(question))];
  if (asked.length === 0) return [];
  const found: Found[] = [];
  for (const article of list) {
    const { strong, weak } = field(article, lang);
    let score = 0;
    let hits = 0;
    for (const word of asked) {
      if (strong.some((one) => near(one, word))) {
        score += 3;
        hits += 1;
      } else if (weak.some((one) => near(one, word))) {
        score += 1;
        hits += 1;
      }
    }
    if (hits === 0) continue;
    // A question answered in full beats one that shares a single common word.
    score *= 0.5 + hits / asked.length / 2;
    found.push({ article, score });
  }
  return found.sort((a, b) => b.score - a.score).slice(0, limit);
}
