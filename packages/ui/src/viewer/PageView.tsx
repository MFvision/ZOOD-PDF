import { useEffect, useRef, useState } from 'react';
import { cx } from '../components/cx';
import type { RemoteDocument } from '../core/client';
import type { PageSize } from '../core/types';
import { EditLayer } from '../edit/EditLayer';
import { useEditPdf } from '../edit/editPdf';
import { ImageLayer } from '../edit/ImageLayer';
import { LinkLayer } from '../edit/LinkLayer';
import { pageScale } from '../edit/geometry';
import { useT } from '../i18n/useT';
import { useAppState } from '../state/AppContext';
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
  const { edit } = useAppState();
  // Edit PDF: text, pictures or links — each its own layer over the page.
  const { kind } = useEditPdf();
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

  const cssScale = pageScale(zoom);
  const pageRevision = edit.pageRevisions[index] ?? 0;
  useRenderedCanvas(canvasRef, document, index, cssScale * dpr, isNear, true, pageRevision);

  return (
    <section
      ref={ref}
      className={cx('page', edit.active && 'page-editing')}
      data-page={index + 1}
      aria-label={t('viewer.page', { page: index + 1 })}
      style={{ inlineSize: size[0] * cssScale, blockSize: size[1] * cssScale }}
    >
      <canvas ref={canvasRef} className="page-canvas" />
      {isNear && <TextOverlay document={document} index={index} scale={cssScale} revision={pageRevision} />}
      {isNear && edit.active && kind === 'text' && <EditLayer document={document} index={index} scale={cssScale} />}
      {isNear && edit.active && kind === 'images' && <ImageLayer document={document} index={index} scale={cssScale} />}
      {isNear && edit.active && kind === 'links' && <LinkLayer document={document} index={index} scale={cssScale} />}
    </section>
  );
}
