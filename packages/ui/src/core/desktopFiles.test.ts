import { describe, expect, it } from 'vitest';
import { blobRegistry, dataUrlBytes, filtersFor, mimeFor, saveFilterFor } from './desktopFiles';

describe('the desktop file bridge', () => {
  it("turns an input's accept into the native panel's filters", () => {
    expect(filtersFor('image/*')[0]?.extensions).toEqual(
      expect.arrayContaining(['png', 'jpg', 'jpeg']),
    );
    expect(filtersFor('.pdf,application/pdf')[0]?.extensions).toEqual(['pdf']);
    expect(filtersFor('image/png, image/jpeg')[0]?.extensions).toEqual(['png', 'jpg', 'jpeg']);
    expect(filtersFor('')).toEqual([]);
    expect(
      filtersFor('application/x-unknown'),
      'an unknown type allows any file rather than none',
    ).toEqual([]);
  });

  it('reads a chosen file as the type its name says', () => {
    expect(mimeFor('توقيع.PNG')).toBe('image/png');
    expect(mimeFor('scan.jpeg')).toBe('image/jpeg');
    expect(mimeFor('notes')).toBe('application/octet-stream');
  });

  it("offers a download's own kind of file in the save panel", () => {
    expect(saveFilterFor('page-1.png')).toEqual({ name: 'PNG', extensions: ['png'] });
  });

  it('decodes data: URLs, base64 and plain', () => {
    expect([...(dataUrlBytes('data:image/png;base64,iVBORw==') ?? [])].slice(0, 4)).toEqual([
      0x89, 0x50, 0x4e, 0x47,
    ]);
    expect(
      new TextDecoder().decode(
        dataUrlBytes('data:text/plain,%D9%88%D8%B1%D8%A7%D9%82') ?? new Uint8Array(),
      ),
    ).toBe('وراق');
    expect(dataUrlBytes('https://example.com')).toBeNull();
  });

  it('remembers the Blob behind each blob: URL until it is revoked', async () => {
    const registry = blobRegistry(globalThis);
    try {
      const url = URL.createObjectURL(new Blob(['وراق']));
      expect(await registry.get(url)?.text()).toBe('وراق');
      URL.revokeObjectURL(url);
      expect(registry.get(url)).toBeUndefined();
    } finally {
      registry.restore();
    }
  });
});
