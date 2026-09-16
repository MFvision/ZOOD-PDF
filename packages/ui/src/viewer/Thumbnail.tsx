import { useEffect, useRef, useState } from 'react';
import type { RemoteDocument } from '../core/client';
import type { PageSize } from '../core/types';
import { useT } from '../i18n/useT';
import { THUMBNAIL_SCALE } from '../state/zoom';
import { useRenderedCanvas } from './useRenderedCanvas';
import type { SharedObserver } from './useSharedObserver';

interface ThumbnailProps {
  document: RemoteDocument;
  index: number;
  size: PageSize;
  dpr: number;
  current: boolean;
  observer: SharedObserver;
  onSelect: () => void;
}

export function Thumbnail({ document, index, size, dpr, current, observer, onSelect }: ThumbnailProps) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isNear, setNear] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return observer.observe(element, (entry) => setNear(entry.isIntersecting));
  }, [observer]);

  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  useRenderedCanvas(canvasRef, document, index, THUMBNAIL_SCALE * dpr, isNear, false);

  return (
    <button
      ref={ref}
      type="button"
      className="thumb"
      aria-current={current ? 'page' : undefined}
      aria-label={t('viewer.page', { page: index + 1 })}
      onClick={onSelect}
    >
      <canvas
        ref={canvasRef}
        className="thumb-canvas"
        style={{ inlineSize: size[0] * THUMBNAIL_SCALE, blockSize: size[1] * THUMBNAIL_SCALE }}
      />
      <span className="thumb-number" aria-hidden="true">
        {index + 1}
      </span>
    </button>
  );
}
