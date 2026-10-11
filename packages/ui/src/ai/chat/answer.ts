import type { Lang } from '../../i18n/messages';
import type { CoreClient } from '../../core/client';
import type { PageText } from '../budget';
import type { Answer, Failure } from '../providers';
import { retrievePassages } from '../device/retrieval';
import { analyze, clip, digest, keptOutline } from './analyze';
import type { Analysis, Progress } from './analyze';
import { chunkPages, splitText } from './chunks';
import type { Kept } from './kept';
import { mostlyArabic, translatePrompt, turnPrompt } from './prompts';
import type { Material, Said } from './prompts';
import type { Runner } from './runner';

/**
 * One turn of the chat, from the request to the answer. What the model is
 * given depends on the document and on what was asked:
 *
 * - a document that fits the model's window goes whole;
 * - a request about the whole of a longer one — a summary, its key points —
 *   is answered from its analysis (`analyze.ts`), which is made first if it
 *   has not been, from every page;
 * - a question about a longer one is answered from the passages its words
 *   point to (the Library's ranking, `device/retrieval.ts`), together with
 *   the outline when the document has been analyzed;
 * - a translation is of the page on screen, a piece at a time.
 *
 * Earlier turns go with each: the last ones as they were, older ones
 * shortened. Whatever the answer was made from is returned beside it
 * (`Basis`) and shown under it: nothing is left out without the panel
 * saying what, and why.
 */
export interface DocumentText {
  pageCount: number;
  /** Every page, in order; a page with no text has an empty string. */
  pages: PageText[];
  characters: number;
}

export type Ask =
  /** Whatever the person typed. */
  | { kind: 'question'; text: string }
  /** A request about the whole document (the chips), in words. */
  | { kind: 'overview'; text: string }
  /** The page on screen, translated: into English when it is mostly Arabic, into Arabic otherwise. */
  | { kind: 'translate'; text: string; page: number };

/** What an answer was made from. */
export type Basis =
  | { kind: 'whole'; pageCount: number }
  | { kind: 'analysis'; pageCount: number }
  | { kind: 'passages'; pages: number[]; pageCount: number; outline: boolean }
  | { kind: 'page'; page: number; parts: number };

export type Turned =
  | { ok: true; answer: Answer; basis: Basis }
  | { ok: false; failure: Failure }
  /** The document, or the page asked about, has no text to read: a scan. */
  | { ok: false; noText: 'document' | 'page' };

export interface TurnOptions {
  client: Pick<CoreClient, 'callStatic'>;
  kept: Kept;
  signal: AbortSignal;
  onText?: (text: string, thinking: boolean) => void;
  /** The analysis is being made, for this request: where it has got to. */
  onProgress?: (progress: Progress | null) => void;
}

/**
 * Whether what was typed asks about the document as a whole — a summary,
 * its main points, what it is about — which passages picked by its words
 * cannot answer. In both languages; a chip says so itself.
 */
