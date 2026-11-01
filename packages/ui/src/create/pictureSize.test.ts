import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeSignatureImage } from '../signatures/sign';
import { encodePng } from '../export/png';
import { decodeInBrowser } from './environment';
import { pictureSize, tooManyPixels } from './pictureSize';

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** A PNG header of any size, with nothing behind it. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii('IHDR')]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

const jpeg = (width: number, height: number) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc2, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0, 0xff, 0xd9]);

describe('a picture’s size, from its header alone', () => {
  it('reads PNG, JPEG (past other segments), GIF, BMP, WebP, TIFF and HEIC', () => {
    expect(pictureSize(encodePng(7, 3, new Uint8Array(84)))).toEqual({ width: 7, height: 3 });
    expect(pictureSize(pngHeader(65535, 65535))).toEqual({ width: 65535, height: 65535 });
    expect(pictureSize(jpeg(1200, 800))).toEqual({ width: 1200, height: 800 });
    expect(pictureSize(new Uint8Array([...ascii('GIF89a'), 0xff, 0xff, 0x10, 0x00, 0]))).toEqual({ width: 65535, height: 16 });
    const bmp = new Uint8Array(54);
    bmp.set(ascii('BM'));
    new DataView(bmp.buffer).setInt32(18, 640, true);
    new DataView(bmp.buffer).setInt32(22, -480, true);
    expect(pictureSize(bmp)).toEqual({ width: 640, height: 480 });
    const webp = new Uint8Array(30);
    webp.set([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBPVP8X')]);
    webp.set([0xff, 0xff, 0x00, 0xff, 0xff, 0x00], 24);
    expect(pictureSize(webp)).toEqual({ width: 65536, height: 65536 });
    const tiff = new Uint8Array(60);
    const t = new DataView(tiff.buffer);
    tiff.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
    t.setUint16(8, 2, true);
    t.setUint16(10, 256, true);
    t.setUint16(12, 4, true);
    t.setUint32(18, 70000, true);
    t.setUint16(22, 257, true);
    t.setUint16(24, 3, true);
    t.setUint16(30, 900, true);
    expect(pictureSize(tiff)).toEqual({ width: 70000, height: 900 });
    const heic = new Uint8Array(64);
    heic.set([0, 0, 0, 24, ...ascii('ftypheic')]);
    heic.set([0, 0, 0, 20, ...ascii('ispe'), 0, 0, 0, 0, 0, 0, 0x30, 0, 0, 0, 0x20, 0], 30);
    expect(pictureSize(heic)).toEqual({ width: 0x3000, height: 0x2000 });
  });

  it('says nothing of what it cannot read, and never throws on a cut header', () => {
    expect(pictureSize(new Uint8Array(0))).toBeNull();
    expect(pictureSize(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(pictureSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    for (let n = 0; n < 40; n += 1) expect(() => pictureSize(pngHeader(1, 1).slice(0, n))).not.toThrow();
    expect(tooManyPixels(pngHeader(65535, 65535))).toBe(true);
    expect(tooManyPixels(pngHeader(6000, 4000))).toBe(false);
  });
});

describe('decoding a picture the header says is enormous', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is never handed to the browser to decode', async () => {
    const decode = vi.fn(async () => {
      throw new Error('decoded');
    });
    vi.stubGlobal('createImageBitmap', decode);
    expect(await decodeInBrowser(pngHeader(65535, 65535), 'image/png')).toBeNull();
    await expect(decodeSignatureImage(new Blob([pngHeader(65535, 65535).slice().buffer as ArrayBuffer]))).rejects.toThrow(/E_IMAGE/);
    expect(decode).not.toHaveBeenCalled();
  });
});
