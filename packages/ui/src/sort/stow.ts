import { isConvertibleName, isPdfName } from '../quick/plan';
import type { QuickToolId } from '../quick/plan';

/**
 * The drop zone's tiles, after the owner's "Stow" (Julien Design Craft's
 * prompt, MIT): files dragged to the top of the screen meet three big tiles
 * that say what they are for (Web, Send, Print) and a row of formats.
 * Let go on one and it is done at once, beside the originals, which are
 * never touched (`DropZone.tsx` runs it). A tile shows only when it makes
 * sense for some of the files in hand, and runs on those.
 */

/** What a file is, for the tiles. */
export type HandKind = 'picture' | 'pdf' | 'document';

/** One way of making a file: a picture redrawn here, or a quick tool. */
export type Make =
  | { kind: 'picture'; format: 'jpeg' | 'png' | 'webp'; maxSide?: number; quality?: number; suffix?: 'web' | 'send' }
  | { kind: 'tool'; tool: QuickToolId; onePdf?: boolean };

export type TileId = 'web' | 'send' | 'print';

export interface Tile {
  id: TileId;
  /** How each kind of file is made, for the kinds this tile takes. */
  makes: Partial<Record<HandKind, Make>>;
}

export interface FormatChip {
  /** The letters on the little document ("JPG"), or a word for Merge and Keep. */
  id: string;
  label: string;
  makes: Partial<Record<HandKind, Make>>;
}

/** Pictures a browser draws and the zone redraws itself (no HEIC: Windows cannot). */
const PICTURES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

export function handKind(name: string): HandKind | null {
  if (isPdfName(name)) return 'pdf';
  if (PICTURES.has(extensionOf(name))) return 'picture';
  if (isConvertibleName(name)) return 'document';
  return null;
}

/** Web = JPEG at 2000 px, light enough for a site; Send = 2048 px, lighter still; Print = PDF. */
export const WEB_SIDE = 2000;
export const SEND_SIDE = 2048;

