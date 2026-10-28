import { blockText } from './blocks';
import type { Block } from './blocks';

/**
 * The faces a document is set in: the families its source names (Arial,
 * Calibri, Sakkal Majalla…) where this computer has them and their licence
 * lets them be embedded, then the faces the app carries. A family that is
 * not to be had is stood in for by one of the same kind — a sans for a sans,
 * a book face only for a book face — never Amiri for everything, which set
 * an Arial letter in a serif and ran it onto a second page.
 */

export interface NamedFont {
  name: string;
  bytes: ArrayBuffer;
}

/** What finding faces needs: the bundled ones, and an installed family that has `text`'s letters. */
export interface FaceSource {
  fonts(): Promise<NamedFont[]>;
  installedFont?(family: string, text: string): Promise<ArrayBuffer | null>;
}

/** At most this many families are looked for: a document names a few, a pathological one hundreds. */
const MAX_FAMILIES = 8;
const MAX_CHARS = 4000;
const ARABIC = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

const key = (family: string) => family.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]/g, '');

/** A book (serif) face by its name; anything else is taken for a sans, as most office fonts are. */
export function isSerif(family: string): boolean {
  return /times|georgia|cambria|garamond|serif|naskh|amiri|traditional arabic|simplified arabic|arabic typesetting|book antiqua|palatino|minion|baskerville|sakkal|majalla|lotus|mitra|nazanin|badr|scheherazade|constantia|century schoolbook|bookman/i.test(
    family,
  );
}

function visit(blocks: readonly Block[], note: (family: string | undefined, text: string) => void): void {
  for (const block of blocks) {
    if (block.type === 'text') note(block.font, blockText(block));
    else if (block.type === 'table') for (const cell of block.rows.flat()) note(cell.font ?? block.font, cell.text);
    else if (block.type === 'frame') visit(block.blocks, note);
  }
}

function assign(blocks: Block[], faceOf: (family: string | undefined) => number | undefined): Block[] {
  return blocks.map((block): Block => {
    if (block.type === 'text') {
      const face = faceOf(block.font);
      return face === undefined ? block : { ...block, face };
    }
    if (block.type === 'table') {
      const face = faceOf(block.font);
      return {
        ...block,
        ...(face === undefined ? {} : { face }),
        rows: block.rows.map((row) =>
          row.map((cell) => {
            const own = cell.font ? faceOf(cell.font) : undefined;
            return own === undefined ? cell : { ...cell, face: own };
          }),
        ),
      };
    }
    if (block.type === 'frame') return { ...block, blocks: assign(block.blocks, faceOf) };
    return block;
  });
}

export interface DocumentFaces {
  fonts: NamedFont[];
  /** The blocks with each named family's face (`face`) set. */
  blocks: Block[];
  header: Block[];
  footer: Block[];
}

/** The faces for `blocks` (with their header and footer), and the blocks pointing at them. */
export async function documentFaces(
  source: FaceSource,
  blocks: Block[],
  header: Block[],
  footer: Block[],
): Promise<DocumentFaces> {
  const bundled = await source.fonts();
  const usage = new Map<string, { family: string; weight: number; chars: Set<string> }>();
  const use = (family: string | undefined, text: string) => {
    if (!family) return;
    const k = key(family);
    if (!k) return;
    const entry = usage.get(k) ?? { family, weight: 0, chars: new Set<string>() };
    for (const c of text) {
      if (/\s/.test(c)) continue;
      entry.weight += 1;
      if (entry.chars.size < MAX_CHARS) entry.chars.add(c);
    }
    usage.set(k, entry);
  };
  for (const list of [blocks, header, footer]) visit(list, use);
  if (usage.size === 0) return { fonts: bundled, blocks, header, footer };

  const named = [...usage.values()].sort((a, b) => b.weight - a.weight).slice(0, MAX_FAMILIES);
  const found = new Map<string, ArrayBuffer>();
  if (source.installedFont) {
    for (const entry of named) {
      if (bundled.some((f) => key(f.name) === key(entry.family))) continue;
      const chars = [...entry.chars];
      const arabic = chars.filter((c) => ARABIC.test(c));
      const other = chars.filter((c) => !ARABIC.test(c));
      // The face for all its letters, else for the script most of them are in
      // (the paragraphs it lacks letters for fall back on their own).
      const tries = [chars.join(''), (arabic.length >= other.length ? arabic : other).join('')].filter((t, k, all) => t && all.indexOf(t) === k);
      for (const text of tries) {
        const bytes = await source.installedFont(entry.family, text).catch(() => null);
        if (bytes && bytes.byteLength > 0) {
          found.set(key(entry.family), bytes);
          break;
        }
      }
    }
  }
  // The faces in the order the core falls back in: the document's main
  // family first, the other found families, then the bundled ones with the
  // kind of the main family first.
  const bundledIndex = (name: string) => bundled.findIndex((f) => key(f.name) === key(name));
  const main = named[0]!;
  const fonts: NamedFont[] = [];
  const add = (font: NamedFont) => {
    const k = fonts.findIndex((f) => key(f.name) === key(font.name));
    if (k >= 0) return k;
    fonts.push(font);
    return fonts.length - 1;
  };
  for (const entry of named) {
    const bytes = found.get(key(entry.family));
    if (bytes) add({ name: entry.family, bytes });
  }
  const standIn = (family: string, chars: Set<string>): string => {
    if (isSerif(family)) return 'Amiri';
    return [...chars].some((c) => ARABIC.test(c)) ? 'Cairo' : 'Inter';
  };
  const mainStandIn = standIn(main.family, main.chars);
  for (const name of [mainStandIn, ...bundled.map((f) => f.name)]) {
    const k = bundledIndex(name);
    if (k >= 0) add(bundled[k]!);
  }
  const faceOf = (family: string | undefined): number | undefined => {
    if (!family) return undefined;
    const own = fonts.findIndex((f) => key(f.name) === key(family));
    if (own >= 0) return own;
    const entry = usage.get(key(family));
    const stand = fonts.findIndex((f) => key(f.name) === key(standIn(family, entry?.chars ?? new Set())));
    return stand >= 0 ? stand : undefined;
  };
  return { fonts, blocks: assign(blocks, faceOf), header: assign(header, faceOf), footer: assign(footer, faceOf) };
}
