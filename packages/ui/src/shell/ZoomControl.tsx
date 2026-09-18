import { useEffect, useState } from 'react';
import { setZoom, watchZoom } from '../embed/embedControl';
import type { EmbedZoom } from '../embed/embedControl';
import { useT } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { formatZoom, ZOOM_STEPS } from '../state/zoom';

const isPreset = (zoom: number) => ZOOM_STEPS.some((step) => Math.abs(step - zoom) < 0.001);

/**
 * The toolbar's zoom pop-up, "91 %", for whichever view is on screen: it
 * reads and sets EmbedPDF's zoom while EmbedPDF shows the page, and Warraq's
 * own in Edit text. The first two choices fit the page to the window.
 */
export function ZoomControl() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { embedShowing, embedRegistry, viewCommand } = useServices();
  const t = useT();
  const [embedZoom, setEmbedZoom] = useState<EmbedZoom | null>(null);

  useEffect(() => {
    if (!embedRegistry) return;
    return watchZoom(embedRegistry, setEmbedZoom);
  }, [embedRegistry]);

  const fromEmbed = embedShowing && embedZoom !== null;
  const scale = fromEmbed ? embedZoom.scale : state.zoom;
  const mode = fromEmbed ? embedZoom.mode : state.zoomMode;
  const value = mode === 'custom' ? String(scale) : mode;

  const choose = (next: string) => {
    if (next === 'fit-width' || next === 'fit-page') {
      viewCommand(next);
      return;
    }
    const zoom = Number(next);
    if (embedShowing && embedRegistry) setZoom(embedRegistry, zoom);
    else dispatch({ type: 'SET_ZOOM', zoom });
  };

  // The closed pop-up shows only the percentage, as the system's viewer does;
  // the real <select> lies over it, so the list and the keyboard are native.
  return (
    <span className="toolbar-zoom-value">
      <span aria-hidden="true">{formatZoom(scale)}</span>
      <select aria-label={t('zoom.select')} value={value} onChange={(event) => choose(event.target.value)}>
        <option value="fit-width">{t('view.fitWidth')}</option>
        <option value="fit-page">{t('view.fitPage')}</option>
        {mode === 'custom' && !isPreset(scale) && <option value={String(scale)}>{formatZoom(scale)}</option>}
        {ZOOM_STEPS.map((step) => (
          <option key={step} value={String(step)}>
            {formatZoom(step)}
          </option>
        ))}
      </select>
    </span>
  );
}
