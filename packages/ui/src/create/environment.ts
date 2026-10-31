import { loadEditFont } from '../edit/editFont';
import { invokeHost, isTauriHost } from '../core/host-tauri';
import type { CreateEnvironment } from './createPdf';
import { MAX_DECODED_PIXELS, tooManyPixels } from './pictureSize';

/** The most pixels a picture the browser decodes may have: as for pictures the core reads. */
const MAX_PIXELS = MAX_DECODED_PIXELS;

/**
 * A picture only the browser can read — HEIC in Safari and the macOS app,
 * AVIF in most — drawn upright (its EXIF orientation applied) and made a
 * PNG, without loss. Null where the browser cannot draw it.
 */
export async function decodeInBrowser(bytes: Uint8Array, mime: string): Promise<Uint8Array | null> {
  if (typeof createImageBitmap !== 'function') return null;
  // Asked of the header before the browser decodes it all: a few kilobytes
  // saying 65,535 × 65,535 would otherwise take gigabytes, and the tab.
  if (tooManyPixels(bytes, MAX_PIXELS)) return null;
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

/** Signs no text face has (☐ ☑ ✓ ➢ ✉), from Noto Sans Symbols 2 (OFL), cut to those blocks. */
const SYMBOLS_URL = new URL('../../public/fonts/NotoSansSymbols2-Subset.ttf', import.meta.url).href;
let symbols: Promise<Uint8Array> | null = null;
function loadSymbols(): Promise<Uint8Array> {
  symbols ??= fetch(SYMBOLS_URL)
    .then((response) => {
      if (!response.ok) throw new Error(`E_NOT_FOUND: symbols (${response.status})`);
      return response.arrayBuffer();
    })
    .then((buffer) => new Uint8Array(buffer))
    .catch((err: unknown) => {
      symbols = null;
      throw err;
    });
  return symbols;
}

/** An installed face of `family` with `text`'s letters, from the desktop host (`fonts.rs`). */
async function installedFont(family: string, text: string): Promise<ArrayBuffer | null> {
  const body = (await invokeHost('font_installed', { family, weight: 400, italic: false, text })) as ArrayBuffer;
  if (!(body instanceof ArrayBuffer) || body.byteLength === 0) return null;
  return body.slice(0);
}

/**
 * The environment Create runs in inside the app: the core through its
 * client; the faces that ship with Warraq (Amiri, a book face, for Arabic
 * and Latin; Cairo, a sans with both; Inter for Latin; the symbols), loaded
 * from the app itself; and, in the desktop app, the fonts installed on the
 * computer, so a document is set in the fonts it names.
 */
export function appCreateEnvironment(client: Pick<CreateEnvironment, 'callStatic'>): CreateEnvironment {
  return {
    callStatic: (op, args, blobs) => client.callStatic(op, args, blobs),
    fonts: async () => {
      const [amiri, cairo, inter, signs] = await Promise.all([
        loadEditFont('amiri'),
        loadEditFont('cairo'),
        loadEditFont('inter'),
        loadSymbols().catch(() => null),
      ]);
      return [
        { name: 'Amiri', bytes: amiri.slice().buffer as ArrayBuffer },
        { name: 'Cairo', bytes: cairo.slice().buffer as ArrayBuffer },
        { name: 'Inter', bytes: inter.slice().buffer as ArrayBuffer },
        ...(signs ? [{ name: 'NotoSansSymbols2', bytes: signs.slice().buffer as ArrayBuffer }] : []),
      ];
    },
    ...(isTauriHost() ? { installedFont } : {}),
    decodePicture: decodeInBrowser,
  };
}
