import { describe, expect, it } from 'vitest';
import { dropTargetAt, extensionFor, fitWithin, formatsFor, handKind, moreFor, runsFor, tilesFor } from './stow';

describe('the drop zone tiles', () => {
  it('knows pictures, PDFs and documents', () => {
    expect(handKind('IMG_2041.JPG')).toBe('picture');
    expect(handKind('report.pdf')).toBe('pdf');
    expect(handKind('letter.docx')).toBe('document');
    expect(handKind('song.mp3')).toBeNull();
  });

  it('offers Web, Send and Print for a picture, and no Print for a PDF', () => {
    expect(tilesFor(['photo.png']).map((t) => t.id)).toEqual(['web', 'send', 'print']);
    expect(tilesFor(['report.pdf']).map((t) => t.id)).toEqual(['web', 'send']);
    expect(tilesFor(['letter.docx']).map((t) => t.id)).toEqual(['print']);
    expect(tilesFor(['song.mp3'])).toEqual([]);
  });

  it('makes Web a 2000 px JPEG and Send a lighter 2048 px one', () => {
    const [web, send] = tilesFor(['photo.png']);
    expect(web!.makes.picture).toMatchObject({ kind: 'picture', format: 'jpeg', maxSide: 2000 });
    expect(send!.makes.picture).toMatchObject({ kind: 'picture', format: 'jpeg', maxSide: 2048 });
    expect((send!.makes.picture as { quality: number }).quality).toBeLessThan((web!.makes.picture as { quality: number }).quality);
  });

  it('prints many pictures as one PDF', () => {
    const print = tilesFor(['a.jpg', 'b.jpg', 'c.png']).find((t) => t.id === 'print')!;
    expect(print.makes.picture).toEqual({ kind: 'tool', tool: 'topdf', onePdf: true });
    const runs = runsFor(['a.jpg', 'b.jpg', 'c.png'], print.makes);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.at).toEqual([0, 1, 2]);
  });

  it('lists the formats that fit, and Merge for two or more', () => {
    expect(formatsFor(['a.png']).map((c) => c.id)).toEqual(['jpg', 'png', 'webp', 'pdf']);
    expect(formatsFor(['a.png'], false).map((c) => c.id)).toEqual(['jpg', 'png', 'pdf']);
    expect(formatsFor(['a.pdf', 'b.pdf']).map((c) => c.id)).toEqual(['jpg', 'png', 'webp', 'docx', 'xlsx', 'pptx', 'txt', 'merge']);
    expect(formatsFor(['a.pdf']).map((c) => c.id)).not.toContain('merge');
  });

  it('runs a tile on the files of a mix it takes, each kind its own way', () => {
    const names = ['a.pdf', 'photo.jpg', 'song.mp3', 'b.pdf'];
    const web = tilesFor(names).find((t) => t.id === 'web')!;
    const runs = runsFor(names, web.makes);
    expect(runs.map((r) => r.at)).toEqual([[0, 3], [1]]);
  });

  it('brings a big picture down to its longest side, never up', () => {
    expect(fitWithin(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin(1200, 3600, 2048)).toEqual({ width: 683, height: 2048 });
    expect(fitWithin(800, 600, 2000)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(extensionFor('jpeg')).toBe('jpg');
  });

  it('finds the tile under the pointer', () => {
    const tile = { dataset: { drop: 'tile:web' } };
    const inner = { closest: () => tile };
    const doc = { elementFromPoint: (x: number) => (x === 10 ? (inner as unknown as Element) : null) };
    expect(dropTargetAt(10, 10, doc)).toBe('tile:web');
    expect(dropTargetAt(20, 10, doc)).toBeNull();
    expect(dropTargetAt(-1, -1, doc)).toBeNull();
  });
});

describe('the row to the rest of ZOOD', () => {
  it('stays short: Ask ZOOD for PDFs, Organize, the phone when paired, All tools', () => {
    expect(moreFor(['a.pdf'])).toEqual(['ask', 'organize', 'tools']);
    expect(moreFor(['a.pdf', 'b.jpg'], true)).toEqual(['ask', 'organize', 'phone', 'tools']);
    expect(moreFor(['photo.jpg'])).toEqual(['organize', 'tools']);
    expect(moreFor(['setup.exe'])).toEqual([]);
  });
});
