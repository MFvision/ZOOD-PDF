import { splitCitations } from '../citations';
import type { Failure } from '../providers';
import { halve } from './chunks';
import type { Chunk } from './chunks';
import { textHash } from './kept';
import type { Kept } from './kept';
import { combinePrompt, notesPrompt, outlinePrompt, summariesText } from './prompts';
import type { Part } from './prompts';
import type { Runner } from './runner';

/**
 * "Analyze": how a model whose window holds a few pages comes to know a
 * whole document. Every chunk is summarized on its own (map); the summaries
 * are combined, a window's worth at a time, in rounds, until what is left
 * fits one request (reduce); and from those an outline of the whole is
 * written. Each summary is kept as soon as it is made (`kept.ts`), so the
 * work is done once: stopped half-way, it goes on from there; opened again,
 * the document is known at once.
 */
export interface Analysis {
  /** `levels[0]` is one summary a chunk; each next level combines the one before; the last fits one request. */
  levels: Part[][];
  outline: string;
}

export type Progress =
  /** Reading (summarizing) the chunk that covers these pages. */
  | { stage: 'reading'; from: number; to: number; pageCount: number; done: number; total: number }
  | { stage: 'combining'; done: number; total: number }
  | { stage: 'outline' };

export type Analyzed = { ok: true; analysis: Analysis; reused: number; made: number } | { ok: false; failure: Failure };

export interface AnalyzeOptions {
  signal: AbortSignal;
  onProgress?: (progress: Progress) => void;
}

/** Rounds of combining, at most: with six or more summaries to a round, more than any document needs. */
const MAX_ROUNDS = 12;

const CANCELLED: Failure = { kind: 'cancelled' };

/** The longest a summary may be, so that a round of combining always takes several at once. */
export function summaryLimit(budget: number): number {
  return Math.max(200, Math.floor(budget / 6));
}

/** A summary within `limit`, cut after its last whole line. */
export function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  const cut = trimmed.slice(0, limit);
  const line = cut.lastIndexOf('\n');
  return (line > limit / 2 ? cut.slice(0, line) : cut).trim();
}

/**
 * Notes that name no page get their chunk's pages at the end: a small model
 * often leaves the citations out, and without them nothing made from the
 * notes later could say where in the document it came from.
 */
export function withPages(text: string, from: number, to: number): string {
  if (splitCitations(text, Number.MAX_SAFE_INTEGER).some((piece) => piece.kind === 'page')) return text;
  return `${text} ${from === to ? `[p. ${from}]` : `[pp. ${from}–${to}]`}`;
}

const chunkText = (chunk: Chunk) => chunk.pages.map((page) => `${page.page}\u0000${page.text}`).join('\u0001');
const partsText = (parts: readonly Part[]) => parts.map((part) => `${part.from}-${part.to}\u0000${part.text}`).join('\u0001');
const size = (parts: readonly Part[]) => summariesText(parts).length;

