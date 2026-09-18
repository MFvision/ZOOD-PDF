import { unzipSync, unzlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { crc32, encodePng, zipImages } from './png';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface Chunk {
  type: string;
  data: Uint8Array;
  crcOk: boolean;
}

/** Reads a PNG back chunk by chunk, checking every CRC on the way. */
function chunks(png: Uint8Array): Chunk[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: Chunk[] = [];
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    out.push({ type, data, crcOk: view.getUint32(at + 8 + length) === crc32(png, at + 4, at + 8 + length) });
    at += 12 + length;
  }
  return out;
}

/** A width-by-height RGBA bitmap filled by `pixel(x, y)`. */
function bitmap(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) rgba.set(pixel(x, y), (y * width + x) * 4);
  return rgba;
}

describe('CRC-32', () => {
  it('matches the standard check values', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082);
  });
});

describe('PNG encoder', () => {
  it('writes a valid PNG whose pixels read back exactly', () => {
    const rgba = bitmap(3, 2, (x, y) => [x * 100, y * 50, 7, 255]);
    const png = encodePng(3, 2, rgba, 150);
    expect([...png.subarray(0, 8)]).toEqual(SIGNATURE);
    const all = chunks(png);
    expect(all.map((c) => c.type)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND']);
    expect(all.every((c) => c.crcOk)).toBe(true);
    const header = new DataView(all[0]!.data.buffer, all[0]!.data.byteOffset);
    expect([header.getUint32(0), header.getUint32(4), all[0]!.data[8], all[0]!.data[9]]).toEqual([3, 2, 8, 2]);
    // 150 dpi, in pixels per metre.
    const physical = new DataView(all[1]!.data.buffer, all[1]!.data.byteOffset);
    expect([physical.getUint32(0), physical.getUint32(4), all[1]!.data[8]]).toEqual([5906, 5906, 1]);
    const rows = unzlibSync(all[2]!.data);
    expect([...rows]).toEqual([0, 0, 0, 7, 100, 0, 7, 200, 0, 7, 0, 0, 50, 7, 100, 50, 7, 200, 50, 7]);
  });

  it('writes a grey page as greyscale, a third of the data', () => {
    const png = encodePng(2, 1, bitmap(2, 1, (x) => (x === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255])));
    const all = chunks(png);
    expect(all.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(all[0]!.data[9]).toBe(0);
    expect([...unzlibSync(all[1]!.data)]).toEqual([0, 0, 255]);
  });

  it('puts what alpha leaves uncovered on white', () => {
    // Premultiplied half-transparent black is mid-grey over white.
    const png = encodePng(1, 1, Uint8ClampedArray.of(0, 0, 0, 128));
    expect([...unzlibSync(chunks(png)[1]!.data)]).toEqual([0, 127]);
  });

  it('refuses a bitmap that does not match its size', () => {
    expect(() => encodePng(0, 1, new Uint8Array(4))).toThrow(/E_PNG/);
    expect(() => encodePng(2, 2, new Uint8Array(4))).toThrow(/E_PNG/);
  });
});

describe('page images in one zip', () => {
  it('holds one PNG per page, in page order, under Arabic names too', () => {
    const pages = [1, 2, 3].map((n) => encodePng(2, 2, bitmap(2, 2, () => [n * 40, n * 40, n * 40, 255])));
    const names = ['تقرير-1.png', 'تقرير-2.png', 'تقرير-3.png'];
    const zip = zipImages(names.map((name, i) => ({ name, bytes: pages[i]! })));
    const files = unzipSync(zip);
    expect(Object.keys(files)).toEqual(names);
    for (const [i, name] of names.entries()) {
      expect([...files[name]!.subarray(0, 8)], name).toEqual(SIGNATURE);
      expect(files[name], name).toEqual(pages[i]);
    }
  });
});
