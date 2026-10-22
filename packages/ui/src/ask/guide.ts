import { schemaToGrammar } from '../ai/device/grammar';

/**
 * Show me, Explain this and Do it for me: Ask ZOOD's pointer on the screen.
 *
 * Show me and Do it for me go one step at a time. The first step comes with
 * the decision (`plan.ts`); after each one the screen is looked at again and
 * the model is asked for the next, told the goal and the steps already
 * taken — so a step is always placed on the screen as it is now, not as it
 * was before the last click. Show me waits for the person to click; Do it
 * for me clicks itself, inside ZOOD PDF only, and stops before anything
 * that sends, deletes, pays or signs until the person says so. Explain this
 * is one look: the parts of the screen worth knowing, walked through in
 * order while each is said aloud.
 */

export type GuideMode = 'show' | 'do' | 'explain';

/** The most steps one request takes; then it stops and says so. */
export const MAX_STEPS = 8;
/** The most parts one explanation walks through. */
export const MAX_PARTS = 6;
/** How near a click must land to the step, as part of the screen's width. */
export const NEAR = 0.07;

export interface Step {
  /** What to do there, said aloud and written by the pointer. */
  say: string;
  /** Thousandths of the picture, as the vision models answer. */
  x: number;
  y: number;
}

export interface NextStep {
  done: boolean;
  say: string;
  step: Step | null;
}

function coordinate(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1000, Math.max(0, Math.round(value)))
    : -1;
}

