import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { RemoteDocument } from '../core/client';

/**
 * One page, drawn by Warraq's core at the width the panel gives it, with
 * whatever the caller lays over it in page points (an SVG whose viewBox is
 * the page). Drawn again only when the page or the width changes.
 */
export function PagePicture({
  doc,
  page,
  width,
  height,
  label,
  children,
}: {
  doc: RemoteDocument | null;
  page: number;
  /** The page's size in points, for the overlay and the aspect ratio. */
  width: number;
  height: number;
  label: string;
  children?: ReactNode;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const [shownWidth, setShownWidth] = useState(0);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setShownWidth(Math.round(element.clientWidth)));
    observer.observe(element);
    setShownWidth(Math.round(element.clientWidth));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!doc || shownWidth === 0 || width <= 0) return;
    let cancelled = false;
    const scale = Math.min(3, (shownWidth * (globalThis.devicePixelRatio || 1)) / width);
    void doc
      .render_page(page, scale)
      .then((rendered) => {
        const element = canvas.current;
        if (cancelled || !element) return;
        element.width = rendered.width;
        element.height = rendered.height;
        element
          .getContext('2d')
          ?.putImageData(new ImageData(new Uint8ClampedArray(rendered.rgba), rendered.width, rendered.height), 0, 0);
      })
      .catch(() => {
        /* the overlay still shows where things are */
      });
    return () => {
      cancelled = true;
    };
  }, [doc, page, shownWidth, width]);

  return (
    <div ref={box} className="page-picture" style={{ aspectRatio: `${width} / ${height}` }}>
      <canvas ref={canvas} role="img" aria-label={label} />
      {children}
    </div>
  );
}
