import { directionOf } from '../i18n/messages';
import type { Lang, TKey, TParams } from '../i18n/messages';
import type { Comparison, Passage } from './comparison';
import type { CompareOptions } from './normalize';

export interface ReportInput {
  comparison: Comparison;
  options: CompareOptions;
  /** The two versions, named as the panel names them: sentences of the interface, file names isolated. */
  older: string;
  newer: string;
  /** When the comparison was made, already written for `lang`. */
  date: string;
  lang: Lang;
  t: (key: TKey, params?: TParams) => string;
}

/**
 * A name set inside a sentence of the interface — "report.pdf (open now)",
 * "المراجعة 1 من report.pdf" — as a bidi isolate (FSI … PDI): its own letters
 * decide its direction, and the sentence keeps the interface's. Without it a
 * Latin file name at the start turned an Arabic sentence left to right and
 * put its parentheses at the wrong ends.
 */
export function isolate(name: string): string {
  return `⁨${name}⁩`;
}

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text as HTML text or attribute value: nothing in a document's words can become markup. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/**
 * The report's look: inline, because it must open anywhere with nothing
 * fetched. Logical properties, so it mirrors in Arabic; `del` and `ins` differ
 * by line — struck through or underlined — not by colour alone.
 */
const STYLE = `
:root { color-scheme: light dark; }
body { max-inline-size: 46rem; margin-block: 2rem; margin-inline: auto; padding-inline: 1rem;
  font-family: system-ui, -apple-system, "Segoe UI", "Noto Naskh Arabic", "Geeza Pro", Tahoma, sans-serif;
  line-height: 1.8; color: #1a1d21; background: #fff; }
h1 { font-size: 1.5rem; margin-block: 0 1rem; }
h2 { font-size: 1.15rem; margin-block: 2rem 0.25rem; padding-block-start: 1rem; border-block-start: 1px solid #d5d9de; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 1rem; }
dt { color: #5f6772; }
dd { margin: 0; }
.muted { color: #5f6772; }
del { color: #8a1c12; background: #fee4e2; text-decoration: line-through; text-decoration-thickness: 2px; }
ins { color: #0b4d47; background: #d9f2ef; text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 0.2em; }
.sr-only { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (prefers-color-scheme: dark) {
  body { color: #e6e8eb; background: #14161a; }
  dt, .muted { color: #9aa3ad; }
  h2 { border-color: #2f343c; }
  del { color: #ffb4ab; background: #4a1d1a; }
  ins { color: #8ff0e4; background: #0f3b37; }
}`;

/**
 * One passage: `dir="auto"`, so Arabic reads right to left and Latin left to
 * right, each paragraph by its own first letter. The words that announce a
 * change to a screen reader carry the interface's `dir`, which also keeps
 * them out of that choice.
 */
function passageHtml(passage: Passage, input: ReportInput): string {
  const labelDir = directionOf(input.lang);
  // The spaces live inside the hidden labels, so no line runs under a space.
  const opening = (key: TKey) => `<span class="sr-only" dir="${labelDir}">${escapeHtml(input.t(key))} </span>`;
  const closing = (key: TKey) => `<span class="sr-only" dir="${labelDir}"> ${escapeHtml(input.t(key))}</span>`;
  const parts = passage.parts.map((part) => {
    const text = escapeHtml(part.text);
    if (part.kind === 'same') return text;
    return part.kind === 'removed'
      ? `<del>${opening('compare.srRemoved')}${text}${closing('compare.srRemovedEnd')}</del>`
      : `<ins>${opening('compare.srAdded')}${text}${closing('compare.srAddedEnd')}</ins>`;
  });
  return `<p dir="auto">${passage.before ? '… ' : ''}${parts.join(' ')}${passage.after ? ' …' : ''}</p>`;
}

/**
 * The comparison as a small HTML file that stands on its own: UTF-8, no
 * script, nothing loaded from anywhere, every word of the documents escaped.
 */
export function comparisonReport(input: ReportInput): string {
  const { comparison, options, t, lang } = input;
  const title = escapeHtml(t('compare.reportTitle'));
  const body: string[] = [
    `<h1>${title}</h1>`,
    '<dl>',
    `<dt>${escapeHtml(t('compare.older'))}</dt><dd>${escapeHtml(input.older)}</dd>`,
    `<dt>${escapeHtml(t('compare.newer'))}</dt><dd>${escapeHtml(input.newer)}</dd>`,
    '</dl>',
  ];
  if (comparison.olderWords + comparison.newerWords === 0) {
    body.push(`<p>${escapeHtml(t('compare.noText'))}</p>`);
  } else if (comparison.changed.length === 0) {
    body.push(`<p>${escapeHtml(t('compare.noChanges'))}</p>`);
  } else {
    body.push(
      '<ul>',
      `<li>${escapeHtml(t('compare.pagesChanged', { count: comparison.changed.length }))}</li>`,
      `<li>${escapeHtml(t('compare.wordsAdded', { count: comparison.added }))}</li>`,
      `<li>${escapeHtml(t('compare.wordsRemoved', { count: comparison.removed }))}</li>`,
      '</ul>',
    );
  }
  if (options.ignoreMarks) body.push(`<p class="muted">${escapeHtml(t('compare.reportMarks'))}</p>`);
  if (options.unifyLetters) body.push(`<p class="muted">${escapeHtml(t('compare.reportLetters'))}</p>`);
  if (comparison.olderPages !== comparison.newerPages) {
    body.push(
      `<p class="muted">${escapeHtml(t('compare.pageCountsDiffer', { older: comparison.olderPages, newer: comparison.newerPages }))}</p>`,
    );
  }
  for (const change of comparison.changed) {
    body.push(
      '<section>',
      `<h2>${escapeHtml(t('compare.page', { page: change.page }))}</h2>`,
      `<p class="muted">${escapeHtml(t('compare.pageWords', { added: change.added, removed: change.removed }))}</p>`,
    );
    if (!change.inOlder) body.push(`<p class="muted">${escapeHtml(t('compare.onlyNewer'))}</p>`);
    if (!change.inNewer) body.push(`<p class="muted">${escapeHtml(t('compare.onlyOlder'))}</p>`);
    for (const passage of change.passages) body.push(passageHtml(passage, input));
    body.push('</section>');
  }
  body.push(
    '<footer>',
    `<p class="muted">${escapeHtml(t('compare.note'))}</p>`,
    `<p class="muted">${escapeHtml(t('compare.reportMade', { date: input.date }))}</p>`,
    '</footer>',
  );
  return [
    '<!doctype html>',
    `<html lang="${lang}" dir="${directionOf(lang)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<style>${STYLE}\n</style>`,
    '</head>',
    '<body>',
    ...body,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
