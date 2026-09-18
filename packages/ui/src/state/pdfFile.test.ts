import { describe, expect, it } from 'vitest';
import { isPdf, looksLikePdf } from './pdfFile';

const bytes = (text: string) => new TextEncoder().encode(text);

/**
 * Found by the end-to-end suite: the app decided "is this a PDF" from the file
 * name, so it refused its own saved file when the download had no extension —
 * as happens with PDFs sent by some mail and chat apps.
 */
describe('recognising a PDF by what it is, not what it is called', () => {
  it('finds the signature at the start', () => {
    expect(looksLikePdf(bytes('%PDF-1.7\n%âãÏÓ'))).toBe(true);
  });

  it('finds it after leading junk, within the first kilobyte', () => {
    const head = new Uint8Array(1024);
    head.set(bytes('%PDF-1.4'), 600);
    expect(looksLikePdf(head)).toBe(true);
  });

  it('does not look past the first kilobyte', () => {
    const head = new Uint8Array(2048);
    head.set(bytes('%PDF-1.4'), 1500);
    expect(looksLikePdf(head)).toBe(false);
  });

  it('rejects other formats and near misses', () => {
    expect(looksLikePdf(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe(false);
    expect(looksLikePdf(bytes('%PDF'))).toBe(false);
    expect(looksLikePdf(new Uint8Array(0))).toBe(false);
  });

  it('opens a real PDF that has no extension', async () => {
    const file = new File([bytes('%PDF-1.7\n1 0 obj')], 'download', { type: '' });
    expect(await isPdf(file)).toBe(true);
  });

  it('still lets a file named .pdf through to the core, which judges it properly', async () => {
    const file = new File([bytes('not really')], 'report.pdf', { type: '' });
    expect(await isPdf(file)).toBe(true);
  });

  it('refuses a picture with no PDF name', async () => {
    const file = new File([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)], 'photo.png', {
      type: 'image/png',
    });
    expect(await isPdf(file)).toBe(false);
  });
});
