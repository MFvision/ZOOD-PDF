import { describe, expect, it } from 'vitest';
import { DESKTOP_CANNOT, WARRAQ_OWNS, disabledCategories } from './embedControl';

describe("EmbedPDF's commands Warraq switches off", () => {
  it('always: its Open, Close and Download, which went around Warraq', () => {
    expect(disabledCategories(false)).toEqual(WARRAQ_OWNS);
    expect(WARRAQ_OWNS).toEqual(['document-open', 'document-close', 'document-export']);
  });

  it('on desktop also: what needs a file input, a download or the browser print', () => {
    expect(disabledCategories(true)).toEqual([...WARRAQ_OWNS, ...DESKTOP_CANNOT]);
    expect(DESKTOP_CANNOT).toEqual(expect.arrayContaining(['document-print', 'capture', 'insert-image', 'insert-attachment']));
  });
});
