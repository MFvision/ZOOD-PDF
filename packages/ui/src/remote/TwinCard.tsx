import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Monitor, MonitorSmartphone } from 'lucide-react';
import { askAccess, askAllow } from '../ask/settings';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import {
  findComputers,
  forgetComputer,
  nearestSide,
  offerComputer,
  onTwinStatus,
  pairComputer,
  realSide,
  setTwin,
  sideForKey,
  twinError,
  twinStatus,
} from './twin';
import type { FoundPc, TwinSide, TwinStatus } from './twin';

const isMac =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
// Kept left to right inside Arabic sentences.
const BACK_KEYS = isMac ? '\u2066⌃⌥Esc\u2069' : '\u2066Ctrl+Alt+Esc\u2069';
const SIDES = ['top', 'left', 'right', 'bottom'] as const;

/**
 * "Two computers, one mouse" in the remote's panel (`remote/twin.rs`): pair
 * with another computer once, then the pointer runs off this screen onto
 * that one. Where the other screen is, is a little picture of the desk:
 * this screen in the middle and the other one dragged to its side (it
 * takes that side's shape as it moves), or Auto. Off until the person pairs;
 * `pairing` is the remote's "another computer may pair now" (this side).
 */
export function TwinCard({ pairing }: { pairing: boolean }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<TwinStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<FoundPc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsAccess, setNeedsAccess] = useState(false);

  useEffect(() => {
    let live = true;
    twinStatus()
      .then((s) => live && setStatus(s))
      .catch(() => undefined);
    const stop = onTwinStatus((s) => setStatus(s));
    if (isMac) {
      void askAccess().then(
        (access) => live && setNeedsAccess(Boolean(access?.applies && !access.accessibility)),
      );
    }
    return () => {
      live = false;
      stop();
    };
  }, []);

  if (!status?.available) return null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(t(twinError(e)));
    } finally {
      setBusy(false);
    }
  };

  const look = () =>
    run(async () => {
      setFound(null);
      setFound(await findComputers());
    });

  const head = (
    <header className="twin-head">
      <Icon of={MonitorSmartphone} size={18} />
      <div>
        <h3 className="twin-title">{t('twin.title')}</h3>
        <p className="remote-switch-body">{t('twin.body')}</p>
      </div>
    </header>
  );

  const allow =
    needsAccess || status.state === 'permission' ? (
      <p className="twin-note" role="status">
        {t('twin.state.permission')}{' '}
        <button type="button" className="link-btn" onClick={() => void askAllow('accessibility')}>
          {t('twin.allow')}
        </button>
      </p>
    ) : null;

  if (!status.helper) {
    return (
      <section className="twin-card" aria-label={t('twin.title')}>
        {head}
        {status.digits ? (
          <div className="twin-digits" role="status">
            <span dir="ltr">{status.digits.replace(/(\d{3})(\d{3})/, '$1 $2')}</span>
            <p className="remote-switch-body">{t('twin.digits')}</p>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="icon-btn icon-btn-labeled remote-wide"
              disabled={busy}
              onClick={() => void look()}
            >
              {t('twin.find')}
            </button>
            <p className="remote-switch-body">{t('twin.findNote')}</p>
            {busy && found === null ? <p className="twin-note">{t('twin.looking')}</p> : null}
            {found !== null && found.length === 0 ? (
              <p className="twin-note">{t('twin.none')}</p>
            ) : null}
            {found !== null && found.length > 0 ? (
              <ul className="twin-found">
                {found.map((pc) => (
                  <li key={pc.addr}>
                    <Icon of={Monitor} size={16} />
                    <span dir="auto">{pc.pc}</span>
                    <button
                      type="button"
                      className="link-btn"
                      disabled={busy}
                      onClick={() => void run(() => pairComputer(pc))}
                    >
                      {t('twin.pair')}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <button
              type="button"
              className="icon-btn icon-btn-labeled remote-wide"
              disabled={busy || pairing}
              onClick={() => void run(offerComputer)}
            >
              {t('twin.offer')}
            </button>
            <p className="remote-switch-body">
              {pairing ? t('twin.offerOpen') : t('twin.offerNote')}
            </p>
          </>
        )}
        {error ? <p className="remote-error">{error}</p> : null}
        {allow}
      </section>
    );
  }

  const name = status.helper;
  const side = realSide(status.side);
  return (
    <section className="twin-card" aria-label={t('twin.title')}>
      {head}
      <label className="remote-switch">
        <input
          type="checkbox"
          role="switch"
          checked={status.on}
          disabled={busy}
          onChange={(e) => void run(() => setTwin({ on: e.target.checked }))}
        />
        <span>
          <strong dir="auto">{t('twin.on', { name })}</strong>
          <span className="remote-switch-body">{t('twin.back', { keys: BACK_KEYS })}</span>
        </span>
      </label>
      <ScreenBoard
        name={name}
        side={status.side}
        onSide={(next) => void run(() => setTwin({ side: next }))}
      />
      {status.on ? (
        <p className="twin-note" role="status" dir="auto">
          {status.state === 'ready'
            ? t('twin.state.ready', { edge: t(`twin.edge.${side}`) })
            : status.state === 'away'
              ? t('twin.state.away', { name, keys: BACK_KEYS })
              : status.state === 'refused'
                ? t('twin.state.refused', { name })
                : status.state === 'looking'
                  ? t('twin.state.looking', { name })
                  : null}
        </p>
      ) : null}
      {allow}
      {error ? <p className="remote-error">{error}</p> : null}
      <button
        type="button"
        className="link-btn twin-forget"
        disabled={busy}
        onClick={() => void run(forgetComputer)}
      >
        {t('twin.forget', { name })}
      </button>
    </section>
  );
}

/**
 * The desk as a picture: this screen in the middle, the other one at its
 * side. Drag it (or press an arrow key on it) to another side; it takes
 * the shape of the side it is over while it moves, and lands there. A tap
 * on an empty side puts it there too.
 */
function ScreenBoard({
  name,
  side,
  onSide,
}: {
  name: string;
  side: TwinSide;
  onSide: (side: TwinSide) => void;
}) {
  const { t } = useI18n();
  const board = useRef<HTMLDivElement | null>(null);
  const [held, setHeld] = useState<Exclude<TwinSide, 'auto'> | null>(null);
  const placed = held ?? realSide(side);

  const sideAt = (event: ReactPointerEvent) => {
    const box = board.current?.getBoundingClientRect();
    if (!box) return placed;
    const x = ((event.clientX - box.left) / box.width) * 2 - 1;
    const y = ((event.clientY - box.top) / box.height) * 2 - 1;
    return nearestSide(x, y);
  };

  const down = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setHeld(placed);
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (held !== null) setHeld(sideAt(event));
  };
  const up = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (held === null) return;
    const landed = sideAt(event);
    setHeld(null);
    if (landed !== realSide(side) || side === 'auto') onSide(landed);
  };
  const key = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const next = sideForKey(event.key);
    if (next) {
      event.preventDefault();
      onSide(next);
    }
  };

  return (
    <div className="twin-arrange">
      <p className="twin-board-label">{t('twin.board')}</p>
      <div
        ref={board}
        className={['twin-board', held ? 'is-dragging' : ''].filter(Boolean).join(' ')}
        dir="ltr"
      >
        {SIDES.map((s) => (
          <button
            key={s}
            type="button"
            tabIndex={-1}
            aria-label={t(`twin.side.${s}`)}
            className={['twin-slot', `twin-slot-${s}`, placed === s ? 'is-over' : '']
              .filter(Boolean)
              .join(' ')}
            onClick={() => onSide(s)}
          />
        ))}
        <div className="twin-here" aria-hidden="true">
          <Icon of={Monitor} size={22} />
          <span>{t('twin.here')}</span>
        </div>
        <button
          type="button"
          className={['twin-other', `twin-at-${placed}`].join(' ')}
          aria-label={t('twin.otherLabel', { name, side: t(`twin.side.${placed}`) })}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={() => setHeld(null)}
          onKeyDown={key}
        >
          <Icon of={Monitor} size={16} />
          <span dir="auto">{name}</span>
        </button>
      </div>
      <div className="twin-board-foot">
        <button
          type="button"
          role="switch"
          aria-checked={side === 'auto'}
          className={['twin-auto', side === 'auto' ? 'is-on' : ''].filter(Boolean).join(' ')}
          onClick={() => onSide(side === 'auto' ? 'right' : 'auto')}
        >
          {t('twin.auto')}
        </button>
        <span className="remote-switch-body" role="status">
          {side === 'auto' ? t('twin.autoNote') : t(`twin.side.${placed}`)}
        </span>
      </div>
    </div>
  );
}
