import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { useT } from '../i18n/useT';
import { useAppState, useServices } from '../state/AppContext';
import { drawRgba } from '../viewer/useRenderedCanvas';
import { dragRect } from './rect';
import type { ShownRect } from './rect';

/** Widest the page picture is drawn, in CSS pixels; a narrower inspector draws it narrower. */
const PREVIEW = 260;

/**
 * The page, small, to draw where a visible signature goes: press, drag,
 * release. The rectangle is kept in points as the page is shown, which is
 * what the core takes (`signatures.sign`, `rect`) and turns into the page's
 * own space, rotation included. The scale is the picture's width as laid out
 * (the inspector can be narrower than `PREVIEW`), so what is drawn over the
 * picture is where the signature goes.
 */
export function RectPicker({ page, rect, onRect }: { page: number; rect: ShownRect; onRect: (rect: ShownRect) => void }) {
  const t = useT();
  const services = useServices();
  const state = useAppState();
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(PREVIEW);
  // Where the press was, and the rectangle before it: a click puts it back.
  const [drag, setDrag] = useState<{ x: number; y: number; before: ShownRect } | null>(null);
  const size = state.document?.pageSizes[page] ?? [595, 842];
  const scale = width / size[0];
  const document = services.document;

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      const laid = element.getBoundingClientRect().width;
      if (laid > 0) setWidth(Math.min(PREVIEW, laid));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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

  // In points, from the picture as it is laid out now.
  const at = (event: PointerEvent<HTMLDivElement>) => {
    const laid = event.currentTarget.getBoundingClientRect();
    const k = laid.width > 0 ? laid.width / size[0] : scale;
    const x = Math.min(Math.max(event.clientX - laid.left, 0), laid.width) / k;
    const y = Math.min(Math.max(event.clientY - laid.top, 0), laid.height) / k;
    return { x, y };
  };

  const end = (next: ShownRect | null) => {
    if (drag) onRect(next ?? drag.before);
    setDrag(null);
  };

  return (
    <div className="rect-picker">
      <div
        ref={box}
        className="rect-picker-page"
        style={{ inlineSize: PREVIEW, blockSize: size[1] * scale }}
        dir="ltr"
        role="img"
        aria-label={t('signatures.sign.drawHint')}
        data-testid="signature-page"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setDrag({ ...at(event), before: rect });
        }}
        onPointerMove={(event) => {
          if (!drag) return;
          // The box follows the drag once it is one; until then, what was there.
          onRect(dragRect(drag, at(event)) ?? drag.before);
        }}
        onPointerUp={(event) => end(drag && dragRect(drag, at(event)))}
        onPointerCancel={() => end(null)}
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