/** Consecutive summaries in groups that each fit `budget`. */
export function groupParts(parts: readonly Part[], budget: number): Part[][] {
  const groups: Part[][] = [];
  let current: Part[] = [];
  for (const part of parts) {
    if (current.length > 0 && size([...current, part]) > budget) {
      groups.push(current);
      current = [];
    }
    current.push(part);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Whether the outline of these chunks is already kept: the document has been analyzed with this model. */
export async function keptOutline(chunks: readonly Chunk[], runner: Pick<Runner, 'key'>, kept: Kept): Promise<string | null> {
  if (chunks.length === 0) return null;
  const hashes = await Promise.all(chunks.map((chunk) => textHash(chunkText(chunk))));
  return kept.get(`${runner.key}:d:${await textHash(hashes.join(','))}`);
}

export async function analyze(chunks: readonly Chunk[], pageCount: number, runner: Runner, kept: Kept, options: AnalyzeOptions): Promise<Analyzed> {
  const { signal, onProgress } = options;
  const limit = summaryLimit(runner.budget);
  let reused = 0;
  let made = 0;
  const fail = (failure: Failure): Analyzed => ({ ok: false, failure });

  /**
   * One request whose answer is kept under `key`; a kept answer is not asked
   * for again — and `progress` is said only when the model is in fact asked,
   * so an analysis that is all there already passes without a word.
   */
  const once = async (key: string, progress: Progress, ask: () => ReturnType<Runner['run']>, from?: number, to?: number): Promise<{ ok: true; text: string } | { ok: false; failure: Failure }> => {
    const had = await kept.get(key);
    if (had !== null) {
      reused += 1;
      return { ok: true, text: had };
    }
    if (signal.aborted) return { ok: false, failure: CANCELLED };
    onProgress?.(progress);
    const outcome = await ask();
    // Stopped while it was being written: half a summary is not kept as one.
    if (signal.aborted) return { ok: false, failure: CANCELLED };
    if (!outcome.ok) return outcome;
    // Room is left for the pages `withPages` may add, so a summary never passes its limit.
    const text = from === undefined || to === undefined ? clip(outcome.answer.text, limit) : withPages(clip(outcome.answer.text, limit - 20), from, to);
    await kept.put(key, text);
    made += 1;
    return { ok: true, text };
  };

  /** A chunk's summary; a chunk the model counts as too long is read as two halves. */
  const read = async (chunk: Chunk, depth: number, progress: Progress): Promise<{ ok: true; text: string } | { ok: false; failure: Failure }> => {
    const key = `${runner.key}:c:${await textHash(chunkText(chunk))}`;
    const result = await once(key, progress, () => runner.run(notesPrompt(chunk.pages, chunk.from, chunk.to, pageCount), { signal, brief: true }), chunk.from, chunk.to);
    if (result.ok || result.failure.kind !== 'tooLarge' || depth >= 4) return result;
    const halves = halve(chunk);
    if (!halves) return result;
    const texts: string[] = [];
    for (const half of halves) {
      const part = await read(half, depth + 1, progress);
      if (!part.ok) return part;
      texts.push(part.text);
    }
    const text = clip(texts.join('\n'), limit);
    await kept.put(key, text);
    return { ok: true, text };
  };

  // Map.
  const first: Part[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const result = await read(chunk, 0, { stage: 'reading', from: chunk.from, to: chunk.to, pageCount, done: index, total: chunks.length });
    if (!result.ok) return fail(result.failure);
    first.push({ from: chunk.from, to: chunk.to, text: result.text });
  }

  // Reduce, in rounds, until what is left fits one request.
  const levels: Part[][] = [first];
  let level = first;
  for (let round = 0; level.length > 1 && size(level) > runner.budget; round += 1) {
    if (round >= MAX_ROUNDS) return fail({ kind: 'tooLarge' });
    const groups = groupParts(level, runner.budget);
    // Summaries that no longer shrink would go round for ever.
    if (groups.length >= level.length) return fail({ kind: 'tooLarge' });
    const next: Part[] = [];
    for (const [index, group] of groups.entries()) {
      const from = group[0]!.from;
      const to = group.at(-1)!.to;
      if (group.length === 1) {
        next.push(group[0]!);
        continue;
      }
      const result = await once(`${runner.key}:g:${await textHash(partsText(group))}`, { stage: 'combining', done: index, total: groups.length }, () => runner.run(combinePrompt(group, pageCount), { signal, brief: true }), from, to);
      if (!result.ok) return fail(result.failure);
      next.push({ from, to, text: result.text });
    }
    levels.push(next);
    level = next;
  }

  const outline = await once(`${runner.key}:o:${await textHash(partsText(level))}`, { stage: 'outline' }, () => runner.run(outlinePrompt(level, pageCount), { signal, brief: true }));
  if (!outline.ok) return fail(outline.failure);
  // The mark `keptOutline` looks for: this document, with this model, is done.
  const hashes = await Promise.all(chunks.map((chunk) => textHash(chunkText(chunk))));
  await kept.put(`${runner.key}:d:${await textHash(hashes.join(','))}`, outline.text);
  return { ok: true, analysis: { levels, outline: outline.text }, reused, made };
}

/**
 * The most detailed summaries of the whole document that fit `budget`: every
 * chunk's own when they fit together, else the first round of combining that
 * does. The last level always fits a request; should `budget` be smaller
 * still, its summaries are clipped evenly — every part of the document
 * keeps its place.
 */
export function digest(analysis: Analysis, budget: number): Part[] {
  for (const level of analysis.levels) {
    if (size(level) <= budget) return level;
  }
  const last = analysis.levels.at(-1) ?? [];
  const each = Math.max(80, Math.floor(budget / Math.max(1, last.length)) - 40);
  return last.map((part) => ({ ...part, text: clip(part.text, each) }));
}
