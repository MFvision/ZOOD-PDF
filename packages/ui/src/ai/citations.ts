/**
 * An answer is only as good as the pages it came from, so the model is asked
 * to cite them as `[p. N]` and each citation becomes a button that goes to
 * that page. Models do not always write exactly what was asked — "[pp. 2–3]",
 * "(p. 4)", "[ص ٥]" in an Arabic answer — so those forms are read too. A
 * number that is not a page of this document stays plain text: a button
 * that went nowhere would be worse than none.
 */

export type Piece = { kind: 'text'; text: string } | { kind: 'page'; page: number };

const DIGIT = '0-9٠-٩۰-۹';
const CITATION = new RegExp(
  `[\\[(]\\s*(?:pp?\\.?|pages?|ص\\.?|صفحة|الصفحة|صفحات|الصفحات)\\s*([${DIGIT}][${DIGIT}\\s,،\\-–—]*?)\\s*[\\])]`,
  'giu',
);
const PART = new RegExp(`[${DIGIT}]+|[\\-–—]|[,،]`, 'gu');

/** Arabic-Indic and Persian digits read as the numbers they are. */
function toNumber(digits: string): number {
  const western = digits.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  return Number(western);
}

/** The citation's own pieces: its pages, and a dash between the two ends of a range. */
function citationPieces(inner: string, pageCount: number): Piece[] | null {
  const pieces: Piece[] = [];
  for (const [part] of inner.matchAll(PART)) {
    if (/[,،]/.test(part)) {
      pieces.push({ kind: 'text', text: ' ' });
      continue;
    }
    if (/[-–—]/.test(part)) {
      pieces.push({ kind: 'text', text: '–' });
      continue;
    }
    const page = toNumber(part);
    if (!Number.isInteger(page) || page < 1 || page > pageCount) return null;
    pieces.push({ kind: 'page', page });
  }
  return pieces.some((piece) => piece.kind === 'page') ? pieces : null;
}

/** Splits `answer` into text and page citations of a `pageCount`-page document. */
export function splitCitations(answer: string, pageCount: number): Piece[] {
  const pieces: Piece[] = [];
  const text = (value: string) => {
    if (value.length === 0) return;
    const last = pieces.at(-1);
    if (last?.kind === 'text') last.text += value;
    else pieces.push({ kind: 'text', text: value });
  };
  let at = 0;
  for (const match of answer.matchAll(CITATION)) {
    const index = match.index ?? 0;
    const cited = citationPieces(match[1] ?? '', pageCount);
    text(answer.slice(at, index));
    for (const piece of cited ?? [{ kind: 'text', text: match[0] } as const]) {
      if (piece.kind === 'text') text(piece.text);
      else pieces.push(piece);
    }
    at = index + match[0].length;
  }
  text(answer.slice(at));
  return pieces;
}
