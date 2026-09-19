import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { useT } from '../i18n/useT';
import { useAppState, useServices } from '../state/AppContext';
import { drawRgba } from '../viewer/useRenderedCanvas';

/** A rectangle on a page as it is shown, in points from its top-left corner. */
export type ShownRect = [number, number, number, number];

/** Width of the page picture, in CSS pixels. */
const PREVIEW = 260;

/** Where a signature goes until the person draws somewhere else: the page's bottom corner at the end of the reading direction. */
export function defaultRect(size: readonly [number, number], rtl: boolean): ShownRect {
  const [w, h] = size;
  const bw = Math.min(210, w * 0.45);
  const bh = Math.min(70, h * 0.12);
  const margin = Math.min(36, w * 0.06);
  const x0 = rtl ? margin : w - margin - bw;
  const y0 = h - margin - bh;
  return [x0, y0, x0 + bw, y0 + bh];
}

/**
 * The page, small, to draw where a visible signature goes: press, drag,
 * release. The rectangle is kept in points as the page is shown, which is
 * what the core takes (`signatures.sign`, `rect`) and turns into the page's
 * own space, rotation included.
 */
export function RectPicker({ page, rect, onRect }: { page: number; rect: ShownRect; onRect: (rect: ShownRect) => void }) {
  const t = useT();
  const services = useServices();
  const state = useAppState();
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const size = state.document?.pageSizes[page] ?? [595, 842];
  const scale = PREVIEW / size[0];
  const document = services.document;

  useEffect(() => {
    const target = canvas.current;
    if (!target || !document) return;
    let cancelled = false;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    document
      .render_page(page, scale * dpr)
      .then((rendered) => {
        if (!cancelled) drawRgba(target, rendered);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [document, page, scale]);

  const at = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX - box.left, 0), box.width) / scale;
    const y = Math.min(Math.max(event.clientY - box.top, 0), box.height) / scale;
    return { x, y };
  };

  return (
    <div className="rect-picker">
      <div
        className="rect-picker-page"
        style={{ inlineSize: PREVIEW, blockSize: size[1] * scale }}
        dir="ltr"
        role="img"
        aria-label={t('signatures.sign.drawHint')}
        data-testid="signature-page"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setDrag(at(event));
        }}
        onPointerMove={(event) => {
          if (!drag) return;
          const p = at(event);
          onRect([Math.min(drag.x, p.x), Math.min(drag.y, p.y), Math.max(drag.x, p.x), Math.max(drag.y, p.y)]);
        }}
        onPointerUp={(event) => {
          if (!drag) return;
          const p = at(event);
          const next: ShownRect = [Math.min(drag.x, p.x), Math.min(drag.y, p.y), Math.max(drag.x, p.x), Math.max(drag.y, p.y)];
          // A click, not a drag: keep what was there.
          if (next[2] - next[0] >= 20 && next[3] - next[1] >= 12) onRect(next);
          setDrag(null);
        }}
      >
        <canvas ref={canvas} className="rect-picker-canvas" />
        <div
          className="rect-picker-box"
          data-testid="signature-box"
          style={{
            insetInlineStart: rect[0] * scale,
            insetBlockStart: rect[1] * scale,
            inlineSize: (rect[2] - rect[0]) * scale,
            blockSize: (rect[3] - rect[1]) * scale,
          }}
        />
      </div>
      <p className="tool-panel-note">{t('signatures.sign.drawHint')}</p>
    </div>
  );
}
