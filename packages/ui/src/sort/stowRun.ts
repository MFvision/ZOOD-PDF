import type { CoreClient } from '../core/client';
import { pickFolder, readBatchFile, writeBatchResult } from '../core/host-tauri';
import type { FileState } from '../batch/run';
import type { Lang, TKey, TParams } from '../i18n/messages';
import { findQuickTool, startingOptions } from '../quick/plan';
import { outputFor } from '../quick/output';
import { runQuick } from '../quick/runQuick';
import type { QuickFile } from '../quick/runQuick';
import { getSettings } from '../state/settings';
import { extensionFor, fitWithin } from './stow';
import type { Make } from './stow';

/**
 * Runs a tile or a format of the drop zone (`stow.ts`) on the files it
 * takes: a picture is redrawn here (smaller, in another format), anything
 * else goes through its quick tool. What it makes is written where
 * Settings › Quick tools says (beside the originals by default), never over
 * a file; the originals are never touched.
 */

export interface StowRun {
  make: Make;
  files: readonly QuickFile[];
  client: CoreClient;
  lang: Lang;
  t: (key: TKey, params?: TParams) => string;
  onProgress: (done: number) => void;
}

export interface StowResult {
  made: string[];
  failed: number;
}

/** Can this page write WebP pictures? (Chromium can; Safari writes PNG instead.) */
export function canWriteWebp(): boolean {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    return canvas.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    return false;
  }
}

/** The biggest picture redrawn here, in pixels, so a huge one cannot eat the memory. */
const MOST_PIXELS = 80_000_000;

export async function redraw(bytes: Uint8Array, format: 'jpeg' | 'png' | 'webp', maxSide?: number, quality?: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
  try {
    if (bitmap.width * bitmap.height > MOST_PIXELS) throw new Error('E_TOO_BIG: the picture is too big');
    const size = fitWithin(bitmap.width, bitmap.height, maxSide);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const pen = canvas.getContext('2d');
    if (!pen) throw new Error('E_DRAW: no canvas');
    if (format === 'jpeg') {
      // JPEG has no see-through: white behind, as a print would be.
      pen.fillStyle = '#fff';
      pen.fillRect(0, 0, size.width, size.height);
    }
    pen.imageSmoothingQuality = 'high';
    pen.drawImage(bitmap, 0, 0, size.width, size.height);
    const type = `image/${format}`;
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, type, quality));
    if (!blob || blob.type !== type) throw new Error(`E_FORMAT: cannot write ${format}`);
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

export async function runStow(run: StowRun): Promise<StowResult> {
  const { make, files, t, onProgress } = run;
  const made: string[] = [];
  let failed = 0;
  if (make.kind === 'picture') {
    const out = await outputFor(getSettings(), () => pickFolder(false));
    if (!out) return { made, failed: files.length };
    const suffix = make.suffix ? t(`quick.suffix.${make.suffix}` as TKey) : '';
    for (const [done, file] of files.entries()) {
      try {
        const bytes = await redraw(new Uint8Array(await readBatchFile(file.path)), make.format, make.maxSide, make.quality);
        made.push(await writeBatchResult(bytes, out.name(file.name, suffix, extensionFor(make.format)), out.target(file.path)));
      } catch {
        failed += 1;
      }
      onProgress(done + 1);
    }
    return { made, failed };
  }
  const tool = findQuickTool(make.tool);
  if (!tool) return { made, failed: files.length };
  const states = new Map<number, FileState>();
  await runQuick({
    tool,
    files,
    options: startingOptions(tool),
    onePdf: make.onePdf === true,
    client: run.client,
    lang: run.lang,
    t,
    signal: new AbortController().signal,
    onState: (key, state) => {
      states.set(key, state);
      onProgress([...states.values()].filter((s) => s.state === 'done' || s.state === 'failed' || s.state === 'cancelled').length);
    },
    onOutput: (_, path) => made.push(path),
  }).catch(() => undefined);
  failed = [...states.values()].filter((s) => s.state === 'failed').length;
  if (made.length === 0 && failed === 0) failed = files.length;
  return { made, failed };
}
