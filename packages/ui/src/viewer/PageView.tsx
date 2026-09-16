import { useEffect, useRef, useState } from 'react';
import type { RemoteDocument } from '../core/client';
import type { PageSize } from '../core/types';
import { useT } from '../i18n/useT';
import { PT_TO_CSS_PX } from '../state/zoom';
import { TextOverlay } from './TextOverlay';
import { useRenderedCanvas } from './useRenderedCanvas';
import type { SharedObserver } from './useSharedObserver';

interface PageViewProps {
  document: RemoteDocument;
  index: number;
  size: PageSize;
  zoom: number;
  dpr: number;
  near: SharedObserver;
  visible: SharedObserver;
  onVisibility: (index: number, ratio: number) => void;
}

/** One page: a DPR-sized canvas plus the selectable text layer, rendered only near the viewport. */
export function PageView({ document, index, size, zoom, dpr, near, visible, onVisibility }: PageViewProps) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isNear, setNear] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const stopNear = near.observe(element, (entry) => setNear(entry.isIntersecting));
    const stopVisible = visible.observe(element, (entry) =>
      onVisibility(index, entry.isIntersecting ? entry.intersectionRatio : 0),
    );
    return () => {
      stopNear();
      stopVisible();
      onVisibility(index, 0);
    };
  }, [near, visible, index, onVisibility]);

  const cssScale = PT_TO_CSS_PX * zoom;
  useRenderedCanvas(canvasRef, document, index, cssScale * dpr, isNear, true);

  return (
    <section
      ref={ref}
      className="page"
      data-page={index + 1}
      aria-label={t('viewer.page', { page: index + 1 })}
      style={{ inlineSize: size[0] * cssScale, blockSize: size[1] * cssScale }}
    >
      <canvas ref={canvasRef} className="page-canvas" />
      {isNear && <TextOverlay document={document} index={index} scale={cssScale} />}
    </section>
  );
}
