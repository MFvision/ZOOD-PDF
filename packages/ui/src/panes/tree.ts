import type { Direction } from '../i18n/messages';

/** One bookmark as `outline.list` gives it: flat, in reading order, with its depth. */
export interface Bookmark {
  title: string;
  depth: number;
  /** Zero-based; null for one that goes outside the file, or nowhere (a heading). */
  page: number | null;
  /** It goes outside the file: a web address, another file, a program. */
  outside: boolean;
  open: boolean;
  children: number;
}

/** What a key does in a tree (WAI-ARIA's tree pattern), right and left mirrored right to left. */
export type TreeMove = 'next' | 'previous' | 'first' | 'last' | 'open' | 'close' | 'activate';

export function treeKey(key: string, dir: Direction): TreeMove | null {
  const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
  const backward = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
  switch (key) {
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'previous';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    case forward:
      return 'open';
    case backward:
      return 'close';
    case 'Enter':
    case ' ':
      return 'activate';
    default:
      return null;
  }
}

/** The bookmarks a person sees: every one whose parents are all open. */
export function visibleBookmarks(items: readonly Bookmark[], closed: ReadonlySet<number>): { item: Bookmark; index: number }[] {
  const out: { item: Bookmark; index: number }[] = [];
  // Depth below which entries are hidden, while inside a closed one.
  let hiddenBelow = Number.POSITIVE_INFINITY;
  items.forEach((item, index) => {
    if (item.depth > hiddenBelow) return;
    hiddenBelow = Number.POSITIVE_INFINITY;
    out.push({ item, index });
    if (closed.has(index)) hiddenBelow = item.depth;
  });
  return out;
}

/** One layer as `layers.list` gives it. */
export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  print: boolean | null;
  export: boolean | null;
}

/** The order a viewer lists layers in: a layer with those under it, or a labelled group. */
export type LayerNode = { id: string; children: LayerNode[] } | { label: string; children: LayerNode[] };

/** The ids of the layers to show when `id` is switched, the rest as they are. */
export function switched(layers: readonly Layer[], id: string): string[] {
  return layers.filter((layer) => (layer.id === id ? !layer.visible : layer.visible)).map((layer) => layer.id);
}

/** Bytes as a person reads them, in their language. */
export function sizeText(bytes: number, lang: string): string {
  const units = lang === 'ar' ? ['بايت', 'ك.ب', 'م.ب'] : ['bytes', 'KB', 'MB'];
  if (bytes < 1024) return `${bytes} ${units[0]}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} ${units[1]}`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} ${units[2]}`;
}
