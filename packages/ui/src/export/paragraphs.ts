import type { ParagraphData, TextAlignment, TextDirection, TextLineData } from '../core/types';

/**
 * One paragraph of an export: its text in reading order, and how it sat on the
 * page. Always Warraq's own reading of the page — PDFium's text is in visual
 * order for Arabic and never reaches an export.
 */
export interface ExportParagraph {
  text: string;
  direction: TextDirection;
  alignment: TextAlignment;
  /** Points; null when the page gives no believable size (rotated text reports hundreds). */
  fontSize: number | null;
}

/** Sizes outside this range are the core measuring something odd, not type. */
const BELIEVABLE_SIZE = { min: 4, max: 96 };

/** How much more space than usual above a line starts a new paragraph. */
const GAP = { sameBlock: 1.3, acrossBlocks: 1.15 };

/** Combining marks (tashkeel) and format controls take no room on the line. */
const ZERO_WIDTH = /[\p{M}\p{Cf}]/gu;

function roomTaking(text: string): number {
  return text.replace(ZERO_WIDTH, '').length;
}

function finite(line: TextLineData): boolean {
  return [line.x, line.y, line.width, line.height].every(Number.isFinite) && line.height > 0;
}

/**
 * The core's paragraph a line belongs to: the smallest box around the line's
 * middle whose text contains the line's, or failing that the smallest box;
 * -1 for none.
 */
