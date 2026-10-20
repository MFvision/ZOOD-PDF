import { useAppState } from '../state/AppContext';
import type { ToolId } from '../tools/tools';

/**
 * The Workbench look has its own layout (master prompt 3.3, research
 * `docs/research/pdfcraft-theme.md` Part 2): the document tabs at the very
 * top with a Home tab, a mode bar under them, the tools down the leading side,
 * the panels behind a slim rail on the trailing side and a small quick bar on
 * the page. Every other look keeps the usual layout.
 */
export function useWorkbench(): boolean {
  return useAppState().look === 'workbench';
}

/** The mode bar's named modes, each the tool it opens. */
export const WORKBENCH_MODES: readonly { tool: ToolId; label: 'workbench.edit' | 'workbench.convert' | 'workbench.sign' }[] = [
  { tool: 'edit', label: 'workbench.edit' },
  { tool: 'export', label: 'workbench.convert' },
  { tool: 'fillSign', label: 'workbench.sign' },
];

/** Letters as typed and as written compared alike: case, Arabic marks and the forms of alef, ya and ta marbuta. */
export function foldForSearch(text: string): string {
  return text
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ًͯ-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim();
}

/**
 * The tools whose name has every word of `query`, those starting with it
 * first, in the tools' own order otherwise. An empty query matches nothing.
 */
export function matchTools<T>(query: string, tools: readonly T[], nameOf: (tool: T) => string): T[] {
  const words = foldForSearch(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const found = tools
    .map((tool, order) => ({ tool, order, name: foldForSearch(nameOf(tool)) }))
    .filter(({ name }) => words.every((word) => name.includes(word)));
  const first = words[0]!;
  return found
    .sort((a, b) => Number(!a.name.startsWith(first)) - Number(!b.name.startsWith(first)) || a.order - b.order)
    .map(({ tool }) => tool);
}
