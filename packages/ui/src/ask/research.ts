import { normalize } from '../ai/chat/commands';
import { valueOf } from '../export/tables';
import type { Sheet, SheetCell } from '../export/tables';
import { buildXlsx, sheetNames } from '../export/xlsx';

/**
 * "Search the internet for…": Ask ZOOD looks it up for the person. The host
 * runs the search and fetches the pages as text (`ask/web.rs`) — only the
 * search words and the pages' addresses leave the computer — and the local
 * model writes the answer from what they say: a few lines with their
 * sources, or, for things to compare or buy, a table with a Link column
 * that can be kept as an Excel sheet.
 */

export interface WebHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebPage {
  url: string;
  title: string;
  text: string;
}

/** Pages read for one answer: the first results, the rest only by their lines. */
export const PAGES_READ = 4;

// Words that put the request on the web: "search online for…", "on the internet", «دور في النت».
const WEB =
  /\b(?:search|look up|look|google|check|browse|research|find|get)\b.*\b(?:web|internet|online|google)\b|\b(?:on|from|in) the (?:web|internet|net)\b|^google\b|(?:^| )(?:ابحث|دور|دورلي|شوف|قوقل|جوجل|طلع|طلعلي|جيب|جيبلي)(?= ).*(?:النت|الانترنت|الويب|جوجل|قوقل|اونلاين|اون لاين)|(?:^| )(?:في|من|على) ?(?:النت|الانترنت|الويب)(?= |$)/;
// Things to buy or compare, with a price or a limit: "three accessories under $100".
const SHOP = /\b(?:find|compare|recommend|suggest|cheapest|best|buy|shop for|look for|list)\b|(?:^| )(?:دور|دورلي|ابحث|قارن|اقترح|ارخص|افضل|اشتري|ابي|ابغي|ابغى)(?= |$)/;
const PRICE =
  /\$ ?\d|\d ?\$|\b(?:under|below|less than|cheaper than|max(?:imum)?|budget)\b ?\$? ?\d|\b(?:prices?|dollars?|usd|riyals?|sar|euros?|deals?)\b|(?:^| )(?:اقل من|تحت|بحدود|ميزانيه|سعر|اسعار|ريال|دولار|بسعر)(?= |\d|$)/;
