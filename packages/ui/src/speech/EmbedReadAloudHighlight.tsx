import { useEffect, useState } from 'react';
import type { PluginRegistry } from '@embedpdf/react-pdf-viewer';
import { capability } from '../embed/embedControl';
import type { PageBox } from '../embed/embedControl';
import { useReadAloud } from './readAloud';

/**
 * The sentence being read, marked over EmbedPDF's page. EmbedPDF says
 * where a page rectangle lies in its scrolled content (the scroll
 * plugin's `getRectPositionForPage`) and how far that content is scrolled
 * (the viewport plugin); the marks are drawn over the viewer's host, in the
 * app's own document, and moved with every scroll and zoom. Nothing is
 * added to EmbedPDF's own state.
 */

interface Rect {
  origin: { x: number; y: number };
  size: { width: number; height: number };
}

interface Scroll {
  getRectPositionForPage(page: number, rect: Rect): Rect | null;
  onScroll(listener: (event: unknown) => void): () => void;
  onLayoutChange(listener: (event: unknown) => void): () => void;
}

interface Viewport {
  getMetrics(): { scrollTop: number; scrollLeft: number; scrollHeight: number };
  onScrollChange(listener: (event: unknown) => void): () => void;
  onViewportChange(listener: (event: unknown) => void): () => void;
}

interface Placed {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The element inside EmbedPDF that scrolls the pages: the one whose scroll
 * height is what the viewport plugin reports. Its box is where the marks'
 * coordinates start. When the page fits the window there is nothing to
 * scroll, and the largest element that is set to scroll stands in.
 */
function scroller(host: HTMLElement, viewport: Viewport): HTMLElement | null {
  const root = host.querySelector('embedpdf-container')?.shadowRoot;
  if (!root) return null;
  const { scrollHeight } = viewport.getMetrics();
  const area = (element: HTMLElement) => element.clientWidth * element.clientHeight;
  let best: HTMLElement | null = null;
  let fallback: HTMLElement | null = null;
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    if (element.scrollHeight === scrollHeight && element.clientHeight < element.scrollHeight) {
      if (!best || area(element) > area(best)) best = element;
    } else if (/auto|scroll/.test(getComputedStyle(element).overflowY)) {
      if (!fallback || area(element) > area(fallback)) fallback = element;
    }
  }
  return best ?? fallback;
}

function placeBoxes(host: HTMLElement, registry: PluginRegistry, page: number, boxes: readonly PageBox[]): Placed[] {
  const scroll = capability<Scroll>(registry, 'scroll');
  const viewport = capability<Viewport>(registry, 'viewport');
  if (!scroll || !viewport) return [];
  const element = scroller(host, viewport);
  if (!element) return [];
  const { scrollTop, scrollLeft } = viewport.getMetrics();
  const hostBox = host.getBoundingClientRect();
  const scrollBox = element.getBoundingClientRect();
  const placed: Placed[] = [];
  for (const box of boxes) {
    // Both count pages from zero (EmbedPDF 2.x adds the one itself).
    const at = scroll.getRectPositionForPage(page, { origin: { x: box.x, y: box.y }, size: { width: box.width, height: box.height } });
    if (!at) continue;
    placed.push({
      left: scrollBox.left - hostBox.left + at.origin.x - scrollLeft,
      top: scrollBox.top - hostBox.top + at.origin.y - scrollTop,
      width: at.size.width,
      height: at.size.height,
    });
  }
  return placed;
}

export function EmbedReadAloudHighlight({ host, registry }: { host: HTMLElement | null; registry: PluginRegistry | null }) {
  const { boxes, active } = useReadAloud();
  const [placed, setPlaced] = useState<Placed[]>([]);

  useEffect(() => {
    if (!active || !boxes || !host || !registry) return;
    const update = () => setPlaced(placeBoxes(host, registry, boxes.page, boxes.rects));
    // Placed once the frame is laid out, and again a beat later: EmbedPDF
    // lays a page out after it scrolls to it.
    const frame = requestAnimationFrame(update);
    const timer = setTimeout(update, 300);
    const scroll = capability<Scroll>(registry, 'scroll');
    const viewport = capability<Viewport>(registry, 'viewport');
    const stops = [
      scroll?.onScroll(update),
      scroll?.onLayoutChange(update),
      viewport?.onScrollChange(update),
      viewport?.onViewportChange(update),
    ];
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      for (const stop of stops) stop?.();
    };
  }, [active, boxes, host, registry]);

  if (!active || placed.length === 0 || !boxes) return null;
  return (
    <div className="read-aloud-embed" aria-hidden="true" data-read-aloud-page={boxes.page + 1}>
      {placed.map((rect, i) => (
        <span key={i} style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />
      ))}
    </div>
  );
}
