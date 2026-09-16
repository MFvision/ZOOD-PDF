import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useDevicePixelRatio } from '../components/useDevicePixelRatio';
import { useT } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { fitPageZoom, fitWidthZoom, PAGE_GAP, VIEWER_PADDING } from '../state/zoom';
import { PageView } from './PageView';
import { useSharedObserver } from './useSharedObserver';

const VISIBILITY_THRESHOLDS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
/** Pages within 1.5 viewport heights are rendered ahead of time. */
const RENDER_MARGIN = '150% 0px';

/** Continuous vertical scroll of all pages. */
export function Viewer() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { document: doc } = useServices();
  const t = useT();
  const dpr = useDevicePixelRatio();
  const containerRef = useRef<HTMLDivElement>(null);
  const near = useSharedObserver(containerRef, RENDER_MARGIN, 0);
  const visible = useSharedObserver(containerRef, '0px', VISIBILITY_THRESHOLDS);
  const ratios = useRef(new Map<number, number>());
  const scrollRatio = useRef(0);
  const info = state.document;

  // The page with the largest visible share is the current page (lowest index wins ties).
  const onVisibility = useCallback(
    (index: number, ratio: number) => {
      ratios.current.set(index, ratio);
      let best = -1;
      let bestRatio = 0;
      for (const [i, r] of ratios.current) {
        if (r > bestRatio || (r > 0 && r === bestRatio && i < best)) {
          best = i;
          bestRatio = r;
        }
      }
      if (best >= 0) dispatch({ type: 'SET_CURRENT_PAGE', page: best + 1 });
    },
    [dispatch],
  );

  const largestPage = useMemo(
    () =>
      (info?.pageSizes ?? []).reduce(
        (max, [width, height]) => ({ width: Math.max(max.width, width), height: Math.max(max.height, height) }),
        { width: 1, height: 1 },
      ),
    [info?.pageSizes],
  );

  // Fit modes follow the container size.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element || state.zoomMode === 'custom') return;
    const mode = state.zoomMode;
    const compute = () => {
      const viewport = { width: element.clientWidth, height: element.clientHeight };
      if (viewport.width <= 0) return;
      const zoom = mode === 'fit-width' ? fitWidthZoom(viewport, largestPage) : fitPageZoom(viewport, largestPage);
      dispatch({ type: 'FIT_ZOOM_COMPUTED', zoom });
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(element);
    return () => observer.disconnect();
  }, [state.zoomMode, largestPage, dispatch]);

  // Keep the same relative scroll position across zoom changes.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    element.scrollTop = scrollRatio.current * element.scrollHeight;
  }, [state.zoom]);

  const request = state.scrollRequest;
  useEffect(() => {
    if (!request) return;
    containerRef.current
      ?.querySelector<HTMLElement>(`[data-page="${request.page}"]`)
      ?.scrollIntoView({ block: 'start' });
  }, [request]);

  if (!info || !doc) return null;

  return (
    <div
      ref={containerRef}
      className="viewer"
      role="region"
      aria-label={t('viewer.label')}
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget;
        scrollRatio.current = element.scrollHeight > 0 ? element.scrollTop / element.scrollHeight : 0;
      }}
    >
      <div className="viewer-pages" style={{ gap: PAGE_GAP, padding: VIEWER_PADDING }}>
        {info.pageSizes.map((size, index) => (
          <PageView
            key={index}
            document={doc}
            index={index}
            size={size}
            zoom={state.zoom}
            dpr={dpr}
            near={near}
            visible={visible}
            onVisibility={onVisibility}
          />
        ))}
      </div>
    </div>
  );
}
