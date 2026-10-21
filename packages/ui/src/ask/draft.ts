import { schemaToGrammar } from '../ai/device/grammar';
import { examplesFor } from './style';
import type { WritingStyle } from './style';

/**
 * Double tap: the window the person is working in is read, and the model
 * decides between drafting the reply they owe there — in their way of
 * writing, with what their notes and documents say — and, when the window
 * is not a conversation, suggesting what Ask ZOOD could do with it. The
 * reply is pasted where the cursor is and never sent (`ask_paste`).
 *
 * A model that reads pictures is shown the window itself; a text model is
 * given its words, read by the app's own recogniser in the island.
 */

export interface DraftContext {
  /** The app and title of the window in front. */
  app: string;
  title: string;
  /** The window's words when the model does not see it; empty when it does. */
  text: string;
  sees: boolean;
  style: WritingStyle;
  /** Lines found in the person's Library about this window. */
  documents: readonly DocumentLine[];
  /** Today, as the model is told it (dates in replies). */
  today: string;
}

export interface DocumentLine {
  name: string;
  page: number;
  text: string;
}

export interface Draft {
  kind: 'reply' | 'suggest';
  /** One short sentence the island shows. */
  say: string;
  /** The reply, for `reply`. */
  text: string;
  /** Up to three requests the person can make with one click, for `suggest`. */
  ideas: string[];
}

/** How much of the window's words the model is given, in characters. */
export const WINDOW_BUDGET = 3200;
const EXAMPLES_BUDGET = 1600;
const DOCUMENTS_BUDGET = 800;

/**
 * The window's words cut to fit: its start (who, what about) and its end
 * (the newest message in most chats) when there is more than fits.
 */
export function fitWindowText(text: string, budget: number = WINDOW_BUDGET): string {
  const clean = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (clean.length <= budget) return clean;
  const head = Math.floor(budget * 0.35);
  return `${clean.slice(0, head).trim()}\n[…]\n${clean.slice(clean.length - (budget - head)).trim()}`;
}

/** What the person wrote about themselves and how they write, as the prompt says it. */
export function styleLines(style: WritingStyle): string[] {
  const lines: string[] = [];
  if (style.about.trim()) lines.push('About the person (they wrote this):', style.about.trim(), '');
  const examples = examplesFor(style, EXAMPLES_BUDGET);
  if (examples.length) {
    lines.push(
      'Messages the person wrote themselves — match their tone, length, greetings and sign-off:',
    );
    examples.forEach((example, k) =>
      lines.push(`<example ${k + 1}>`, example, `</example ${k + 1}>`),
    );
    lines.push('');
  }
  return lines;
}

/** Lines from the Library, as the prompt says them. */
export function documentLines(documents: readonly DocumentLine[]): string[] {
  if (documents.length === 0) return [];
  const lines = ["From the person's own documents (their ZOOD Library) — use only if relevant:"];
  let used = 0;
  for (const line of documents) {
    const text = `- ${line.name}, page ${line.page + 1}: ${line.text.trim()}`;
    if (used + text.length > DOCUMENTS_BUDGET) break;
    lines.push(text);
    used += text.length;
  }
  lines.push('');
  return lines;
}

export function draftSystemPrompt(context: DraftContext): string {
  const where = [context.app, context.title].filter(Boolean).join(' — ') || 'an app';
  const lines = [
    `You are ZOOD, an assistant running on the person's own computer. They double-tapped a key while working in ${where}. Today is ${context.today}.`,
    context.sees
      ? 'The picture is that window.'
      : 'Below is the text of that window, read from the screen (it may have small reading mistakes and parts of the app around it).',
    '',
    'Decide one thing:',
    '- "reply": the window shows an email, chat or message the person should answer. Write, in "text", the reply they would send, as them, in the language the conversation is in (Arabic or English). Only the message body: no subject line, and do not repeat the earlier messages. Put a short note of what you wrote in "say".',
    '- "suggest": the window is not a conversation to answer (a document, a web page, a form, a spreadsheet). In "say", say in one short sentence what you see and how you can help; in "ideas", give up to three short requests the person could ask you next, in their language (for example "Summarise this page", "Translate it to Arabic", "Draft an email about it"). Leave "text" empty.',
    '',
    ...styleLines(context.style),
    ...documentLines(context.documents),
    'Rules: never invent facts, numbers, dates, prices or promises that are not in the window, the notes or the documents; where a detail is unknown, leave it in square brackets, like [date] or [price]. Answer what was actually asked, politely and briefly, the way the person writes. Never say you are an AI.',
  ];
  return lines.join('\n');
}

export function draftUserMessage(context: DraftContext): string {
  if (context.sees) return 'Draft the reply, or suggest what to do.';
  const text = fitWindowText(context.text);
  return `The window's text:\n<window>\n${text || '(no text could be read)'}\n</window>\n\nDraft the reply, or suggest what to do.`;
}