export function asksForOverview(text: string): boolean {
  return /\b(summar(y|ies|ize|ise)|overview|key points?|main (points?|ideas?)|tl;?dr|outline|gist)\b|what('s| is| does) (this|the) (document|file|pdf|report|paper|book)( is)? (about|say)|لخ[ّ]?ص|تلخيص|ملخ[ّ]?ص|خلاصة|موجز|(النقاط|الأفكار|المحاور) (الرئيسي?ة|الأساسية|المهمة)|أهم (النقاط|الأفكار|ما)|عم[ّ]? يتحدث|ما موضوع|نظرة عامة/iu.test(text);
}

const RECENT = 4;

/**
 * The earlier turns as a request carries them, within `budget` characters:
 * the last two exchanges as they were said (each clipped to its share), and
 * of older ones the person's question alone, in a line — enough for "and
 * the second one?" to mean something, without the window filling with talk.
 */
export function carry(history: readonly Said[], budget: number): Said[] {
  if (history.length === 0 || budget <= 0) return [];
  const recent = history.slice(-RECENT);
  const older = history.slice(0, -RECENT).filter((said) => said.role === 'user');
  const share = Math.max(120, Math.floor((budget * 0.8) / recent.length));
  const kept: Said[] = recent.map((said) => ({ role: said.role, text: clip(said.text.replace(/\s*\n\s*/g, ' '), share) }));
  let room = budget - kept.reduce((sum, said) => sum + said.text.length, 0);
  const lines: Said[] = [];
  for (const said of older.reverse()) {
    const text = clip(said.text.replace(/\s*\n\s*/g, ' '), 120);
    if (text.length > room) break;
    lines.unshift({ role: 'user', text });
    room -= text.length;
  }
  return [...lines, ...kept];
}

/** What a follow-up is searched with: its own words and those of the question before it. */
export function searchQuery(text: string, history: readonly Said[]): string {
  const before = [...history].reverse().find((said) => said.role === 'user');
  return before ? `${text} ${before.text}`.slice(0, 600) : text;
}

const total = (history: readonly Said[]) => history.reduce((sum, said) => sum + said.text.length + 12, 0);

export async function answerTurn(doc: DocumentText, ask: Ask, history: readonly Said[], runner: Runner, options: TurnOptions): Promise<Turned> {
  const { signal, onText } = options;
  if (doc.pages.every((page) => page.text.trim().length === 0)) return { ok: false, noText: 'document' };
  if (ask.kind === 'translate') return translate(doc, ask, runner, options);

  // Tried with all its room first; a request the model counts as too large is tried again with less.
  let scale = 1;
  for (let attempt = 0; ; attempt += 1) {
    const budget = Math.floor(runner.turnBudget * scale);
    const said = carry(history, Math.floor(budget * 0.25));
    const room = budget - total(said);
    const built = await material(doc, ask, history, runner, room, options);
    if (!built.ok) return built;
    if (signal.aborted) return { ok: false, failure: { kind: 'cancelled' } };
    const outcome = await runner.run(turnPrompt(built.material, said, ask.text), { signal, onText });
    if (outcome.ok) return { ok: true, answer: outcome.answer, basis: built.basis };
    if (outcome.failure.kind !== 'tooLarge' || attempt >= 3) return outcome;
    scale *= 0.6;
  }
}

type Built = { ok: true; material: Material; basis: Basis } | { ok: false; failure: Failure };

async function material(doc: DocumentText, ask: Exclude<Ask, { kind: 'translate' }>, history: readonly Said[], runner: Runner, room: number, options: TurnOptions): Promise<Built> {
  const { pageCount } = doc;
  const pages = doc.pages.filter((page) => page.text.trim().length > 0);
  // Short enough to go whole: no analysis, no picking.
  if (doc.characters + pages.length * 30 <= room) {
    return { ok: true, material: { kind: 'whole', pages, pageCount }, basis: { kind: 'whole', pageCount } };
  }
  const chunks = chunkPages(pages, runner.budget);
  if (ask.kind === 'overview' || asksForOverview(ask.text)) {
    const analyzed = await analyze(chunks, pageCount, runner, options.kept, { signal: options.signal, onProgress: (progress) => options.onProgress?.(progress) });
    options.onProgress?.(null);
    if (!analyzed.ok) return analyzed;
    return { ok: true, material: { kind: 'summaries', parts: digest(analyzed.analysis, room), pageCount }, basis: { kind: 'analysis', pageCount } };
  }
  // A question: the passages its words point to, and the outline when the document has been analyzed.
  const kept = await keptOutline(chunks, runner, options.kept);
  const outline = kept === null ? null : clip(kept, Math.floor(room * 0.3));
  const found = await retrievePassages(options.client, pages, searchQuery(ask.text, history), room - (outline?.length ?? 0) - tagRoom(pages.length));
  return {
    ok: true,
    material: { kind: 'passages', pages: found.passages, outline, pageCount },
    basis: { kind: 'passages', pages: found.pages, pageCount, outline: outline !== null },
  };
}

/** The page tags around the passages: a few characters each, for as many pages as could carry one. */
function tagRoom(pages: number): number {
  return Math.min(pages, 40) * 30;
}

/** The page on screen, translated a piece at a time, each piece as the next part of one answer. */
async function translate(doc: DocumentText, ask: Extract<Ask, { kind: 'translate' }>, runner: Runner, options: TurnOptions): Promise<Turned> {
  const page = doc.pages.find((candidate) => candidate.page === ask.page);
  if (!page || page.text.trim().length === 0) return { ok: false, noText: 'page' };
  const to = translationTarget(page.text);
  const pieces = splitText(page.text, runner.echoBudget);
  let text = '';
  let cutOff = false;
  for (const piece of pieces) {
    if (options.signal.aborted) break;
    const before = text.length > 0 ? `${text}\n` : '';
    const outcome = await runner.run(translatePrompt({ page: page.page, text: piece }, to), {
      signal: options.signal,
      onText: (partial, thinking) => options.onText?.(before + partial, thinking),
    });
    if (!outcome.ok) {
      // What was translated before the failure is kept, and said to be incomplete.
      if (text.length === 0) return outcome;
      cutOff = true;
      break;
    }
    text = before + outcome.answer.text;
    cutOff ||= outcome.answer.cutOff;
  }
  if (options.signal.aborted) cutOff = true;
  if (text.trim().length === 0) return { ok: false, failure: { kind: 'cancelled' } };
  return { ok: true, answer: { text, cutOff }, basis: { kind: 'page', page: page.page, parts: pieces.length } };
}

/** The language a page is translated into: the other one of the two. */
export function translationTarget(text: string): Lang {
  return mostlyArabic(text) ? 'en' : 'ar';
}

/** The analysis on its own, from the "Analyze this document" button. */
export async function analyzeDocument(
  doc: DocumentText,
  runner: Runner,
  options: Pick<TurnOptions, 'kept' | 'signal' | 'onProgress'>,
): Promise<{ ok: true; analysis: Analysis | null; reused: number; made: number } | { ok: false; failure: Failure } | { ok: false; noText: 'document' }> {
  const pages = doc.pages.filter((page) => page.text.trim().length > 0);
  if (pages.length === 0) return { ok: false, noText: 'document' };
  const analyzed = await analyze(chunkPages(pages, runner.budget), doc.pageCount, runner, options.kept, {
    signal: options.signal,
    onProgress: (progress) => options.onProgress?.(progress),
  });
  options.onProgress?.(null);
  return analyzed;
}

/** Whether the document goes whole in one request: it needs no analysis. */
export function fitsWhole(doc: DocumentText, runner: Pick<Runner, 'turnBudget'>): boolean {
  return doc.characters + doc.pages.length * 30 <= Math.floor(runner.turnBudget * 0.75);
}
