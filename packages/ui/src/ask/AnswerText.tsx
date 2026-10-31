import type { ReactNode } from 'react';
import { openExternalUrl } from '../core/host-tauri';
import { isOpenableUrl } from '../links/openLink';
import { cellText, splitTable } from './research';

/**
 * An answer as the island shows it. Most are plain words; one from the web
 * (`research.ts`) has a table of things to compare and the pages it came
 * from. A table is drawn as one, and a web address as its site's name — the
 * whole address on hover — which opens in the browser only when pressed.
 */

const ADDRESS = /https?:\/\/[^\s)<>\]|]+/g;

/** "amazon.sa" for https://www.amazon.sa/dp/…: where a link goes, as people say it. */
function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Words with their web addresses as links. */
function withLinks(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(ADDRESS)) {
    const url = match[0].replace(/[.,;:!?،]+$/, '');
    const at = match.index;
    out.push(text.slice(last, at));
    out.push(
      isOpenableUrl(url) ? (
        <button
          key={`${at}-${url}`}
          type="button"
          className="ask-link"
          title={url}
          onClick={() => void openExternalUrl(url).catch(() => undefined)}
        >
          {siteOf(url)}
        </button>
      ) : (
        url
      ),
    );
    last = at + url.length;
  }
  out.push(text.slice(last));
  return out;
}

export function AnswerText({ text }: { text: string }) {
  const table = splitTable(text);
  if (!table && !/https?:\/\//.test(text)) {
    return (
      <p className="ask-text" dir="auto">
        {text}
      </p>
    );
  }
  const [header, ...body] = table?.rows ?? [];
  return (
    <div className="ask-text ask-answer">
      {(table ? table.before : text) && <p dir="auto">{withLinks(table ? table.before : text)}</p>}
      {table && header && (
        <div className="ask-table-wrap">
          <table className="ask-table" dir="auto">
            <thead>
              <tr>
                {header.map((cell, c) => (
                  <th key={c}>{cellText(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                <tr key={r}>
                  {header.map((_, c) => (
                    <td key={c}>{withLinks(cellText(row[c] ?? ''))}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {table?.after && <p dir="auto">{withLinks(table.after)}</p>}
    </div>
  );
}
