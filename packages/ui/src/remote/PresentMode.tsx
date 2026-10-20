import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { RemoteDocument } from '../core/client';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import { INK_STYLE, strokePath } from './pictures';
import { useRemoteView } from './store';

interface PresentModeProps {
  reading: RemoteDocument | null;
  page: number;
  onTurn: (page: number) => void;
  onClose: () => void;
}

/**
 * The page alone, as large as the screen allows, for an audience: no
 * toolbar, no panes. The laser, the ink and the black screen come from the
 * phone remote (or the keyboard: arrows, Page Up/Down, B, Esc). The page is
 * drawn at the screen's own resolution, again whenever the window's size
 * changes.
 */
export function PresentMode({ reading, page, onTurn, onClose }: PresentModeProps) {
  const { t, dir } = useI18n();
  const view = useRemoteView();
  const stage = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [drawn, setDrawn] = useState<{ width: number; height: number } | null>(null);
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The controls fade after two still seconds, and come back with the mouse.
  useEffect(() => {
    let timer = window.setTimeout(() => setIdle(true), 2000);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), 2000);
    };
    window.addEventListener('pointermove', wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', wake);
    };
  }, []);

  const size = reading?.pageSizes[page - 1] ?? null;
  const fit = size && box.width > 0 ? Math.min(box.width / size[0], box.height / size[1]) : 0;
  const width = size ? Math.floor(size[0] * fit) : 0;
  const height = size ? Math.floor(size[1] * fit) : 0;

  useEffect(() => {
    if (!reading || !size || fit <= 0) return;
    let cancelled = false;
    const ratio = Math.min(3, window.devicePixelRatio || 1);
    reading
      .render_page(page - 1, Math.min(6, fit * ratio))
      .then((picture) => {
        const target = canvas.current;
        if (cancelled || !target) return;
        target.width = picture.width;
        target.height = picture.height;
        target.getContext('2d')?.putImageData(new ImageData(picture.rgba, picture.width, picture.height), 0, 0);
        setDrawn({ width: picture.width, height: picture.height });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [reading, page, fit, size]);

  const { scale, at } = view.zoom;
  const zoomStyle =
    scale > 1
      ? { transform: `scale(${scale})`, transformOrigin: `${(at[0] * 100).toFixed(2)}% ${(at[1] * 100).toFixed(2)}%` }
      : undefined;
  const pageCount = reading?.pageCount ?? 0;
  const forward = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const back = dir === 'rtl' ? ChevronRight : ChevronLeft;

  return (
    <div className={`present${idle ? ' present-idle' : ''}`} role="dialog" aria-modal="true" aria-label={t('present.label')}>
      <div className="present-stage" ref={stage}>
        <div className="present-page" style={{ width, height, ...zoomStyle }}>
          <canvas ref={canvas} className="present-canvas" style={{ width, height, visibility: drawn ? 'visible' : 'hidden' }} aria-label={t('present.pageOf', { page, total: pageCount })} />
          {width > 0 && (
            <svg className="present-ink" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
              {view.ink.map((stroke) => {
                const style = INK_STYLE[stroke.tool];
                return (
                  <path
                    key={stroke.id}
                    d={strokePath(stroke.points, width, height)}
                    stroke={style.color}
                    strokeOpacity={style.opacity}
                    strokeWidth={style.width * width}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                );
              })}
              {view.laser && (
                <g className="present-laser" transform={`translate(${view.laser[0] * width} ${view.laser[1] * height})`}>
                  <circle r={Math.max(10, width * 0.012)} className="present-laser-glow" />
                  <circle r={Math.max(4, width * 0.0045)} className="present-laser-dot" />
                </g>
              )}
            </svg>
          )}
        </div>
      </div>
      {view.black && <div className="present-black" aria-label={t('present.black')} />}
      <div className="present-controls">
        <button type="button" className="present-btn" aria-label={t('present.previous')} disabled={page <= 1} onClick={() => onTurn(page - 1)}>
          <Icon of={back} />
        </button>
        <span className="present-count">{t('present.pageOf', { page, total: pageCount })}</span>
        <button type="button" className="present-btn" aria-label={t('present.next')} disabled={page >= pageCount} onClick={() => onTurn(page + 1)}>
          <Icon of={forward} />
        </button>
        <button type="button" className="present-btn" aria-label={t('present.end')} onClick={onClose}>
          <Icon of={X} />
        </button>
      </div>
    </div>
  );
}
