import { describe, expect, it } from 'vitest';
import { MAX_REVISIONS, findRevisions, revisionEnds } from './revisions';

const bytes = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

/** Where a piece of `text` ends, to name the byte lengths the finder should report. */
const endOf = (text: string, piece: string) => text.indexOf(piece) + piece.length;

// A file saved three times: the original, an update, another update. The
// second update's stream happens to contain "%%EOF", as compressed data can.
const ORIGINAL = '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\nxref\n0 3\ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n52\n%%EOF\n';
const UPDATE = '3 0 obj\n<< /Title (two) >>\nendobj\nxref\n3 1\ntrailer\n<< /Size 4 /Root 1 0 R /Prev 52 >>\nstartxref\n171\n%%EOF\r\n';
const SECOND = '4 0 obj\n<< /Length 18 >>\nstream\nnot an end: %%EOF\nendstream\nendobj\nxref\n4 1\ntrailer\n<< /Size 5 /Root 1 0 R /Prev 171 >>\nstartxref\n290\n%%EOF\n';
const FILE = ORIGINAL + UPDATE + SECOND;

describe('earlier revisions', () => {
  it('end after each startxref and %%EOF but the last, with the line break', () => {
    expect(revisionEnds(bytes(FILE))).toEqual([endOf(FILE, ORIGINAL), endOf(FILE, UPDATE)]);
    // The update ends in CR LF, and both bytes belong to it.
    expect(FILE.slice(0, endOf(FILE, UPDATE)).endsWith('%%EOF\r\n')).toBe(true);
  });

  it('ignore %%EOF where no trailer ends, such as inside a stream', () => {
    const inStream = FILE.indexOf('not an end: %%EOF') + 'not an end: %%EOF'.length;
    expect(revisionEnds(bytes(FILE))).not.toContain(inStream + 1);
  });

  it('find none in a file saved once, whatever follows its end', () => {
    expect(revisionEnds(bytes(ORIGINAL))).toEqual([]);
    expect(revisionEnds(bytes(`${ORIGINAL}\n\n  \n`))).toEqual([]);
    expect(revisionEnds(bytes(ORIGINAL.trimEnd()))).toEqual([]);
    expect(revisionEnds(bytes(''))).toEqual([]);
  });

  it('accept a lone CR or LF after %%EOF, or none', () => {
    const cr = ORIGINAL.replace(/%%EOF\n$/, '%%EOF\r');
    expect(revisionEnds(bytes(cr + SECOND))).toEqual([cr.length]);
    const bare = ORIGINAL.replace(/%%EOF\n$/, '%%EOF');
    expect(revisionEnds(bytes(bare + SECOND))).toEqual([bare.length]);
  });

  it('skip the first-page trailer of a linearized file, but keep its end when it was updated', () => {
    const head = '%PDF-1.4\n9 0 obj\n<< /Linearized 1 /L 000 /H [ 1 2 ] /O 11 /E 99 /N 2 /T 98 >>\nendobj\nxref\n9 3\ntrailer\n<< /Size 12 /Root 10 0 R >>\nstartxref\n0\n%%EOF\n';
    const rest = '1 0 obj\n<< >>\nendobj\nxref\n0 1\ntrailer\n<< /Size 12 >>\nstartxref\n120\n%%EOF\n';
    // `/L` is the length of the whole linearized file; three digits keep the head the same size.
    const original = (head + rest).replace('/L 000', `/L ${String((head + rest).length).padStart(3, '0')}`);
    expect(original.length).toBe((head + rest).length);
    expect(revisionEnds(bytes(original))).toEqual([]);
    const updated = original + UPDATE;
    expect(revisionEnds(bytes(updated))).toEqual([original.length]);
  });

  it('are offered only when the core opens them, and the file as it stands comes last', async () => {
    const opened: number[] = [];
    // This stand-in for the core refuses the middle revision.
    const pagesOf = async (prefix: ArrayBuffer) => {
      opened.push(prefix.byteLength);
      return prefix.byteLength === endOf(FILE, UPDATE) ? null : 2;
    };
    expect(await findRevisions(bytes(FILE), pagesOf)).toEqual([
      { number: 1, length: endOf(FILE, ORIGINAL), pages: 2 },
      { number: 2, length: FILE.length, pages: 2 },
    ]);
    expect(opened).toEqual([endOf(FILE, ORIGINAL), endOf(FILE, UPDATE), FILE.length]);
  });

  it('say there is one revision, the file itself, when nothing earlier opens', async () => {
    expect(await findRevisions(bytes(ORIGINAL), async () => 1)).toEqual([{ number: 1, length: ORIGINAL.length, pages: 1 }]);
    expect(await findRevisions(bytes(FILE), async () => null)).toEqual([{ number: 1, length: FILE.length, pages: null }]);
  });

  it('hand the core copies, never the file it was given', async () => {
    const file = bytes(FILE);
    const buffers: ArrayBuffer[] = [];
    await findRevisions(file, async (prefix) => {
      buffers.push(prefix);
      return 1;
    });
    expect(buffers.every((buffer) => buffer !== file.buffer)).toBe(true);
  });

  // 300 trailers on a 17 MB file kept the core busy for a minute and a half
  // the moment Compare opened (break-zood, files-ui).
  it('open only the latest revisions of a file with thousands, numbered as the file counts them', async () => {
    const trailers = Array.from({ length: 3000 }, (_, i) => `% save ${i}\nstartxref\n52\n%%EOF\n`).join('');
    const file = bytes(ORIGINAL + trailers);
    let opened = 0;
    const found = await findRevisions(file, async () => {
      opened += 1;
      return 1;
    });
    expect(opened).toBe(MAX_REVISIONS + 1);
    expect(found).toHaveLength(MAX_REVISIONS + 1);
    // 3,001 trailers: 3,000 earlier revisions and the file itself.
    expect(found[0]!.number).toBe(3001 - MAX_REVISIONS);
    expect(found.at(-1)).toEqual({ number: 3001, length: file.length, pages: 1 });
  });
});
