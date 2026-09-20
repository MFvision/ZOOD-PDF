/**
 * Which pages a batch step works on. The files of a batch are of any
 * length, so a choice is made once and read against each file: "every
 * page", "odd", "even", or a list such as `1-3, 5, 8-`, where a number past
 * a file's last page is simply not in that file (a range is cut at its
 * end) rather than an error for the whole batch.
 */

export type PageWhich = 'all' | 'odd' | 'even' | 'list';

export interface PageChoice {
  which: PageWhich;
  /** For `list`: `1-3, 5, 8-`, in Western or Arabic-Indic digits. */
  list: string;
}

export const ALL_PAGES: PageChoice = { which: 'all', list: '' };

/** Western digits for Arabic-Indic and Persian ones, a comma for the Arabic one, a hyphen for dashes. */
function plain(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[،؛;]/g, ',')
    .replace(/[–—]/g, '-');
}

/** The parts of a list, each `[from, to]` one-based (`to` Infinity for "8-"); null when it does not read as pages. */
export function parseList(text: string): [number, number][] | null {
  const parts: [number, number][] = [];
  for (const part of plain(text).split(',')) {
    const piece = part.trim();
    if (piece === '') continue;
    const match = /^(\d{1,6})?\s*(-)?\s*(\d{1,6})?$/.exec(piece);
    if (!match || (!match[1] && !match[3])) return null;
    const from = match[1] ? Number(match[1]) : 1;
    const to = match[2] ? (match[3] ? Number(match[3]) : Infinity) : from;
    if (from < 1 || to < from) return null;
    parts.push([from, to]);
  }
  return parts.length > 0 ? parts : null;
}

/** Whether a choice can be read at all (a list that is a list). */
export function choiceValid(choice: PageChoice): boolean {
  return choice.which !== 'list' || parseList(choice.list) !== null;
}

/** The chosen pages of a file of `count` pages, zero-based and in order; null when the list does not read. */
export function choosePages(choice: PageChoice, count: number): number[] | null {
  const all = Array.from({ length: Math.max(0, count) }, (_, k) => k);
  switch (choice.which) {
    case 'all':
      return all;
    case 'odd':
      return all.filter((k) => k % 2 === 0);
    case 'even':
      return all.filter((k) => k % 2 === 1);
    case 'list': {
      const parts = parseList(choice.list);
      if (!parts) return null;
      const out = new Set<number>();
      for (const [from, to] of parts) {
        for (let page = from; page <= Math.min(to, count); page += 1) out.add(page - 1);
      }
      return [...out].sort((a, b) => a - b);
    }
  }
}

/** A stored choice, checked. */
export function sanitizeChoice(raw: unknown, fallback: PageChoice = ALL_PAGES): PageChoice {
  const given = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const which = (['all', 'odd', 'even', 'list'] as const).find((w) => w === given.which) ?? fallback.which;
  const list = typeof given.list === 'string' ? given.list.slice(0, 200) : fallback.list;
  return { which, list };
}