// Something that changes by the day: the forecast, the news, today's price.
const LIVE =
  /\b(?:weather|forecast|news|exchange rate|stock|score|flights?)\b.*\b(?:today|now|tomorrow|this week|latest|current|right now)\b|\b(?:today'?s|latest|current)\b.*\b(?:weather|forecast|news|prices?|rate)\b|(?:الطقس|الجو|الاخبار|اخبار|سعر|اسعار|الرحلات).*(?:اليوم|الحين|الان|حاليا|بكره|هالاسبوع)/;
// The person's own files are searched in the Library, never on the web.
const LOCAL =
  /\b(?:my (?:files|documents|computer|pdfs?|library|desktop|downloads)|library|this (?:pdf|file|document|page)|the (?:pdf|file|document)|on (?:my|this) computer)\b|(?:ملفاتي|المكتبه|هذا الملف|هالملف|جهازي|مستنداتي)/;

/** Whether `words` ask for something to be looked up on the web. */
export function researchAsked(words: string): boolean {
  const said = normalize(words);
  if (!said || LOCAL.test(said)) return false;
  if (WEB.test(said)) return true;
  if (LIVE.test(said)) return true;
  return SHOP.test(said) && PRICE.test(said);
}

// What is said around the search itself: "please search the web for", "and put them in a sheet".
const LEAD =
  /^(?:(?:hey |ok |okay )?zood[, ]+|please |can you |could you |would you |i want you to |i need you to |go )*(?:search|look up|google|find(?: me)?|look for|check|browse|research|get(?: me)?|show me)?(?: (?:the )?(?:web|internet|online|google))?(?: for| about)?\s+/i;
const WHERE = /\s*\b(?:on|from|in|using|across) (?:the )?(?:web|internet|google|net)\b|\s*\bonline\b/gi;
const TAIL =
  /\s+(?:and|then|,)\s+(?:put|add|make|give|write|save|list|create|keep|send|show)\b.*$|\s*(?:,|and)?\s*(?:with|including) (?:their |the )?(?:prices?|links?)\b.*$/i;
const AR_LEAD =
  /^(?:(?:يا )?زود[، ]+|لو سمحت |ممكن |ابيك |ابغاك |ابغى |ابي )*(?:ابحث|دور|دوّر|قوقل|جوجل|شوف|طلع|جيب)(?:لي| لي)?(?: (?:في|ب|على|من) ?(?:النت|الانترنت|الإنترنت|الويب|جوجل|قوقل))?(?: عن)?\s+/;
const AR_WHERE = /\s*(?:في|ب|على|من) ?(?:النت|الانترنت|الإنترنت|الويب|جوجل|قوقل)/g;
const AR_TAIL = /\s+(?:و|ثم |وبعدين )(?:حط|ضع|حطها|سو|اعمل|اكتب|احفظ|سجل|رتب)\S*.*$|\s+(?:مع|بـ?)(?:ال)?(?:اسعار|أسعار|روابط|الروابط)\S*.*$/;

/** The words to search for: the request without "search the web for" and "put it in a sheet". */
export function researchQuery(words: string): string {
  const said = words.replace(/\s+/g, ' ').trim();
  const query = said
    .replace(AR_LEAD, '')
    .replace(AR_TAIL, '')
    .replace(AR_WHERE, '')
    .replace(LEAD, '')
    .replace(TAIL, '')
    .replace(WHERE, '')
    .replace(/[?؟.!]+$/, '')
    .trim();
  return (query.length >= 3 ? query : said).slice(0, 200);
}

/** Whether the answer should be a table: things to compare, buy, list or put in a sheet. */
export function wantsTable(words: string): boolean {
  const said = normalize(words);
  return (
    (SHOP.test(said) && PRICE.test(said)) ||
    /\b(?:table|sheet|spreadsheet|excel|list|compare|comparison|options|prices?|links?)\b|(?:^| )(?:جدول|اكسل|شيت|قائمه|قارن|مقارنه|خيارات|اسعار|روابط)(?= |$)/.test(said)
  );
}

/** Letters a page may give the model, from the room the window has: a share each. */
export function shareOf(roomChars: number, pages: number): number {
  return Math.max(400, Math.floor(roomChars / Math.max(1, pages)));
}

/**
 * The messages for the answer: what was asked, and the sources numbered —
 * the pages read in full (each cut to its share), then the other results by
 * their search lines.
 */
export function researchMessages(
  words: string,
  hits: readonly WebHit[],
  pages: readonly (WebPage | null)[],
  language: 'ar' | 'en',
  roomChars: number,
  today: string,
): { role: 'system' | 'user'; content: string }[] {
  const table = wantsTable(words);
  const share = shareOf(roomChars - hits.length * 200, Math.max(1, pages.filter(Boolean).length));
  const sources = hits.map((hit, k) => {
    const page = pages[k] ?? null;
    const body = page?.text ? page.text.slice(0, share) : hit.snippet;
    return `[${k + 1}] ${page?.title || hit.title}\n${page?.url || hit.url}\n${body}`.trim();
  });
  const rules = [
    `You are Ask ZOOD, an assistant on the person's computer. You searched the web for them; the results are below, numbered. Today is ${today}.`,
    'Answer the request from these sources only. Never invent a price, a date, a number or a product the sources do not show; when a source does not give one, write "not shown" (in Arabic «غير مذكور»).',
    table
      ? 'Answer with a Markdown table and nothing before it except one short line. The first row is the header. One row for each item, as many as they asked for (five when they did not say). Include the price when it matters, and make the last column "Link" (in Arabic «الرابط») with the full address of the source the row comes from. After the table, one line saying prices may have changed.'
      : 'Answer in a few short sentences or numbered points, then a last line "Sources:" (in Arabic «المصادر:») with the numbers you used, like [1] [3].',
    language === 'ar'
      ? 'Write in Arabic, the language of the request.'
      : 'Write in English, the language of the request.',
  ];
  return [
    { role: 'system', content: rules.join('\n') },
    { role: 'user', content: `Request: ${words.trim()}\n\nSources:\n\n${sources.join('\n\n')}` },
  ];
}

/** The sources as lines under an answer: "1. Title — address". */
export function sourceLines(hits: readonly WebHit[]): string {
  return hits.map((hit, k) => `${k + 1}. ${hit.title} — ${hit.url}`).join('\n');
}

/** The rows of the first Markdown table in `text`; null when there is none. */
export function markdownTable(text: string): string[][] | null {
  const rows: string[][] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) {
      if (rows.length > 0) break;
      continue;
    }
    // The line under the header: | --- | :---: |
    if (/^\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{0,}:?\s*$/.test(line)) continue;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
    rows.push(cells);
  }
  return rows.length >= 2 ? rows : null;
}

const ARABIC = /[؀-ۿ]/;
const ADDRESS = /https?:\/\/[^\s)<>\]]+/;

/** A cell of the sheet: a number as a number, an address as a link. */
function cellOf(text: string): SheetCell | null {
  const plain = text.replace(/\*\*|__|`/g, '').trim();
  if (!plain) return null;
  const markdownLink = plain.match(/^\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)$/);
  if (markdownLink) return { value: { kind: 'text', text: markdownLink[2]! }, link: markdownLink[2]! };
  const address = plain.match(ADDRESS)?.[0];
  if (address && address.length >= plain.length - 2) return { value: { kind: 'text', text: address }, link: address };
  return { value: valueOf(plain) };
}

/**
 * An answer as a sheet: its table, header row first, or each line a row
 * when it has none. Right to left when the answer is Arabic.
 */
export function answerSheet(name: string, answer: string): Sheet {
  const table = markdownTable(answer);
  const rows = table ?? answer.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => [line]);
  const columns = Math.max(1, ...rows.map((row) => row.length));
  const cells = rows.map((row) => Array.from({ length: columns }, (_, c) => cellOf(row[c] ?? '')));
  const widths = Array.from({ length: columns }, (_, c) =>
    Math.min(60, Math.max(8, ...rows.map((row) => (row[c] ?? '').length + 2))),
  );
  if (table && cells[0]) {
    cells[0] = cells[0].map((cell) => (cell ? { ...cell, fill: '1F3A5F', color: 'FFFFFF', border: true } : cell));
  }
  return { name: sheetNames([name])[0] ?? 'Sheet1', rtl: ARABIC.test(answer), rows: cells, widths };
}

/** The answer as an Excel workbook. */
export function answerXlsx(name: string, answer: string): Uint8Array<ArrayBuffer> {
  return buildXlsx([answerSheet(name, answer)]);
}
