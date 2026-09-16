import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { useI18n } from '../i18n/useT';
import { PANE_MAX_WIDTH, PANE_MIN_WIDTH } from '../state/appReducer';

interface PaneResizerProps {
  /** Which pane the handle belongs to, in logical terms. */
  side: 'start' | 'end';
  width: number;
  onResize: (width: number) => void;
}

const KEY_STEP = 16;

/** Drag or arrow-key handle between a pane and the main area; aware of the reading direction. */
export function PaneResizer({ side, width, onResize }: PaneResizerProps) {
  const { t, dir } = useI18n();
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  // +1 when moving the pointer to the physical right grows the pane.
  const sign = (dir === 'rtl' ? -1 : 1) * (side === 'start' ? 1 : -1);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onResize(drag.current.startWidth + (event.clientX - drag.current.startX) * sign);
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number;
    if (event.key === 'ArrowRight') next = width + KEY_STEP * sign;
    else if (event.key === 'ArrowLeft') next = width - KEY_STEP * sign;
    else if (event.key === 'Home') next = PANE_MIN_WIDTH;
    else if (event.key === 'End') next = PANE_MAX_WIDTH;
    else return;
    event.preventDefault();
    onResize(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('pane.resize')}
      aria-valuenow={width}
      aria-valuemin={PANE_MIN_WIDTH}
      aria-valuemax={PANE_MAX_WIDTH}
      tabIndex={0}
      className="pane-resizer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={onKeyDown}
    />
  );
}
