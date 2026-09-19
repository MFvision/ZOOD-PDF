import { loadEditFont } from '../edit/editFont';
import type { CreateEnvironment } from './createPdf';

/** The most pixels a picture the browser decodes may have: as for pictures the core reads. */
const MAX_PIXELS = 40_000_000;

/**
 * A picture only the browser can read — HEIC in Safari and the macOS app,
 * AVIF in most — drawn upright (its EXIF orientation applied) and made a
 * PNG, without loss. Null where the browser cannot draw it.
 */
export async function decodeInBrowser(bytes: Uint8Array, mime: string): Promise<Uint8Array | null> {
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: mime }), { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  try {
    if (bitmap.width * bitmap.height > MAX_PIXELS || bitmap.width === 0 || bitmap.height === 0) return null;
    if (typeof OffscreenCanvas === 'function') {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(bitmap, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      return new Uint8Array(await blob.arrayBuffer());
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

/**
 * The environment Create runs in inside the app: the core through its
 * client, and the faces that ship with Warraq (Amiri for Arabic and Latin,
 * Inter for what Amiri lacks), loaded from the app itself.
 */
export function appCreateEnvironment(client: Pick<CreateEnvironment, 'callStatic'>): CreateEnvironment {
  return {
    callStatic: (op, args, blobs) => client.callStatic(op, args, blobs),
    fonts: async () => {
      const [amiri, inter] = await Promise.all([loadEditFont('amiri'), loadEditFont('inter')]);
      return [
        { name: 'Amiri', bytes: amiri.slice().buffer as ArrayBuffer },
        { name: 'Inter', bytes: inter.slice().buffer as ArrayBuffer },
      ];
    },
    decodePicture: decodeInBrowser,
  };
}
