import type { RenderedPageData } from '../core/types';
import { uprightIn } from '../edit/matrix';
import type { Matrix } from '../edit/matrix';
import type { PagePoint } from './protocol';
import type { Stroke } from './store';

/** A drawn page as a JPEG data URL, for the phone. */
export function jpegUrl(page: RenderedPageData, quality = 0.78): string {
  const canvas = document.createElement('canvas');
  canvas.width = page.width;
  canvas.height = page.height;
  const context = canvas.getContext('2d');
  if (!context) return '';
  context.putImageData(new ImageData(page.rgba, page.width, page.height), 0, 0);
  return canvas.toDataURL('image/jpeg', quality);
}

/** How a stroke is drawn: the pen thin and solid, the marker wide and see-through. */
export const INK_STYLE = {
  pen: { color: '#c0392b', width: 0.0045, opacity: 1 },
  marker: { color: '#f2c94c', width: 0.022, opacity: 0.45 },
} as const;

/** A stroke as an SVG path over a page `width` × `height` units. */
export function strokePath(points: readonly PagePoint[], width: number, height: number): string {
  if (points.length === 0) return '';
  const [first, ...rest] = points;
  const at = (p: PagePoint) => `${(p[0] * width).toFixed(2)} ${(p[1] * height).toFixed(2)}`;
  if (rest.length === 0) return `M ${at(first!)} l 0.01 0`;
  return `M ${at(first!)} ${rest.map((p) => `L ${at(p)}`).join(' ')}`;
}

/**
 * The strokes as a picture to put in the file (Keep): a PNG with a clear
 * background, the page's size in points times `scale`.
 */
export async function inkPng(strokes: readonly Stroke[], pageWidth: number, pageHeight: number, scale = 2): Promise<Uint8Array<ArrayBuffer> | null> {
  if (strokes.length === 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(pageWidth * scale));
  canvas.height = Math.max(1, Math.round(pageHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const stroke of strokes) {
    const style = INK_STYLE[stroke.tool];
    context.globalAlpha = style.opacity;
    context.strokeStyle = style.color;
    context.lineWidth = style.width * canvas.width;
    context.beginPath();
    stroke.points.forEach(([x, y], i) => {
      const px = x * canvas.width;
      const py = y * canvas.height;
      if (i === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    });
    if (stroke.points.length === 1) context.lineTo(stroke.points[0]![0] * canvas.width + 0.5, stroke.points[0]![1] * canvas.height);
    context.stroke();
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/** Where a picture lands for `images.add`: the box `at` × `size`, fractions of a page `width` × `height` points, upright. */
export function placement(at: PagePoint, size: readonly [number, number], width: number, height: number): Matrix {
  return uprightIn({ x: at[0] * width, y: at[1] * height, width: size[0] * width, height: size[1] * height });
}
