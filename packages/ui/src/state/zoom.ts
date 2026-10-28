/** 100 % shows a page at its physical size on a 96 dpi screen (1 pt = 96/72 px). */
export const PT_TO_CSS_PX = 96 / 72;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
export const ZOOM_STEPS: readonly number[] = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
/** Space around the pages inside the scroll container, in CSS px. */
export const VIEWER_PADDING = 24;
export const PAGE_GAP = 16;
export const THUMBNAIL_SCALE = 0.2;

export type ZoomMode = 'custom' | 'fit-width' | 'fit-page';

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

const EPSILON = 0.001;

export function nextZoomStep(zoom: number): number {
  const next = ZOOM_STEPS.find((step) => step > zoom + EPSILON);
  return clampZoom(next ?? MAX_ZOOM);
}

export function previousZoomStep(zoom: number): number {
  const previous = [...ZOOM_STEPS].reverse().find((step) => step < zoom - EPSILON);
  return clampZoom(previous ?? MIN_ZOOM);
}

export interface Viewport {
  width: number;
  height: number;
}

export interface PageDimensions {
  width: number;
  height: number;
}

export function fitWidthZoom(viewport: Viewport, page: PageDimensions): number {
  const available = viewport.width - VIEWER_PADDING * 2;
  return clampZoom(available / (page.width * PT_TO_CSS_PX));
}

export function fitPageZoom(viewport: Viewport, page: PageDimensions): number {
  const availableHeight = viewport.height - VIEWER_PADDING * 2;
  const byHeight = availableHeight / (page.height * PT_TO_CSS_PX);
  return clampZoom(Math.min(fitWidthZoom(viewport, page), byHeight));
}

/**
 * Whether a newly fitted zoom is worth applying. A change under half a
 * percent is a scrollbar or a pixel of rounding, and chasing it can loop.
 */
export function fitMoved(before: number | null, after: number): boolean {
  return before === null || Math.abs(after - before) / before >= 0.005;
}

export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