function kindsOf(names: readonly string[]): Map<HandKind, number> {
  const kinds = new Map<HandKind, number>();
  for (const name of names) {
    const kind = handKind(name);
    if (kind) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  return kinds;
}

/** The tiles for these files, in their order; none that would do nothing. */
export function tilesFor(names: readonly string[]): Tile[] {
  const kinds = kindsOf(names);
  const several = (kind: HandKind) => (kinds.get(kind) ?? 0) > 1;
  const all: Tile[] = [
    {
      id: 'web',
      makes: {
        picture: { kind: 'picture', format: 'jpeg', maxSide: WEB_SIDE, quality: 0.82, suffix: 'web' },
        pdf: { kind: 'tool', tool: 'jpg' },
      },
    },
    {
      id: 'send',
      makes: {
        picture: { kind: 'picture', format: 'jpeg', maxSide: SEND_SIDE, quality: 0.7, suffix: 'send' },
        pdf: { kind: 'tool', tool: 'compress' },
      },
    },
    {
      id: 'print',
      makes: {
        // Many pictures, one choice: one PDF of them all.
        picture: { kind: 'tool', tool: 'topdf', onePdf: several('picture') },
        document: { kind: 'tool', tool: 'topdf' },
      },
    },
  ];
  return all.filter((tile) => [...kinds.keys()].some((kind) => tile.makes[kind]));
}

/**
 * The little formats under the tiles, then Merge (two or more PDFs, or
 * pictures and documents) and Keep (onto the shelf). `webp` is false where
 * this page cannot write WebP pictures (Safari).
 */
export function formatsFor(names: readonly string[], webp = true): FormatChip[] {
  const kinds = kindsOf(names);
  const chips: FormatChip[] = [];
  const add = (id: string, label: string, makes: FormatChip['makes']) => {
    if ([...kinds.keys()].some((kind) => makes[kind])) chips.push({ id, label, makes });
  };
  add('jpg', 'JPG', { picture: { kind: 'picture', format: 'jpeg', quality: 0.9 }, pdf: { kind: 'tool', tool: 'jpg' } });
  add('png', 'PNG', { picture: { kind: 'picture', format: 'png' }, pdf: { kind: 'tool', tool: 'images' } });
  add('webp', 'WebP', { ...(webp ? { picture: { kind: 'picture', format: 'webp', quality: 0.85 } as Make } : {}), pdf: { kind: 'tool', tool: 'webp' } });
  add('pdf', 'PDF', { picture: { kind: 'tool', tool: 'topdf' }, document: { kind: 'tool', tool: 'topdf' } });
  add('docx', 'Word', { pdf: { kind: 'tool', tool: 'word' } });
  add('xlsx', 'Excel', { pdf: { kind: 'tool', tool: 'excel' } });
  add('pptx', 'PPT', { pdf: { kind: 'tool', tool: 'powerpoint' } });
  add('txt', 'TXT', { pdf: { kind: 'tool', tool: 'text' } });
  const pdfs = kinds.get('pdf') ?? 0;
  const others = (kinds.get('picture') ?? 0) + (kinds.get('document') ?? 0);
  if (pdfs >= 2 || others >= 2) {
    chips.push({
      id: 'merge',
      label: '',
      makes: {
        ...(pdfs >= 2 ? { pdf: { kind: 'tool', tool: 'combine' } as Make } : {}),
        ...(others >= 2 ? { picture: { kind: 'tool', tool: 'topdf', onePdf: true } as Make, document: { kind: 'tool', tool: 'topdf', onePdf: true } as Make } : {}),
      },
    });
  }
  return chips;
}

/**
 * The row under the formats: the rest of ZOOD, kept to a few so the panel
 * stays calm. Ask ZOOD (its own AI, on this computer, about the PDF: the
 * editor opens at the AI chat), Organize (the Sort window: merges, splits,
 * names, folders, by click or voice), to the phone when one is paired, and
 * All tools (the quick window: every tool that fits, with the pages to
 * see). Each sends the drop on through `zone_act`.
 */
export type MoreId = 'ask' | 'organize' | 'phone' | 'tools';

export function moreFor(names: readonly string[], phone = false): MoreId[] {
  const kinds = kindsOf(names);
  if (kinds.size === 0) return [];
  const more: MoreId[] = [];
  if (kinds.has('pdf')) more.push('ask');
  more.push('organize');
  if (phone) more.push('phone');
  more.push('tools');
  return more;
}

/** Of these files, by place, the ones each way of making takes: one run per way. */
export function runsFor(names: readonly string[], makes: Partial<Record<HandKind, Make>>): { make: Make; at: number[] }[] {
  const runs: { make: Make; at: number[] }[] = [];
  names.forEach((name, at) => {
    const kind = handKind(name);
    const make = kind ? makes[kind] : undefined;
    if (!make) return;
    // Pictures and documents made into one PDF go together, as one run.
    const same = runs.find((run) => JSON.stringify(run.make) === JSON.stringify(make));
    if (same) same.at.push(at);
    else runs.push({ make, at: [at] });
  });
  return runs;
}

/** A picture's longest side brought down to `maxSide` (never up), as whole pixels. */
export function fitWithin(width: number, height: number, maxSide?: number): { width: number; height: number } {
  if (!maxSide || Math.max(width, height) <= maxSide) return { width, height };
  const scale = maxSide / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The extension a picture made in `format` is written with. */
export const extensionFor = (format: 'jpeg' | 'png' | 'webp') => (format === 'jpeg' ? 'jpg' : format);

/** What the element under the pointer stands for: `data-drop` on a tile or chip. */
export function dropTargetAt(x: number, y: number, doc: Pick<Document, 'elementFromPoint'> = document): string | null {
  if (x < 0 || y < 0) return null;
  const element = doc.elementFromPoint(x, y);
  const target = element?.closest<HTMLElement>('[data-drop]');
  return target?.dataset.drop ?? null;
}