function blockOf(line: TextLineData, blocks: readonly ParagraphData[]): number {
  const cx = line.x + line.width / 2;
  const cy = line.y + line.height / 2;
  const slack = 1;
  let best = -1;
  let bestArea = Infinity;
  let bestHasText = false;
  blocks.forEach((block, index) => {
    const around =
      cx >= block.x - slack &&
      cx <= block.x + block.width + slack &&
      cy >= block.y - slack &&
      cy <= block.y + block.height + slack;
    if (!around) return;
    const hasText = block.text.includes(line.text.trim());
    const area = block.width * block.height;
    if ((hasText && !bestHasText) || (hasText === bestHasText && area < bestArea)) {
      best = index;
      bestArea = area;
      bestHasText = hasText;
    }
  });
  return best;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

/** The usual distance from one line to the next, top to top; null for a single line. */
function linePitch(lines: readonly TextLineData[]): number | null {
  const steps: number[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const step = lines[i]!.y - lines[i - 1]!.y;
    if (step > 0) steps.push(step);
  }
  return median(steps);
}

/** The lines of one paragraph so far, and the core's paragraph each came from. */
interface Group {
  lines: TextLineData[];
  owners: number[];
}

/** What `continues` knows about the page. */
interface Page {
  blocks: readonly ParagraphData[];
  /** Each block's usual line spacing. */
  pitches: readonly (number | null)[];
}

/**
 * Whether `prev` stopped early: the first word of `next`, and the space before
 * it, would have fitted in the room left at the end of `prev` — so the line
 * did not wrap there; the paragraph ended. Measured with `next`'s own width per
 * character, and generously, because an estimate that errs the other way
 * breaks sentences in two.
 */
function endedEarly(prev: TextLineData, next: TextLineData, direction: TextDirection, left: number, right: number): boolean {
  const room = direction === 'rtl' ? prev.x - left : right - (prev.x + prev.width);
  const chars = roomTaking(next.text);
  if (room <= 0 || chars === 0) return false;
  const perChar = next.width / chars;
  const firstWord = next.text.trim().split(/\s+/u)[0] ?? '';
  const needed = (roomTaking(firstWord) + 1) * perChar;
  return room > needed * 1.2 + 1;
}

/** Whether `next` carries on the paragraph `group` holds, or starts a new one. */
function continues(group: Group, next: TextLineData, nextOwner: number, page: Page): boolean {
  const prev = group.lines[group.lines.length - 1]!;
  const prevOwner = group.owners[group.owners.length - 1]!;
  const prevBlock = page.blocks[prevOwner];
  const nextBlock = page.blocks[nextOwner];
  const sameBlock = prevOwner >= 0 && prevOwner === nextOwner;
  if (!finite(prev) || !finite(next)) return false;
  // Inside one of the core's paragraphs a change of direction is no break —
  // an Arabic line may open with an English word — but anywhere else it is.
  if (!sameBlock && next.direction !== prev.direction) return false;
  if (prevBlock && nextBlock && prevBlock.direction !== nextBlock.direction) return false;
  // Below the previous line and in the same column: not beside it, not above it.
  if (next.y < prev.y + prev.height * 0.5) return false;
  if (Math.min(prev.x + prev.width, next.x + next.width) <= Math.max(prev.x, next.x)) return false;
  // The same size of type.
  const tall = Math.max(prev.height, next.height);
  if (Math.abs(prev.height - next.height) > tall * 0.3) return false;
  // No more space above it than between the paragraph's own lines. Across two
  // of the core's paragraphs — which it sometimes cuts mid-sentence — only
  // when the spacing is plainly the same.
  const pitches = [page.pitches[prevOwner], page.pitches[nextOwner]].filter((p): p is number => typeof p === 'number');
  const usual = (sameBlock ? page.pitches[prevOwner] : pitches.length > 0 ? Math.min(...pitches) : null) ?? linePitch(group.lines) ?? tall * 1.5;
  if (next.y - prev.y > usual * (sameBlock ? GAP.sameBlock : GAP.acrossBlocks) + 0.5) return false;
  // Ragged or justified text shows a paragraph's end as a short line; centred
  // or end-aligned text does not, so there the spacing alone decides.
  const alignment = (prevBlock ?? nextBlock)?.alignment ?? 'start';
  if (alignment !== 'start' && alignment !== 'justify') return true;
  const around = [...group.lines, next, ...[prevBlock, nextBlock].filter((block): block is ParagraphData => block !== undefined)];
  const left = Math.min(...around.map((box) => box.x));
  const right = Math.max(...around.map((box) => box.x + box.width));
  return !endedEarly(prev, next, (prevBlock ?? nextBlock)?.direction ?? prev.direction, left, right);
}

/** The direction most of the paragraph's text runs in. */
function dominant(lines: readonly TextLineData[], fallback: TextDirection | undefined): TextDirection {
  let rtl = 0;
  let ltr = 0;
  for (const line of lines) {
    const weight = roomTaking(line.text);
    if (line.direction === 'rtl') rtl += weight;
    else ltr += weight;
  }
  if (rtl === ltr) return fallback ?? lines[0]?.direction ?? 'rtl';
  return rtl > ltr ? 'rtl' : 'ltr';
}

/**
 * Paragraphs of a page, from the core's lines (in reading order) and the
 * paragraphs its editor finds.
 *
 * The editor's paragraphs are blocks for editing: a whole Word page of body
 * text comes back as one, and so does an invoice's column of labelled lines;
 * now and then one is cut mid-sentence. An export wants the paragraphs a
 * person sees, so the lines are grouped again: a new paragraph starts where a
 * line ended early, where there is more space than the lines' own spacing,
 * where the type changes size, and where the text changes direction or
 * column.
 */
export function paragraphsOf(lines: readonly TextLineData[], blocks: readonly ParagraphData[]): ExportParagraph[] {
  const usable = lines.filter((line) => line.text.trim().length > 0);
  const owners = usable.map((line) => (finite(line) ? blockOf(line, blocks) : -1));
  const page: Page = {
    blocks,
    pitches: blocks.map((_, index) => linePitch(usable.filter((_, i) => owners[i] === index))),
  };

  const groups: Group[] = [];
  usable.forEach((line, i) => {
    const owner = owners[i]!;
    const group = groups[groups.length - 1];
    if (group && continues(group, line, owner, page)) {
      group.lines.push(line);
      group.owners.push(owner);
    } else {
      groups.push({ lines: [line], owners: [owner] });
    }
  });

  return groups.map((group) => {
    const block = blocks[group.owners.find((owner) => owner >= 0) ?? -1];
    const size = block?.fontSize;
    return {
      text: group.lines.map((line) => line.text.trim()).join(' '),
      direction: dominant(group.lines, block?.direction),
      alignment: block?.alignment ?? 'start',
      fontSize: size !== undefined && size >= BELIEVABLE_SIZE.min && size <= BELIEVABLE_SIZE.max ? size : null,
    };
  });
}
