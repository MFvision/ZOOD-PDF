import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight, Presentation, Send, Smartphone, SquareMousePointer } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from '../components/Icon';
import { ZoodMark } from '../components/ZoodMark';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { startRemote } from '../remote/host';
import { PHONE_APP_LINK_SHORT, PHONE_APP_QR, PHONE_APP_QR_SIZE } from '../remote/phoneApp';
import { updateRemote, useRemoteView } from '../remote/store';
import './phoneScene.css';

type Step = 0 | 1 | 2;

const STEPS: { title: TKey; body: TKey }[] = [
  { title: 'tour.remote.s1', body: 'tour.remote.s1Body' },
  { title: 'tour.remote.s2', body: 'tour.remote.s2Body' },
  { title: 'tour.remote.s3', body: 'tour.remote.s3Body' },
];

/** How long a step takes to blur away before the next one comes in. */
const LEAVE_MS = 240;

/**
 * The phone chapter, as a card with its steps down the side: scan a code to
 * get the ZOOD PDF app (it leads to the website's /app page, which sends the
 * phone to the store, see remote/phoneApp.ts), then scan the PC's own code
 * from the app's Phone remote button or the camera, then it is connected.
 * The second step turns the phone remote on and watches it, so the card
 * moves on by itself when the phone arrives. Everything moves: the corners
 * breathe, a beam sweeps the code, the status pill turns to a tick, and a
 * step blurs away as the next one rises in (still with motion reduced).
 */
