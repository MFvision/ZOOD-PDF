import { articlesFor } from '../../support/articles';
import type { Article } from '../../support/articles';
import { searchArticles } from '../../support/search';
import { normalize } from './commands';

/**
 * "How do I sign a PDF?" asked in the general chat is answered from Help &
 * Support's own guide, at once and on this device: the guide's steps, and
 * a way to open it (with its Show me). A small model guessing at ZOOD's own
 * buttons would get them wrong.
 */

/** A question about doing something, or finding something, in the app. */
const HOW =
  /(?:^|\s)(?:how|where|help(?: me)?|guide|steps|tutorial|can i|is there a way|كيف|شلون|وين|اين|طريقه|خطوات|ساعدني|شرح|اشرح|ابي اعرف|ابغي اعرف|هل اقدر|هل يمكن|ممكن اعرف)(?:\s|$)/;

/** Below this, the guide shares a word or two with the question but does not answer it. */
const SURE = 2.5;

/** Words nearly every guide has, which only tie them: "sign a PDF" is about signing. */
const COMMON = /(?:^|\s)(?:pdfs?|files?|documents?|zood|app|ملف|ملفات|الملف|الملفات|مستند|مستندات|زود|التطبيق)(?=\s|$)/g;

export function isHowTo(text: string): boolean {
  const said = normalize(text);
  return said.length > 0 && said.length <= 160 && HOW.test(` ${said} `);
}

/** The guide that answers a how-to question, or null for any other message. */
export function helpFor(text: string, lang: 'ar' | 'en', desktop: boolean): Article | null {
  if (!isHowTo(text)) return null;
  const asked = normalize(text).replace(COMMON, ' ');
  const [best, next] = searchArticles(asked, articlesFor(desktop), lang, 2);
  // A tie is a guess: the model, told the app's commands, does better than the wrong guide.
  if (!best || best.score < SURE || (next && next.score >= best.score)) return null;
  return best.article;
}

/** The guide as plain text, to copy or read aloud. */
export function helpText(article: Article, lang: 'ar' | 'en'): string {
  const steps = article.steps.map((step, k) => `${k + 1}. ${step[lang]}`);
  return [article.title[lang], article.summary[lang], ...steps].join('\n');
}
