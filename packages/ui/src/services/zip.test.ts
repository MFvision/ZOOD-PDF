import { describe, expect, it } from 'vitest';
import { crc32, readZip, zipStore } from './zip';

const enc = new TextEncoder();

describe('store-only ZIP writer', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('writes local headers, a central directory and an end record that read back', () => {
    const files = [
      { name: 'part-1.pdf', bytes: enc.encode('%PDF-1.7 one') },
      { name: 'الجزء-٢.pdf', bytes: enc.encode('%PDF-1.7 two!') },
    ];
    const zip = zipStore(files, new Date(2026, 8, 25, 10, 30, 12));
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    // end of central directory is the last 22 bytes (no comment)
    const eocd = zip.byteLength - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 10, true)).toBe(2);
    const back = readZip(zip);
    expect(back.map((f) => f.name)).toEqual(['part-1.pdf', 'الجزء-٢.pdf']);
    expect(new TextDecoder().decode(back[1]!.bytes)).toBe('%PDF-1.7 two!');
    // UTF-8 names are flagged (general purpose bit 11) and stored uncompressed (method 0)
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    expect(view.getUint16(8, true)).toBe(0);
    // DOS date/time: 2026-09-25 10:30:12
    expect(view.getUint16(10, true)).toBe((10 << 11) | (30 << 5) | 6);
    expect(view.getUint16(12, true)).toBe(((2026 - 1980) << 9) | (9 << 5) | 25);
  });

  it('makes names unique and safe', () => {
    const z = zipStore([
      { name: '../a/b.pdf', bytes: new Uint8Array([1]) },
      { name: 'b.pdf', bytes: new Uint8Array([2]) },
      { name: '', bytes: new Uint8Array([3]) },
    ]);
    expect(readZip(z).map((f) => f.name)).toEqual(['b.pdf', 'b (2).pdf', 'file.pdf']);
  });

  it('refuses archives that need ZIP64', () => {
    const big = { name: 'x', bytes: { byteLength: 0x1_0000_0000 } as unknown as Uint8Array };
    expect(() => zipStore([big])).toThrow(/too large/);
  });
});
