/// <reference lib="webworker" />
/**
 * Preprocessing worker (ADR 0016): decodes an image (after checking its header against the size
 * caps), optionally corrects perspective, then flattens shadows, measures and removes skew,
 * binarises and despeckles. Produces the image the recogniser reads (binary PGM), the image a new
 * scan page embeds, and a small preview.
 */
import { checkSize, downscale, imageSize, preprocess, toGray, toPgm, toRgba, warpPerspective, type Gray } from './preprocess';
import type { InfoRequest, PrepRequest, PrepResponse, PrepResult } from './prep-client';

declare const self: DedicatedWorkerGlobalScope;

/** Recognition works best around 300 dpi; very large photos are reduced first. */
const OCR_MAX_PIXELS = 24_000_000;

async function decode(bytes: Uint8Array): Promise<Gray> {
  const head = imageSize(bytes);
  if (!head) throw { code: 'unsupported_image', message: 'unsupported image type' };
  try {
    checkSize(head.width, head.height);
  } catch {
    throw { code: 'image_too_large', message: `${head.width}×${head.height}` };
  }
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
  try {
    checkSize(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d context');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return toGray(img.data, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

async function encode(g: Gray, type: 'image/png' | 'image/jpeg', maxSide?: number): Promise<Uint8Array> {
  let src = g;
  if (maxSide && Math.max(g.width, g.height) > maxSide) src = downscale(g, Math.ceil(Math.max(g.width, g.height) / maxSide));
  const canvas = new OffscreenCanvas(src.width, src.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.putImageData(new ImageData(toRgba(src) as Uint8ClampedArray<ArrayBuffer>, src.width, src.height), 0, 0);
  const blob = await canvas.convertToBlob(type === 'image/jpeg' ? { type, quality: 0.85 } : { type });
  return new Uint8Array(await blob.arrayBuffer());
}

async function run(req: PrepRequest): Promise<PrepResult> {
  let src = await decode(req.image);
  if (req.quad) src = warpPerspective(src, req.quad);
  const factor = Math.ceil(Math.sqrt((src.width * src.height) / OCR_MAX_PIXELS));
  if (factor > 1) src = downscale(src, factor);
  const dpi = req.dpi ?? Math.min(600, Math.max(100, Math.round(src.width / 8.27)));
  const o = req.options;
  // The recogniser always reads a straightened, cleaned page (best accuracy) …
  const ocr = preprocess(src, { dpi, deskew: true, flatten: o.flatten, binarise: true, despeckle: o.despeckle });
  const res: PrepResult = {
    width: src.width,
    height: src.height,
    dpi,
    angle: ocr.angle,
    ocrRotation: ocr.deskewed ? ocr.angle : 0,
    pgm: toPgm(ocr.image),
  };
  // … while a new scan page keeps what the user chose.
  if (req.page) {
    let page: Gray;
    let rotation = 0;
    if (o.deskew && o.clean) {
      page = ocr.image;
      rotation = res.ocrRotation;
    } else {
      const kept = preprocess(src, { dpi, deskew: o.deskew, flatten: o.flatten, binarise: o.clean, despeckle: o.clean && o.despeckle });
      page = kept.image;
      rotation = kept.deskewed ? kept.angle : 0;
    }
    res.pageRotation = rotation;
    if (o.clean) {
      res.pageImage = { format: 'gray', data: page.data, width: page.width, height: page.height };
    } else {
      res.pageImage = { format: 'jpeg', data: await encode(page, 'image/jpeg'), width: page.width, height: page.height };
    }
  }
  if (req.preview) {
    const shown = req.page && res.pageImage?.format === 'gray' ? { width: res.pageImage.width, height: res.pageImage.height, data: res.pageImage.data } : o.clean ? ocr.image : src;
    res.preview = await encode(shown, 'image/png', req.preview);
  }
  return res;
}

async function info(image: Uint8Array, maxSide: number) {
  const g = await decode(image);
  return { width: g.width, height: g.height, preview: await encode(g, 'image/jpeg', maxSide) };
}

self.onmessage = async (ev: MessageEvent<PrepRequest | InfoRequest>) => {
  const req = ev.data;
  let res: PrepResponse;
  try {
    if (req.kind === 'info') {
      const r = await info(req.image, req.maxSide);
      res = { id: req.id, ok: true, info: r };
    } else {
      res = { id: req.id, ok: true, result: await run(req) };
    }
  } catch (e) {
    const o = (e ?? {}) as { code?: string; message?: string };
    res = { id: req.id, ok: false, error: { code: o.code ?? (e instanceof Error && e.name === 'ImageTooLargeError' ? 'image_too_large' : 'preprocess_failed'), message: o.message ?? String(e) } };
  }
  const transfer: Transferable[] = [];
  if (res.ok && res.result) {
    transfer.push(res.result.pgm.buffer as ArrayBuffer);
    if (res.result.pageImage) transfer.push(res.result.pageImage.data.buffer as ArrayBuffer);
    if (res.result.preview) transfer.push(res.result.preview.buffer as ArrayBuffer);
  }
  self.postMessage(res, transfer);
};
