import { invokeHost } from '../core/host-tauri';
import { startRecognizer } from '../ocr/engine';
import type { Recognizer, ReadWord } from '../ocr/engine';

/**
 * The words of the window the person tapped in, for a model that reads
 * text only: the host's picture of it (`ask_window_png`), read by the same
 * Tesseract the Scan & OCR tool uses, Arabic and English, in the island.
 * The recogniser is kept between taps: starting it is the slow part.
 */

let recognizer: Promise<Recognizer> | null = null;

function ready(): Promise<Recognizer> {
  recognizer ??= startRecognizer(['ara', 'eng']).catch((error: unknown) => {
    recognizer = null;
    throw error;
  });
  return recognizer;
}

/** Starts the recogniser ahead of the first tap's picture. */
export function warmUp(): void {
  void ready().catch(() => undefined);
}

/** Words as lines: a new line where a word starts below the one before. */
export function wordsToText(words: readonly ReadWord[]): string {
  let text = '';
  let last: ReadWord | null = null;
  for (const word of words) {
    if (word.confidence < 30 && word.text.trim().length < 3) continue;
    if (last) {
      const lineHeight = Math.max(1, last.bbox[3] - last.bbox[1]);
      const below = word.bbox[1] > last.bbox[1] + lineHeight * 0.6;
      if (below) text = `${text.trimEnd()}\n`;
      else if (!/\s$/.test(text)) text += ' ';
    }
    text += word.text;
    last = word;
  }
  return text.trim();
}

async function canvasOf(png: ArrayBuffer): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

/** The tapped window's words, or '' when there was no picture to read. */
export async function readWindow(): Promise<string> {
  const body = await invokeHost('ask_window_png').catch(() => null);
  if (!(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) return '';
  const bytes =
    body instanceof ArrayBuffer
      ? body
      : (body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer);
  const [reader, canvas] = await Promise.all([ready(), canvasOf(bytes)]);
  return wordsToText(await reader.read(canvas));
}