function words(value: unknown, most: number): string {
  return typeof value === 'string' ? value.trim().slice(0, most) : '';
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stepOf(raw: Record<string, unknown>): Step | null {
  const say = words(raw.say, 160);
  const x = coordinate(raw.x);
  const y = coordinate(raw.y);
  return say && x >= 0 && y >= 0 ? { say, x, y } : null;
}

/** The next step's shape: done, or what to do and where. */
export function stepGrammar(): string {
  return schemaToGrammar({
    type: 'object',
    properties: {
      done: { type: 'boolean' },
      say: { type: 'string' },
      x: { type: 'integer' },
      y: { type: 'integer' },
    },
    required: ['done', 'say', 'x', 'y'],
  });
}

/** An explanation's shape: a line about the whole, and the parts in order. */
export function partsGrammar(): string {
  return schemaToGrammar({
    type: 'object',
    properties: {
      say: { type: 'string' },
      parts: {
        type: 'array',
        items: {
          type: 'object',
          properties: { say: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' } },
          required: ['say', 'x', 'y'],
        },
      },
    },
    required: ['say', 'parts'],
  });
}

function languageLine(language: 'ar' | 'en'): string {
  return language === 'ar'
    ? 'The person speaks Arabic: every "say" is in Arabic.'
    : 'The person speaks English: every "say" is in English.';
}

/** What the model is told when it is asked for the step after `taken`. */
export function nextStepPrompt(
  goal: string,
  taken: readonly string[],
  mode: 'show' | 'do',
  language: 'ar' | 'en',
): string {
  return [
    "You are Ask ZOOD, guiding the person on their own computer's screen, shown in the picture.",
    `Their goal: "${goal.slice(0, 400)}"`,
    taken.length
      ? `Steps already taken, in order:\n${taken.map((one, index) => `${index + 1}. ${one}`).join('\n')}`
      : 'No step has been taken yet.',
    mode === 'do'
      ? 'Give the ONE next click that moves towards the goal, as it is on the screen now.'
      : 'Give the ONE next thing the person should click, as it is on the screen now.',
    'Put the place in "x" and "y", in thousandths of the picture\'s width and height (0 to 1000), on the middle of the button, link or field. Put what to do there in "say", in a few words (like "Click Save").',
    'When the goal is reached, or the screen shows it cannot be reached, set "done" to true and say so in "say" in one short sentence; x and y are then 0.',
    'Never repeat a step already taken unless the screen shows it did not work. Never invent a button that is not in the picture.',
    languageLine(language),
  ].join('\n');
}

/** What the model is told to explain the screen. */
export function explainPrompt(goal: string, language: 'ar' | 'en'): string {
  return [
    "You are Ask ZOOD, explaining the screen in the picture to the person, on their own computer.",
    `They asked: "${goal.slice(0, 400)}"`,
    `Pick the ${MAX_PARTS} or fewer parts of the screen most worth knowing for that question, in the order a person reads them (start at the top). For each, "x" and "y" are its middle in thousandths of the picture's width and height (0 to 1000), and "say" is one short sentence on what it is or does.`,
    'Put one short sentence about the whole screen in the top "say". Only parts that are really in the picture.',
    languageLine(language),
  ].join('\n');
}

/** The model's next step, or null when it is not one. */
export function readNextStep(text: string): NextStep | null {
  const raw = parse(text);
  if (!raw) return null;
  const say = words(raw.say, 160);
  if (raw.done === true) return { done: true, say, step: null };
  const step = stepOf(raw);
  return step ? { done: false, say: step.say, step } : null;
}

/** The model's explanation: its line, and the parts that are on the screen. */
export function readParts(text: string): { say: string; parts: Step[] } | null {
  const raw = parse(text);
  if (!raw) return null;
  const parts = (Array.isArray(raw.parts) ? raw.parts : [])
    .map((part) => (part && typeof part === 'object' ? stepOf(part as Record<string, unknown>) : null))
    .filter((part): part is Step => part !== null)
    .slice(0, MAX_PARTS);
  const say = words(raw.say, 300);
  return say || parts.length ? { say, parts } : null;
}

/**
 * A step that sends, deletes, pays, buys, signs or submits: Do it for me
 * stops before it until the person says so. In English and Arabic, from
 * the step's words and the goal's.
 */
const RISKY = [
  /\b(send|sent|submit|post|publish|delete|remove|erase|trash|discard|pay|payment|purchase|buy|order|checkout|transfer|signature|sign(?!\s?(?:in|up)\b)|approve|confirm|overwrite|replace all|empty|format|uninstall|log ?out|sign ?out)\b/i,
  /(أرسل|ارسل|إرسال|ارسال|يرسل|نشر|انشر|احذف|حذف|امسح|مسح|إزالة|ازالة|ادفع|دفع|سداد|اشتر|شراء|اطلب|تحويل|حوّل|حول المبلغ|وقّع|وقع|توقيع|اعتماد|اعتمد|تأكيد|أكّد|أكد|استبدال|إلغاء التثبيت|تسجيل الخروج)/,
];

export function risky(text: string): boolean {
  return RISKY.some((pattern) => pattern.test(text));
}

/** A click at `click` reached the step at `target` (both 0..1 of the screen). */
export function near(
  click: { x: number; y: number },
  target: { x: number; y: number },
  aspect = 16 / 9,
): boolean {
  const dx = click.x - target.x;
  // Down the screen counts by the screen's own shape, so the circle is round.
  const dy = (click.y - target.y) / aspect;
  return Math.hypot(dx, dy) <= NEAR;
}

/** How long a part of an explanation stays when it cannot be heard. */
export function readingTime(text: string): number {
  return Math.min(7000, Math.max(2600, text.length * 70));
}

/** What a guide says at its end, in the language the person asked in. */
const ENDINGS = {
  done: { en: 'Done.', ar: 'تم.' },
  explained: { en: "That's the screen.", ar: 'هذه الشاشة.' },
  lost: { en: "I couldn't find the next step on the screen.", ar: 'ما لقيت الخطوة التالية على الشاشة.' },
  tooMany: { en: 'I stopped after {count} steps.', ar: 'توقفت بعد {count} خطوات.' },
} as const;

export function ending(kind: keyof typeof ENDINGS, language: 'ar' | 'en'): string {
  return ENDINGS[kind][language].replace('{count}', String(MAX_STEPS));
}