export function draftGrammar(): string {
  return schemaToGrammar({
    type: 'object',
    properties: {
      kind: { enum: ['reply', 'suggest'] },
      say: { type: 'string' },
      text: { type: 'string' },
      ideas: { type: 'array', items: { type: 'string' } },
    },
    required: ['kind', 'say', 'text', 'ideas'],
  });
}

/** The model's JSON as a draft, or null when it is not one. */
export function readDraft(json: string): Draft | null {
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const say = typeof raw.say === 'string' ? raw.say.trim().slice(0, 300) : '';
  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, 8000) : '';
  const ideas = Array.isArray(raw.ideas)
    ? raw.ideas
        .filter((idea): idea is string => typeof idea === 'string')
        .map((idea) => idea.trim().slice(0, 80))
        .filter((idea) => idea.length > 0)
        .slice(0, 3)
    : [];
  if (raw.kind === 'reply' && text) return { kind: 'reply', say, text, ideas: [] };
  if (say || ideas.length) return { kind: 'suggest', say, text: '', ideas };
  return null;
}

const STOP = new Set(
  [
    // English
    'about',
    'after',
    'again',
    'there',
    'their',
    'these',
    'those',
    'which',
    'while',
    'would',
    'could',
    'should',
    'thanks',
    'thank',
    'hello',
    'regards',
    'please',
    'today',
    'tomorrow',
    'yesterday',
    'other',
    'where',
    'being',
    'think',
    'still',
    'reply',
    'forward',
    'subject',
    'inbox',
    'message',
    'messages',
    'sent',
    'from',
    'below',
    'above',
    'every',
    'great',
    'sure',
    'let',
    'know',
    'with',
    'have',
    'this',
    'that',
    'your',
    'will',
    'just',
    'what',
    'when',
    'into',
    'more',
    'some',
    'than',
    'then',
    'them',
    'they',
    'were',
    'been',
    'also',
    'only',
    'very',
    'like',
    'next',
    'week',
    'call',
    'available',
    'outlook',
    'gmail',
    'whatsapp',
    'teams',
    'slack',
    'chrome',
    'microsoft',
    'google',
    // Arabic
    'السلام',
    'عليكم',
    'مرحبا',
    'شكرا',
    'شكراً',
    'الله',
    'يعطيك',
    'العافية',
    'تحياتي',
    'الرجاء',
    'لدينا',
    'الذي',
    'التي',
    'الذين',
    'هناك',
    'حيث',
    'عندما',
    'ولكن',
    'لكن',
    'أيضا',
    'أيضاً',
    'بعد',
    'قبل',
    'إلى',
    'على',
    'عن',
    'في',
    'من',
    'مع',
    'هذا',
    'هذه',
    'ذلك',
    'تلك',
    'كان',
    'كانت',
    'يكون',
    'تكون',
    'إذا',
    'إن',
    'أن',
    'لقد',
    'قد',
    'الآن',
    'اليوم',
    'غدا',
    'غداً',
    'أمس',
    'بخصوص',
    'رسالة',
    'الرسالة',
    'رد',
    'الرد',
  ].map((word) => word.toLowerCase()),
);

/** Arabic-Indic and Persian digits as ASCII. */
export function asciiDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (digit) => String((digit.charCodeAt(0) & 0xf) % 10));
}

/**
 * The words worth looking up in the Library for this window: reference
 * numbers (invoices, orders, contracts) first, then the names and words the
 * window repeats, most telling first. Its newest part counts more.
 */
export function lookupWords(title: string, text: string, most = 4): string[] {
  const recent = text.slice(-1800);
  const scores = new Map<string, number>();
  const shown = new Map<string, string>();
  const add = (raw: string, weight: number) => {
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    const key = asciiDigits(word)
      .toLowerCase()
      .replace(/^ال(?=\p{L}{4})/u, '');
    if (!key || STOP.has(word.toLowerCase()) || STOP.has(key)) return;
    const number = /^\d{4,}$/.test(asciiDigits(word)) && !/^(19|20)\d\d$/.test(asciiDigits(word));
    const reference = /^[A-Z]{1,5}[-/]?\d{3,}$/i.test(asciiDigits(word));
    const letters = (word.match(/\p{L}/gu) ?? []).length;
    if (!number && !reference && letters < 5) return;
    const bonus = number || reference ? 4 : /^\p{Lu}/u.test(word) ? 1.5 : 1;
    scores.set(key, (scores.get(key) ?? 0) + weight * bonus);
    if (!shown.has(key)) shown.set(key, asciiDigits(word));
  };
  for (const word of title.split(/\s+/)) add(word, 2);
  for (const word of text.split(/\s+/)) add(word, 1);
  for (const word of recent.split(/\s+/)) add(word, 1);
  return [...scores.entries()]
    .filter(([, score]) => score >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, most)
    .map(([key]) => shown.get(key) ?? key);
}

/** Today as the prompt says it: "Wednesday 21 October 2026". */
export function todayWords(now: Date = new Date()): string {
  return now.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
