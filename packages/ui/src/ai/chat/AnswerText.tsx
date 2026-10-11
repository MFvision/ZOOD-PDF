import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n/useT';
import { splitCitations } from '../citations';

/**
 * An answer's words on the page. The model is asked for plain text with
 * "- " lists and `[p. N]` citations; small models write Markdown anyway, so
 * its commonest marks are read rather than shown: `**bold**` loses its
 * stars, a `#` heading becomes a line in bold, list markers become a list.
 * Each citation of a page this document has is a button that goes there.
 * Nothing of the answer is ever treated as HTML.
 */

type Block = { kind: 'paragraph'; text: string; strong: boolean } | { kind: 'list'; ordered: boolean; items: string[] };

const BULLET = /^\s*[-*•–]\s+/u;
const NUMBERED = /^\s*[0-9٠-٩]{1,3}[.)]\s+/u;

/** The answer as paragraphs and lists. */
export function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\*\*|__/g, '').trimEnd();
    if (line.trim().length === 0) continue;
    const bullet = BULLET.test(line);
    const numbered = !bullet && NUMBERED.test(line);
    if (bullet || numbered) {
      const item = line.replace(bullet ? BULLET : NUMBERED, '');
      const last = blocks.at(-1);
      if (last?.kind === 'list' && last.ordered === numbered) last.items.push(item);
      else blocks.push({ kind: 'list', ordered: numbered, items: [item] });
      continue;
    }
    const heading = /^\s*#{1,6}\s+/.test(line);
    blocks.push({ kind: 'paragraph', text: heading ? line.replace(/^\s*#{1,6}\s+/, '') : line.trim(), strong: heading });
  }
  return blocks;
}

/** The answer as it is read aloud or copied for speech: its words without the page citations' brackets. */
export function spokenText(text: string): string {
  return blocksOf(text)
    .map((block) => (block.kind === 'list' ? block.items.join('.\n') : block.text))
    .join('\n')
    .replace(/\s*[[(]\s*(?:pp?\.?|ص\.?)\s*[0-9٠-٩][0-9٠-٩\s,،\-–—]*[\])]/giu, '');
}

export function AnswerText({ text, pageCount, onPage }: { text: string; pageCount: number; onPage: (page: number) => void }) {
  const { t, dir } = useI18n();
  const line = (value: string): ReactNode =>
    splitCitations(value, pageCount).map((piece, at) =>
      piece.kind === 'text' ? (
        <Fragment key={at}>{piece.text}</Fragment>
      ) : (
        // Its own direction keeps the button out of the line's automatic one.
        <button key={at} type="button" className="ai-cite" dir={dir} title={t('ai.goToPage', { page: piece.page })} aria-label={t('ai.goToPage', { page: piece.page })} onClick={() => onPage(piece.page)}>
          {t('ai.cite', { page: piece.page })}
        </button>
      ),
    );
  return (
    <div className="ai-answer-text">
      {blocksOf(text).map((block, index) => {
        if (block.kind === 'paragraph') {
          return (
            <p key={index} dir="auto" className={block.strong ? 'ai-answer-strong' : undefined}>
              {line(block.text)}
            </p>
          );
        }
        const List = block.ordered ? 'ol' : 'ul';
        return (
          <List key={index} dir="auto">
            {block.items.map((item, at) => (
              <li key={at} dir="auto">
                {line(item)}
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
