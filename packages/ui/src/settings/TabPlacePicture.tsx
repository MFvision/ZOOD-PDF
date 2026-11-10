import { useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { Sparkles } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useReducedMotion } from '../components/useReducedMotion';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import type { TabPosition } from '../state/settings';
import { AUTO_SIDE_FROM } from '../shell/tabPlace';
import './tabPlace.css';

/**
 * Settings › Viewing › Tabs, as the window itself: a little ZOOD window with
 * its toolbar and page, and the tabs (three of them, two in a coloured
 * group) where they are now. Take the tabs with the pointer and drag them
 * above the toolbar, under it, or down the side; every place they can go
 * lights up while they move. A tap on a place puts them there too, and Auto
 * lets ZOOD choose: along the top while they fit, down the side once there
 * are many. The owner's rule for layout settings (2026-10-26): a live
 * picture you drag things in, never a list.
 */

type Slot = Exclude<TabPosition, 'auto'>;
const SLOTS: readonly Slot[] = ['top', 'toolbar', 'side'];

const SLOT_LABEL: Record<Slot, TKey> = {
  top: 'prefs.tabPlace.top',
  toolbar: 'prefs.tabPlace.toolbar',
  side: 'prefs.tabPlace.side',
};

export function TabPlacePicture({ value, onChange }: { value: TabPosition; onChange: (next: TabPosition) => void }) {
  const { t } = useI18n();
  const still = useReducedMotion();
  const frame = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; dx: number; dy: number; over: Slot | null; moved: boolean } | null>(null);
  const auto = value === 'auto';
  // With Auto the picture shows the tabs along the top, as they start.
  const shown: Slot = auto ? 'top' : value;

  const slotAt = (x: number, y: number): Slot | null => {
    // Under the tabs being carried, which sit over the place they would go.
    const below = window.document.elementsFromPoint(x, y).find((one) => !one.closest('.tp-strip'));
    const under = below?.closest<HTMLElement>('[data-slot]');
    return under && frame.current?.contains(under) ? (under.dataset.slot as Slot) : null;
  };

  const onDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ x: event.clientX, y: event.clientY, dx: 0, dy: 0, over: null, moved: false });
  };
  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    setDrag({ ...drag, dx, dy, moved: drag.moved || Math.hypot(dx, dy) > 4, over: slotAt(event.clientX, event.clientY) });
  };
  // The click that ends a drag lands on the place it started from: not a choice.
  const dragged = useRef(false);
  const onUp = () => {
    if (drag?.moved) {
      dragged.current = true;
      window.setTimeout(() => {
        dragged.current = false;
      }, 0);
      if (drag.over) onChange(drag.over);
    }
    setDrag(null);
  };

  const strip = (
    <div
      className={['tp-strip', drag?.moved && 'is-lifted'].filter(Boolean).join(' ')}
      style={drag?.moved ? ({ '--dx': `${drag.dx}px`, '--dy': `${drag.dy}px` } as CSSProperties) : undefined}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => setDrag(null)}
      aria-hidden="true"
    >
      <span className="tp-chip" data-colour="blue" />
      <span className="tp-tab is-live" data-colour="blue" />
      <span className="tp-tab" data-colour="blue" />
      <span className="tp-tab" />
    </div>
  );

  return (
    <div className={['tp', still && 'is-still'].filter(Boolean).join(' ')}>
      <div ref={frame} className={['tp-window', drag?.moved && 'is-dragging'].filter(Boolean).join(' ')} data-place={shown} role="radiogroup" aria-label={t('prefs.tabPosition')}>
        <div className="tp-titlebar" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        {SLOTS.map((slot) => (
          <button
            key={slot}
            type="button"
            role="radio"
            aria-checked={!auto && value === slot}
            aria-label={t(SLOT_LABEL[slot])}
            title={t(SLOT_LABEL[slot])}
            className={['tp-slot', `tp-slot-${slot}`, shown === slot && 'is-here', drag?.over === slot && 'is-over'].filter(Boolean).join(' ')}
            data-slot={slot}
            onClick={() => {
              if (!dragged.current) onChange(slot);
            }}
          >
            {shown === slot ? strip : <span className="tp-slot-hint">{t(SLOT_LABEL[slot])}</span>}
          </button>
        ))}
        <div className="tp-toolbar" aria-hidden="true">
          <i />
          <i />
          <i />
          <b />
        </div>
        <div className="tp-page" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>
      <div className="tp-under">
        <p className="tp-caption">{auto ? t('prefs.tabPlace.autoNote', { n: AUTO_SIDE_FROM }) : t(SLOT_LABEL[value as Slot])}</p>
        <button type="button" role="switch" aria-checked={auto} className={['tp-auto', auto && 'is-on'].filter(Boolean).join(' ')} onClick={() => onChange(auto ? 'top' : 'auto')}>
          <Icon of={Sparkles} size={14} />
          <span>{t('prefs.tabPlace.auto')}</span>
        </button>
      </div>
    </div>
  );
}
