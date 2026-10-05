import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParagraphData } from '../core/types';
import { appReducer, createInitialState } from '../state/appReducer';
import { closestBundled, faceLabel, faceOf, fontForNewText, resolveFont } from './fontMatch';
import type { OriginalFace } from './fontMatch';

const face = (kind: OriginalFace['kind'], family = 'Montserrat'): OriginalFace => ({
  family,
  weight: 600,
  italic: false,
  kind,
});

/** The bundled faces are fetched from the app's own origin; here, from a stub. */
function stubBundledFonts(): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    asked.push(url);
    const name = /(Amiri|Cairo|Inter)/.exec(url)?.[1] ?? '?';
    return Promise.resolve(new Response(new TextEncoder().encode(name)));
  });
  return asked;
}

afterEach(() => vi.unstubAllGlobals());

describe('the closest bundled face', () => {
  it('is Amiri for Arabic in a serif, a Naskh or an unknown face, and Cairo for a sans', () => {
    expect(closestBundled(face('serif'), 'نص عربي')).toBe('amiri');
    expect(closestBundled(face('unknown'), 'نص عربي')).toBe('amiri');
    expect(closestBundled(null, 'نص عربي')).toBe('amiri');
    expect(closestBundled(face('sans'), 'نص عربي')).toBe('cairo');
  });

  it('is Inter for Latin in a sans or an unknown face, and Amiri for a serif', () => {
    expect(closestBundled(face('sans'), 'Family Assistant')).toBe('inter');
    expect(closestBundled(face('unknown'), 'Family Assistant')).toBe('inter');
    expect(closestBundled(null, 'Family Assistant')).toBe('inter');
    expect(closestBundled(face('serif'), 'Family Assistant')).toBe('amiri');
  });

  it('follows the Arabic of mixed text, which Inter cannot draw', () => {
    expect(closestBundled(face('sans'), 'Invoice فاتورة 2026')).toBe('cairo');
    expect(closestBundled(face('unknown'), 'Invoice فاتورة 2026')).toBe('amiri');
  });

  it('keeps an emptied paragraph in the script it was written in', () => {
    expect(closestBundled(face('sans'), '', 'rtl')).toBe('cairo');
    expect(closestBundled(face('sans'), '  ', 'ltr')).toBe('inter');
  });

  it('gives new text Inter or Amiri by its script when nothing was chosen', () => {
    expect(fontForNewText('auto', 'Hello')).toBe('inter');
    expect(fontForNewText('auto', 'مرحبا')).toBe('amiri');
    expect(fontForNewText('cairo', 'Hello')).toBe('cairo');
  });
});

describe('a paragraph\'s face', () => {
  const paragraph = (extra: Partial<ParagraphData>): ParagraphData => ({
    index: 0,
    text: 'x',
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    direction: 'ltr',
    alignment: 'start',
    fontSize: 12,
    lineCount: 1,
    ...extra,
  });

  it('is read from what the core reports, and absent when the file names none', () => {
    expect(
      faceOf(paragraph({ fontFamily: 'Montserrat', fontWeight: 600, fontItalic: true, fontClass: 'sans' })),
    ).toEqual({ family: 'Montserrat', weight: 600, italic: true, kind: 'sans' });
    expect(faceOf(paragraph({ fontFamily: '' }))).toBeNull();
    expect(faceOf(paragraph({}))).toBeNull();
    expect(faceOf(undefined)).toBeNull();
  });

  it('is named as a reader would name it', () => {
    expect(faceLabel(face('sans'))).toBe('Montserrat SemiBold');
    expect(faceLabel({ family: 'Lato', weight: 400, italic: true, kind: 'sans' })).toBe('Lato Italic');
    expect(faceLabel({ family: 'Cairo', weight: 400, italic: false, kind: 'sans' })).toBe('Cairo');
  });
});

describe('resolving a font for a paragraph whose own could not be used', () => {
  it('takes an installed font first and says so', async () => {
    const asked = stubBundledFonts();
    const installed = vi.fn(() => Promise.resolve({ name: 'Montserrat', bytes: Uint8Array.of(1, 2, 3) }));
    const library = vi.fn(() => Promise.resolve({ name: 'Montserrat', bytes: Uint8Array.of(9) }));
    const { used, bytes } = await resolveFont(face('sans'), 'Budget', 'ltr', { installed, library });
    expect(used).toEqual({ source: 'installed', name: 'Montserrat', wanted: 'Montserrat' });
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(installed).toHaveBeenCalledWith(face('sans'), 'Budget');
    expect(library).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  it('takes the open library next', async () => {
    stubBundledFonts();
    const { used } = await resolveFont(face('sans'), 'Budget', 'ltr', {
      installed: () => Promise.resolve(null),
      library: () => Promise.resolve({ name: 'Montserrat', bytes: Uint8Array.of(9) }),
    });
    expect(used).toEqual({ source: 'downloaded', name: 'Montserrat', wanted: 'Montserrat' });
  });

  it('falls through to the closest bundled face, and never loses the edit to a lookup that fails', async () => {
    const asked = stubBundledFonts();
    const { used, bytes } = await resolveFont(face('sans'), 'Budget', 'ltr', {
      installed: () => Promise.reject(new Error('E_FONT: unreadable')),
      library: () => Promise.resolve({ name: 'Montserrat', bytes: new Uint8Array(0) }),
    });
    expect(used).toEqual({ source: 'bundled', name: 'Inter', wanted: 'Montserrat' });
    expect(new TextDecoder().decode(bytes)).toBe('Inter');
    expect(asked).toHaveLength(1);
  });

  it('asks no host about a paragraph whose file names no face', async () => {
    stubBundledFonts();
    const installed = vi.fn(() => Promise.resolve({ name: 'X', bytes: Uint8Array.of(1) }));
    const { used } = await resolveFont(null, 'نص', 'rtl', { installed });
    expect(used).toEqual({ source: 'bundled', name: 'Amiri', wanted: null });
    expect(installed).not.toHaveBeenCalled();
  });
});

describe('the edit state', () => {
  it('starts on Automatic, and remembers what a substituted edit was drawn in', () => {
    let state = createInitialState();
    expect(state.edit.font).toBe('auto');
    const entry = { page: 0, paragraphIndex: 0, before: 'a', after: 'b' };
    // Drawn in the paragraph's own font: nothing to tell.
    state = appReducer(state, {
      type: 'EDIT_APPLIED',
      entry,
      fontSubstituted: false,
      fontUsed: { source: 'own', name: 'Montserrat', wanted: 'Montserrat' },
    });
    expect(state.edit.fontSubstituted).toBe(false);
    expect(state.edit.fontUsed).toBeNull();
    const used = { source: 'bundled', name: 'Inter', wanted: 'Montserrat' } as const;
    state = appReducer(state, { type: 'EDIT_APPLIED', entry, fontSubstituted: true, fontUsed: used, shrunk: true });
    expect(state.edit.fontSubstituted).toBe(true);
    expect(state.edit.fontUsed).toEqual(used);
    expect(state.edit.textShrunk).toBe(true);
    state = appReducer(state, { type: 'EDIT_NOTICE_DISMISSED' });
    expect(state.edit.fontSubstituted).toBe(false);
    expect(state.edit.fontUsed).toBeNull();
    expect(state.edit.textShrunk).toBe(false);
  });
});
