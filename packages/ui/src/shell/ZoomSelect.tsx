import { useAppDispatch, useAppState } from '../state/AppContext';
import { formatZoom, ZOOM_STEPS } from '../state/zoom';
import { useT } from '../i18n/useT';
import { cx } from '../components/cx';

const isPreset = (zoom: number) => ZOOM_STEPS.some((step) => Math.abs(step - zoom) < 0.001);

export function ZoomSelect({ compact }: { compact?: boolean }) {
  const { zoom, zoomMode } = useAppState();
  const dispatch = useAppDispatch();
  const t = useT();
  const value = zoomMode === 'custom' ? String(zoom) : zoomMode;

  return (
    <select
      className={cx('select', compact && 'select-compact')}
      aria-label={t('zoom.select')}
      value={value}
      onChange={(event) => {
        const next = event.target.value;
        if (next === 'fit-width' || next === 'fit-page') dispatch({ type: 'SET_ZOOM_MODE', mode: next });
        else dispatch({ type: 'SET_ZOOM', zoom: Number(next) });
      }}
    >
      <option value="fit-width">
        {t('view.fitWidth')}
        {zoomMode === 'fit-width' ? ` (${formatZoom(zoom)})` : ''}
      </option>
      <option value="fit-page">
        {t('view.fitPage')}
        {zoomMode === 'fit-page' ? ` (${formatZoom(zoom)})` : ''}
      </option>
      {zoomMode === 'custom' && !isPreset(zoom) && <option value={String(zoom)}>{formatZoom(zoom)}</option>}
      {ZOOM_STEPS.map((step) => (
        <option key={step} value={String(step)}>
          {formatZoom(step)}
        </option>
      ))}
    </select>
  );
}
