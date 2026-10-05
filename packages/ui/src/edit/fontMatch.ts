/**
 * Which font replaced text is drawn in, when the reader has not chosen one.
 *
 * A replaced paragraph used to come back in Amiri whatever it had been set
 * in. "Automatic" now tries, in this order, and says which it used:
 *
 *   A. the paragraph's OWN font, by its own character codes — the core does
 *      this when every letter of the new text is one the document already
 *      has (left-to-right text only; Arabic is always shaped afresh);
 *   B. a font installed on this device, matched by the original's name;
 *   C. the same family from the open library, once the reader has agreed;
 *   D. the closest face the app carries.
 *
 * B and C are the host's to provide (`FontProviders`): a browser has no
 * installed fonts to read, the desktop app has. A step that finds nothing,
 * or a font without the letters the text needs, falls through to the next —
 * a paragraph is never drawn in two faces.
 */
import type { ParagraphData, TextDirection } from '../core/types';
import type { EditFontId } from './editFont';
import { editFontName, loadEditFont } from './editFont';

/** What the Edit panel's font control holds: Automatic, or a bundled face. */
export type FontChoice = 'auto' | EditFontId;

/** The face a paragraph is set in, as its file names it. */
export interface OriginalFace {
  /** Sanitised by the core: letters, digits, spaces, hyphens, ≤ 64 chars. */
  family: string;
  /** 100–900. */
  weight: number;
  italic: boolean;
  kind: 'serif' | 'sans' | 'unknown';
}

/** Where the font an edit was drawn in came from. */
export type FontSource = 'own' | 'installed' | 'downloaded' | 'bundled' | 'chosen';

/** What an edit was drawn in, for the notice that tells the reader. */
export interface FontUsed {
  source: FontSource;
  /** The face drawn: a family's name, never translated. */
  name: string;
  /** The family the paragraph was set in, when the file names one. */
  wanted: string | null;
}

/** A font a host found for a face. */
export interface FoundFont {
  name: string;
  bytes: Uint8Array;
}

/** The steps only a host can take; each answers `null` to fall through. */
export interface FontProviders {
  /** B: a font installed on this device. */
  installed?: (face: OriginalFace, text: string) => Promise<FoundFont | null>;
  /** C: the same family from the open library (asks the reader once). */
  library?: (face: OriginalFace, text: string) => Promise<FoundFont | null>;
}

export function faceOf(paragraph: ParagraphData | undefined): OriginalFace | null {
  if (!paragraph?.fontFamily) return null;
  return {
    family: paragraph.fontFamily,
    weight: paragraph.fontWeight ?? 400,
    italic: paragraph.fontItalic ?? false,
    kind: paragraph.fontClass ?? 'unknown',
  };
}

const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** Whether any letter of `text` is in the Arabic script. */
export function hasArabic(text: string): boolean {
  return ARABIC.test(text);
}

/**
 * D: the closest face the app carries. Arabic text takes Amiri for a serif,
 * a Naskh or a face nothing is known of, and Cairo for a sans or a Kufi;
 * Latin text takes Inter for a sans or an unknown face and Amiri for a
 * serif. Amiri and Cairo both carry Latin, so mixed text follows its Arabic.
 */
export function closestBundled(
  face: OriginalFace | null,
  text: string,
  direction: TextDirection = 'ltr',
): EditFontId {
  const kind = face?.kind ?? 'unknown';
  // A paragraph emptied of its text keeps the script it was written in.
  const arabic = hasArabic(text) || (text.trim().length === 0 && direction === 'rtl');
  if (arabic) return kind === 'sans' ? 'cairo' : 'amiri';
  return kind === 'serif' ? 'amiri' : 'inter';
}

const WEIGHT_NAMES: Readonly<Record<number, string>> = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
};

/** `Montserrat SemiBold Italic`: a face as a reader would name it. */
export function faceLabel(face: OriginalFace): string {
  const weight = WEIGHT_NAMES[Math.round(face.weight / 100) * 100];
  return [face.family, weight, face.italic ? 'Italic' : null].filter(Boolean).join(' ');
}

/**
 * B → C → D for a paragraph whose own font could not be used: the bytes to
 * hand the core, and where they came from. A provider that throws is a
 * provider that found nothing — an edit is never lost to a font lookup.
 */
export async function resolveFont(
  face: OriginalFace | null,
  text: string,
  direction: TextDirection,
  providers: FontProviders = {},
): Promise<{ used: FontUsed; bytes: Uint8Array }> {
  const wanted = face?.family ?? null;
  if (face) {
    const steps: [FontSource, FontProviders['installed']][] = [
      ['installed', providers.installed],
      ['downloaded', providers.library],
    ];
    for (const [source, find] of steps) {
      if (!find) continue;
      const found = await find(face, text).catch(() => null);
      if (found && found.bytes.byteLength > 0) {
        return { used: { source, name: found.name, wanted }, bytes: found.bytes };
      }
    }
  }
  const id = closestBundled(face, text, direction);
  return {
    used: { source: 'bundled', name: editFontName(id), wanted },
    bytes: await loadEditFont(id),
  };
}

/** The face new text is drawn in when none was chosen and no paragraph is replaced. */
export function fontForNewText(choice: FontChoice, text: string): EditFontId {
  return choice === 'auto' ? closestBundled(null, text) : choice;
}