export function PhoneScene() {
  const { t, dir } = useI18n();
  const { status } = useRemoteView();
  const [step, setStep] = useState<Step>(0);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const phone = status?.phones[0]?.name ?? null;

  const go = (next: Step) => {
    window.clearTimeout(timer.current);
    setLeaving(true);
    timer.current = window.setTimeout(() => {
      setStep(next);
      setLeaving(false);
    }, LEAVE_MS);
  };

  const turnOn = async () => {
    setBusy(true);
    setFailed(false);
    try {
      updateRemote({ status: await startRemote() });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const toConnect = () => {
    go(1);
    if (!status?.running || !status.qr) void turnOn();
  };

  // The phone arrived: the pill turns to a tick, and a moment later the card moves on.
  useEffect(() => {
    if (step !== 1 || !phone) return;
    const later = window.setTimeout(() => go(2), 1100);
    return () => window.clearTimeout(later);
  }, [step, phone]);

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const Forward = dir === 'rtl' ? ArrowLeft : ArrowRight;

  return (
    <div className="tour-scene">
      <div className="phone-card" data-step={step}>
        <aside className="phone-card-side">
          <span className="phone-card-mark" aria-hidden="true">
            <ZoodMark size={22} />
          </span>
          <span className="phone-card-eyebrow">{t('tour.remote.eyebrow')}</span>
          <strong className="phone-card-heading">{t('tour.remote.heading')}</strong>
          <ol className="phone-steps">
            {STEPS.map((one, index) => (
              <li key={one.title} className={index < step ? 'is-done' : index === step ? 'is-current' : undefined} aria-current={index === step ? 'step' : undefined}>
                <span className="phone-steps-dot" aria-hidden="true">
                  {index < step ? <Icon of={Check} size={11} /> : index + 1}
                </span>
                <span>
                  <strong>{t(one.title)}</strong>
                  <span>{t(one.body)}</span>
                </span>
              </li>
            ))}
          </ol>
          <span className="phone-card-foot">{t('tour.remote.foot')}</span>
        </aside>

        <div className={leaving ? 'phone-card-main is-leaving' : 'phone-card-main'} key={step}>
          {step === 0 && (
            <>
              <div className="phone-card-text">
                <span className="phone-card-of">{t('tour.remote.of', { n: 1, total: 2 })}</span>
                <h3>{t('tour.remote.getTitle')}</h3>
                <p>{t('tour.remote.getBody')}</p>
                <p className="phone-card-link">
                  {t('tour.remote.getLink')} <code dir="ltr">{PHONE_APP_LINK_SHORT}</code>
                </p>
                <div className="phone-card-buttons">
                  <button type="button" className="icon-btn icon-btn-labeled icon-btn-primary" onClick={toConnect}>
                    {t('tour.remote.haveApp')}
                    <Icon of={Forward} size={13} />
                  </button>
                </div>
              </div>
              <ScanFrame state="waiting" pill={t('tour.remote.pointCamera')}>
                <svg className="phone-frame-qr" viewBox={`0 0 ${PHONE_APP_QR_SIZE} ${PHONE_APP_QR_SIZE}`} shapeRendering="crispEdges" role="img" aria-label={t('tour.remote.getQr')}>
                  <path stroke="currentColor" d={PHONE_APP_QR} />
                </svg>
              </ScanFrame>
            </>
          )}

          {step === 1 && (
            <>
              <div className="phone-card-text">
                <span className="phone-card-of">{t('tour.remote.of', { n: 2, total: 2 })}</span>
                <h3>{t('tour.remote.connectTitle')}</h3>
                <p>{t('tour.remote.connectBody')}</p>
                <ol className="phone-card-path" aria-label={t('tour.remote.pathLabel')}>
                  <li style={{ '--i': 0 } as CSSProperties}>
                    <ZoodMark size={14} />
                    ZOOD PDF
                  </li>
                  <li style={{ '--i': 1 } as CSSProperties}>
                    <Icon of={Smartphone} size={13} />
                    {t('tour.remote.pathRemote')}
                  </li>
                  <li style={{ '--i': 2 } as CSSProperties}>
                    <Icon of={SquareMousePointer} size={13} />
                    {t('tour.remote.pathScan')}
                  </li>
                </ol>
                <p className="phone-card-small">{t('tour.remote.noApp')}</p>
                {(failed || (status?.running && status.address === null)) && <p className="remote-error">{t(failed ? 'remote.failed' : 'remote.noNetwork')}</p>}
                <div className="phone-card-buttons">
                  <button type="button" className="icon-btn icon-btn-labeled" onClick={() => go(0)}>
                    <Icon of={Back} size={13} />
                    {t('tour.remote.back')}
                  </button>
                  {status?.running && !status.qr && !phone && (
                    <button type="button" className="icon-btn icon-btn-labeled" disabled={busy} onClick={() => void turnOn()}>
                      {t('remote.newCode')}
                    </button>
                  )}
                </div>
              </div>
              <ScanFrame state={phone ? 'done' : 'waiting'} pill={phone ? t('remote.connected', { name: phone }) : status?.qr ? t('remote.waiting') : t('tour.remote.making')}>
                {status?.qr ? (
                  // The host's own SVG of its own address: no outside markup.
                  <div className="phone-frame-qr phone-frame-host" role="img" aria-label={t('remote.qrLabel')} dangerouslySetInnerHTML={{ __html: status.qr }} />
                ) : (
                  <div className="phone-frame-qr phone-frame-empty" aria-hidden="true" />
                )}
              </ScanFrame>
            </>
          )}

          {step === 2 && (
            <>
              <div className="phone-card-text">
                <span className="phone-card-done" aria-hidden="true">
                  <Icon of={Check} size={20} />
                </span>
                <h3>{t('tour.remote.readyTitle')}</h3>
                <p>{phone ? t('remote.connected', { name: phone }) : t('tour.remote.readyBody')}</p>
                <ul className="phone-card-can">
                  {(
                    [
                      [Presentation, 'remote.feature.present'],
                      [Send, 'remote.feature.flick'],
                      [SquareMousePointer, 'remote.feature.pc'],
                    ] as [LucideIcon, TKey][]
                  ).map(([icon, key], index) => (
                    <li key={key} style={{ '--i': index } as CSSProperties}>
                      <Icon of={icon} size={14} />
                      {t(key)}
                    </li>
                  ))}
                </ul>
              </div>
              <span className="phone-mock" aria-hidden="true">
                <span className="phone-mock-notch" />
                <span className="phone-mock-title">
                  <ZoodMark size={12} />
                  {t('remote.title')}
                </span>
                <span className="phone-mock-slide">
                  <span>{t('tour.remote.slide', { n: 2 })}</span>
                </span>
                <span className="phone-mock-keys">
                  <span>
                    <Icon of={ChevronRight} size={16} mirror />
                  </span>
                  <span className="is-next">
                    <Icon of={ChevronLeft} size={16} mirror />
                  </span>
                </span>
              </span>
            </>
          )}
        </div>
      </div>
      <p className="tour-note">{t('tour.remote.later')}</p>
    </div>
  );
}

/** A code in a dark frame: corners that breathe, a beam that sweeps it, and a status pill under it. */
function ScanFrame({ state, pill, children }: { state: 'waiting' | 'done'; pill: string; children: ReactNode }) {
  return (
    <div className="phone-frame" data-state={state}>
      <span className="phone-frame-corners" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="phone-frame-tile">
        {children}
        <span className="phone-frame-beam" aria-hidden="true" />
      </span>
      <span className="phone-frame-pill" role="status">
        {state === 'done' ? <Icon of={Check} size={11} /> : <span className="phone-frame-dot" aria-hidden="true" />}
        {pill}
      </span>
    </div>
  );
}
