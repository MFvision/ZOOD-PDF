import { describe, expect, it } from 'vitest';
import { actionsFor, convertibleTo, fittingFor, targetsOf, typeOf } from './shelf';

describe('the shelf', () => {
  const items = [{ path: '/a.pdf' }, { path: '/b.pdf' }, { path: '/c.jpg' }];

  it('acts on the picked files, or on all when none is picked', () => {
    expect(targetsOf(items, new Set())).toEqual(items);
    expect(targetsOf(items, new Set(['/b.pdf']))).toEqual([{ path: '/b.pdf' }]);
    // A pick that left the shelf counts as none.
    expect(targetsOf(items, new Set(['/gone.pdf']))).toEqual(items);
  });

  it('offers Organize first, then merging for several PDFs', () => {
    const kinds = actionsFor(['a.pdf', 'b.pdf'], false).map((a) => (a.kind === 'tool' ? a.tool : a.kind));
    expect(kinds[0]).toBe('organize');
    expect(kinds[1]).toBe('combine');
    expect(kinds).toContain('compress');
    expect(kinds).not.toContain('phone');
    expect(kinds).not.toContain('open');
  });

  it('makes one PDF of several pictures, and opens a single file', () => {
    expect(actionsFor(['a.jpg', 'b.png'], true)[1]).toEqual({ kind: 'tool', tool: 'topdf', onePdf: true });
    expect(actionsFor(['a.jpg', 'b.png'], true).at(-1)).toEqual({ kind: 'phone' });
    expect(actionsFor(['report.pdf'], false).map((a) => a.kind)).toContain('open');
    expect(actionsFor([], false)).toEqual([]);
  });

  it('greys the formats none of the files can become', () => {
    expect([...convertibleTo(['a.pdf'])].sort()).toEqual(['excel', 'images', 'jpg', 'powerpoint', 'text', 'webp', 'word'].sort());
    expect([...convertibleTo(['a.jpg', 'b.docx'])]).toEqual(['topdf']);
    expect(convertibleTo(['notes.zip']).size).toBe(0);
  });

  it('runs a tool on the files of a mix it takes', () => {
    const mix = ['a.pdf', 'photo.jpg', 'b.pdf', 'Invoice.docx', 'song.mp3'];
    expect(fittingFor('combine', mix)).toEqual([0, 2]);
    expect(fittingFor('topdf', mix)).toEqual([1, 3]);
    // Combine needs two PDFs.
    expect(fittingFor('combine', ['a.pdf', 'photo.jpg'])).toEqual([]);
    const kinds = actionsFor(mix, false).map((a) => (a.kind === 'tool' ? `${a.tool}${a.onePdf ? '-one' : ''}` : a.kind));
    expect(kinds.slice(0, 4)).toEqual(['organize', 'combine', 'topdf-one', 'compress']);
    expect(convertibleTo(mix).has('topdf') && convertibleTo(mix).has('word')).toBe(true);
  });

  it('badges a file by its type', () => {
    expect(typeOf('Report.final.pdf')).toBe('PDF');
    expect(typeOf('photo.jpeg')).toBe('JPEG');
    expect(typeOf('README')).toBe('');
  });
});
