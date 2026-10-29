import { useCallback, useRef } from 'react';

/**
 * Real liquid glass: what is behind a floating piece bends near its edge, as through a thick
 * lens, instead of only blurring. Only Chromium can bend the live backdrop (an SVG displacement
 * filter in `backdrop-filter`), which is the Windows app's engine (WebView2); everywhere else the
 * piece keeps its blur, and the rim and corner light in liquidGlass.css give the rest of the look.
 *
 * The map is drawn per size from the shape's rounded-rectangle distance field: zero (no shift)
 * in the middle, and near the edge a push toward the centre that grows smoothly to the rim.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The bend at the rim, in pixels: enough to see, small enough that text behind stays whole. */
const SHIFT = 18;
const made = new Map<string, string>();

/** Chromium only: WebKit (the Mac app) parses the filter but draws nothing behind it. */
export function canRefract(): boolean {
  if (typeof navigator === 'undefined' || typeof CSS === 'undefined') return false;
  return /Chrome\//.test(navigator.userAgent) && CSS.supports('backdrop-filter', 'url(#a) blur(1px)');
}

/** Glass is off in the flat looks and when the person asked for less transparency. */
function glassAllowed(): boolean {
  const root = document.documentElement;
  if (root.dataset.reduceTransparency === 'on') return false;
  if (root.dataset.look === 'workbench' || root.dataset.look === 'mono') return false;
  return !globalThis.matchMedia?.('(prefers-reduced-transparency: reduce)').matches;
}

/** The displacement map for a w×h rounded rectangle of radius r, as a PNG data URL. */
export function lensMap(w: number, h: number, r: number): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const image = context.createImageData(w, h);
  const bezel = Math.min(28, h * 0.36, w * 0.36);
  const sdf = (x: number, y: number) => {
    const qx = Math.abs(x - w / 2) - (w / 2 - r);
    const qy = Math.abs(y - h / 2) - (h / 2 - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const depth = -sdf(x + 0.5, y + 0.5);
      let dx = 0;
      let dy = 0;
      if (depth > 0 && depth < bezel) {
        const nx = sdf(x + 1.5, y + 0.5) - sdf(x - 0.5, y + 0.5);
        const ny = sdf(x + 0.5, y + 1.5) - sdf(x + 0.5, y - 0.5);
        const length = Math.hypot(nx, ny) || 1;
        const t = 1 - depth / bezel;
        const m = t * t * (3 - 2 * t);
        dx = (-nx / length) * m;
        dy = (-ny / length) * m;
      }
      const at = (y * w + x) * 4;
      image.data[at] = 128 + dx * 127;
      image.data[at + 1] = 128 + dy * 127;
      image.data[at + 2] = 128;
      image.data[at + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

/** The filter for one size, made once and kept in a hidden <svg> at the end of <body>. */
function filterFor(w: number, h: number, r: number): string | null {
  const key = `${w}x${h}x${r}`;
  const known = made.get(key);
  if (known) return known;
  const map = lensMap(w, h, r);
  if (!map) return null;
  let holder = document.getElementById('zood-glass-filters');
  if (!holder) {
    holder = document.createElementNS(SVG_NS, 'svg') as unknown as HTMLElement;
    holder.id = 'zood-glass-filters';
    holder.setAttribute('aria-hidden', 'true');
    holder.setAttribute('width', '0');
    holder.setAttribute('height', '0');
    holder.style.position = 'absolute';
    document.body.appendChild(holder);
  }
  const id = `zood-glass-${key}`;
  const filter = document.createElementNS(SVG_NS, 'filter');
  filter.id = id;
  for (const [name, value] of [['x', '0'], ['y', '0'], ['width', '1'], ['height', '1'], ['primitiveUnits', 'objectBoundingBox'], ['color-interpolation-filters', 'sRGB']]) {
    filter.setAttribute(name!, value!);
  }
  const image = document.createElementNS(SVG_NS, 'feImage');
  for (const [name, value] of [['x', '0'], ['y', '0'], ['width', '1'], ['height', '1'], ['preserveAspectRatio', 'none'], ['result', 'map'], ['href', map]]) {
    image.setAttribute(name!, value!);
  }
  const displace = document.createElementNS(SVG_NS, 'feDisplacementMap');
  // In bounding-box units the scale is a share of the width.
  for (const [name, value] of [['in', 'SourceGraphic'], ['in2', 'map'], ['scale', ((SHIFT * 2) / w).toFixed(4)], ['xChannelSelector', 'R'], ['yChannelSelector', 'G']]) {
    displace.setAttribute(name!, value!);
  }
  filter.append(image, displace);
  holder.appendChild(filter);
  made.set(key, id);
  return id;
}

/** Bends the backdrop behind `element` while it is on screen; returns the clean-up. */
export function refract(element: HTMLElement): () => void {
  if (!canRefract()) return () => undefined;
  const apply = () => {
    const w = Math.round(element.offsetWidth);
    const h = Math.round(element.offsetHeight);
    if (!glassAllowed() || w < 24 || h < 24 || w > 1200 || h > 600) {
      delete element.dataset.refract;
      return;
    }
    const radius = Math.min(parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0, h / 2, w / 2);
    const id = filterFor(w, h, Math.round(radius));
    if (!id) return;
    element.style.setProperty('--glass-refract', `url(#${id})`);
    element.dataset.refract = '';
  };
  apply();
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
  observer?.observe(element);
  return () => observer?.disconnect();
}

/** A ref for a floating piece that should be real glass. */
export function useLiquidGlass<T extends HTMLElement>(): (element: T | null) => void {
  const stop = useRef<(() => void) | null>(null);
  return useCallback((element: T | null) => {
    stop.current?.();
    stop.current = element ? refract(element) : null;
  }, []);
}
