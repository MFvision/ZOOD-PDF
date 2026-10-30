import type { CoreClient } from '../core/client';
import { buildDocx, readsRtl } from '../export/docx';
import type { ExportParagraph } from '../export/paragraphs';
import { DEFAULT_CREATE_OPTIONS, createPdf } from '../create/createPdf';
import { appCreateEnvironment } from '../create/environment';

/**
 * An answer of Ask ZOOD kept as a file: "make it a PDF", "as a Word file".
 * The question is the title and the answer the body, laid out by ZOOD's own
 * writers (Create PDF's typesetter for a PDF, PDF → Word's writer for a
 * .docx), on this computer. A presentation is written by the deck lane
 * instead (`deck.ts`), from the answer.
 */

export type AnswerFileKind = 'pdf' | 'docx';

/** The question as a title: one line, no question mark, at most 80 letters. */
export function answerTitle(question: string, fallback: string): string {
  const line = question.replace(/\s+/g, ' ').replace(/[?؟.!…]+$/, '').trim();
  if (!line) return fallback;
  const title = line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
  return title.charAt(0).toLocaleUpperCase() + title.slice(1);
}

/** The answer's lines, blank ones dropped, list marks kept as they were written. */
function linesOf(answer: string): string[] {
  return answer
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Title and answer as Markdown: Create PDF reads its headings and lists. */
export function answerMarkdown(title: string, answer: string): string {
  // A line that only looks like Markdown (a "#" at its start) stays text.
  const body = linesOf(answer).map((line) => line.replace(/^#/, '\\#'));
  return [`# ${title.replace(/^#+\s*/, '')}`, '', ...body.flatMap((line) => [line, ''])].join('\n').trimEnd() + '\n';
}

/** Title and answer as the paragraphs of a Word file. */
export function answerParagraphs(title: string, answer: string): ExportParagraph[] {
  const paragraph = (text: string, fontSize: number): ExportParagraph => ({
    text,
    direction: readsRtl(text) ? 'rtl' : 'ltr',
    alignment: 'start',
    fontSize,
  });
  return [paragraph(title, 18), ...linesOf(answer).map((line) => paragraph(line, 12))];
}

/** The file's bytes. */
export async function answerFile(
  kind: AnswerFileKind,
  title: string,
  answer: string,
  client: Pick<CoreClient, 'callStatic'>,
): Promise<Uint8Array> {
  if (kind === 'docx') {
    const paragraphs = answerParagraphs(title, answer);
    return buildDocx([{ number: 1, text: paragraphs.map((one) => one.text).join('\n'), paragraphs }]);
  }
  const markdown = new TextEncoder().encode(answerMarkdown(title, answer));
  const made = await createPdf(
    [{ name: 'answer.md', bytes: markdown.buffer.slice(0) as ArrayBuffer }],
    DEFAULT_CREATE_OPTIONS,
    appCreateEnvironment(client),
  );
  return new Uint8Array(made.bytes);
}
