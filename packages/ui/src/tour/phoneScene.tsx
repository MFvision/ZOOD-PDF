import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowLeft, ArrowRight, ArrowUp, Check, ChevronLeft, ChevronRight, ClipboardCopy, FileText, Library, MonitorSmartphone, MousePointer2, Presentation, QrCode, Send, Smartphone, SquareMousePointer } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from '../components/Icon';
import { ZoodMark } from '../components/ZoodMark';
import { useReducedMotion } from '../components/useReducedMotion';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { startRemote } from '../remote/host';
import { PHONE_APP_LINK_SHORT, PHONE_APP_QR, PHONE_APP_QR_SIZE } from '../remote/phoneApp';
import { updateRemote, useRemoteView } from '../remote/store';
import { Replay } from './scenes';
import './phoneScene.css';

type Step = 0 | 1 | 2;
type Pose = 'rest' | 'scan';
type Screen = 'camera' | 'store' | 'download' | 'open' | 'library' | 'press' | 'connected' | 'remote' | 'pad' | 'send';
type Pill = 'point' | 'scanning' | 'read' | 'waiting' | 'connected' | 'slide' | 'pad' | 'file';

interface Beat {
  step: Step;
  pose: Pose;
  screen: Screen;
  pill: Pill;
  /** The slide on the computer, 1 to 3. */
  slide?: number;
  /** Where the computer's pointer is, as the phone moves it. */
  cursor?: number;
}

/**
 * The film, one beat at a time: the phone scans the code and the app comes
 * down; in the app, Phone remote scans the computer's code and connects;
 * then the phone turns the slides, moves the pointer and sends a file.
 */
const FILM: readonly Beat[] = [
  { step: 0, pose: 'rest', screen: 'camera', pill: 'point' },
  { step: 0, pose: 'scan', screen: 'camera', pill: 'scanning' },
  { step: 0, pose: 'scan', screen: 'store', pill: 'read' },
  { step: 0, pose: 'rest', screen: 'download', pill: 'read' },
  { step: 0, pose: 'rest', screen: 'open', pill: 'read' },
  { step: 1, pose: 'rest', screen: 'library', pill: 'waiting' },
  { step: 1, pose: 'rest', screen: 'press', pill: 'waiting' },
  { step: 1, pose: 'scan', screen: 'camera', pill: 'scanning' },
  { step: 1, pose: 'scan', screen: 'connected', pill: 'connected' },
  { step: 2, pose: 'rest', screen: 'remote', pill: 'slide', slide: 1 },
  { step: 2, pose: 'rest', screen: 'remote', pill: 'slide', slide: 2 },
  { step: 2, pose: 'rest', screen: 'remote', pill: 'slide', slide: 3 },
  { step: 2, pose: 'rest', screen: 'pad', pill: 'pad', slide: 3, cursor: 1 },
  { step: 2, pose: 'rest', screen: 'pad', pill: 'pad', slide: 3, cursor: 2 },
  { step: 2, pose: 'rest', screen: 'send', pill: 'file', slide: 3, cursor: 2 },
  { step: 2, pose: 'rest', screen: 'send', pill: 'file', slide: 3, cursor: 2 },
];
const BEAT_MS = 1150;
/** Where each step's part of the film starts, and the beat that shows it best when it does not move. */
const STEP_START: Record<Step, number> = { 0: 0, 1: 5, 2: 9 };
const STEP_STILL: Record<Step, number> = { 0: 2, 1: 8, 2: 10 };

const STEPS: { title: TKey; body: TKey }[] = [
  { title: 'tour.remote.s1', body: 'tour.remote.s1Body' },
  { title: 'tour.remote.s2', body: 'tour.remote.s2Body' },
  { title: 'tour.remote.s3', body: 'tour.remote.s3Body' },
];

const PILL: Record<Pill, TKey> = {
  point: 'tour.remote.pointCamera',
  scanning: 'tour.remote.pill.scanning',
  read: 'tour.remote.pill.read',
  waiting: 'remote.waiting',
  connected: 'tour.remote.pill.connected',
  slide: 'tour.remote.pill.slide',
  pad: 'tour.remote.pill.pad',
  file: 'tour.remote.pill.file',
};

/** The film's clock: a beat at a time, looping; still with motion reduced, and paused when someone picks a step. */
function useFilm() {
  const reduced = useReducedMotion();
  const [beat, setBeat] = useState(0);
  const [paused, setPaused] = useState(false);
  const playing = !reduced && !paused;
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setBeat((b) => (b + 1) % FILM.length), BEAT_MS);
    return () => window.clearInterval(timer);
  }, [playing]);
  return {
    beat: reduced && !paused ? STEP_STILL[0] : beat,
    playing,
    /** Plays on from a step's start (or shows its still beat, with motion reduced). */
    playFrom: (step: Step) => {
      setBeat(reduced ? STEP_STILL[step] : STEP_START[step]);
      setPaused(reduced);
    },
    hold: (at: number) => {
      setBeat(at);
      setPaused(true);
    },
    replay: () => {
      setBeat(0);
      setPaused(false);
    },
  };
}

function AppQr({ label }: { label?: string }) {
  return (
    <svg
      className="pf-qr-svg"
      viewBox={`0 0 ${PHONE_APP_QR_SIZE} ${PHONE_APP_QR_SIZE}`}
      shapeRendering="crispEdges"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path stroke="currentColor" d={PHONE_APP_QR} />
    </svg>
  );
}

/**
 * The phone chapter, as a short film in a card with its three steps down the
 * side: get the app (the code is real: it leads to the website's /app page,
 * which sends the phone to the store, see remote/phoneApp.ts), scan the
 * computer's code from the app's Phone remote, then control the computer
 * from the phone. The film plays by itself and loops; a step picked on the
 * side plays from there. "Show my computer's code" stops the film on the
 * real code, and when a phone joins it plays the control part for real.
 */
export function PhoneScene() {
  const { t, dir } = useI18n();
  const { status } = useRemoteView();
  const film = useFilm();
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const phone = status?.phones[0]?.name ?? null;

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

  const showCode = () => {
    setLive(true);
    film.hold(STEP_START[1]);
    if (!status?.running || !status.qr) void turnOn();
  };

  // A phone joined while the real code was shown: it is connected, and the film goes on to what it can do.
  const joined = useRef(false);
  useEffect(() => {
    if (!live || !phone || joined.current) return;
    joined.current = true;
    film.hold(8);
    const later = window.setTimeout(() => {
      setLive(false);
      film.playFrom(2);
    }, 1400);
    return () => window.clearTimeout(later);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the phone arrives
  }, [live, phone]);

  const beat = FILM[film.beat]!;
  const step = beat.step;
  const pick = (next: Step) => {
    setLive(false);
    film.playFrom(next);
  };

  const Forward = dir === 'rtl' ? ArrowLeft : ArrowRight;
  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const realCode = live && status?.qr;
  const pill = live
    ? phone
      ? t('remote.connected', { name: phone })
      : status?.qr
        ? t('remote.waiting')
        : t('tour.remote.making')
    : beat.pill === 'slide'
      ? t(PILL.slide, { n: beat.slide ?? 1 })
      : t(PILL[beat.pill]);
  const pillDone = live ? Boolean(phone) : ['read', 'connected', 'file'].includes(beat.pill);

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
              <li key={one.title} className={index < step ? 'is-done' : index === step ? 'is-current' : undefined}>
                <button type="button" aria-current={index === step ? 'step' : undefined} onClick={() => pick(index as Step)}>
                  <span className="phone-steps-dot" aria-hidden="true">
                    {index < step ? <Icon of={Check} size={11} /> : index + 1}
                  </span>
                  <span>
                    <strong>{t(one.title)}</strong>
                    <span>{t(one.body)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <span className="phone-card-foot">{t('tour.remote.foot')}</span>
        </aside>

        <div className="phone-card-main">
          <div className="phone-card-text" key={step}>
            <span className="phone-card-of">{t('tour.remote.of', { n: step + 1, total: 3 })}</span>
            {step === 0 && (
              <>
                <h3>{t('tour.remote.getTitle')}</h3>
                <p>{t('tour.remote.getBody')}</p>
                <p className="phone-card-link">
                  {t('tour.remote.getLink')} <code dir="ltr">{PHONE_APP_LINK_SHORT}</code>
                </p>
                <div className="phone-card-buttons">
                  <button type="button" className="icon-btn icon-btn-labeled icon-btn-primary" onClick={() => pick(1)}>
                    {t('tour.remote.haveApp')}
                    <Icon of={Forward} size={13} />
                  </button>
                </div>
              </>
            )}
            {step === 1 && (
              <>
                <h3>{t('tour.remote.connectTitle')}</h3>
                <p>{t('tour.remote.connectBody')}</p>
                {live && <p className="phone-card-small">{t('tour.remote.noApp')}</p>}
                {live && (failed || (status?.running && status.address === null)) && <p className="remote-error">{t(failed ? 'remote.failed' : 'remote.noNetwork')}</p>}
                <div className="phone-card-buttons">
                  {live ? (
                    <>
                      <button type="button" className="icon-btn icon-btn-labeled" onClick={() => pick(1)}>
                        <Icon of={Back} size={13} />
                        {t('tour.remote.watch')}
                      </button>
                      {status?.running && !status.qr && !phone && (
                        <button type="button" className="icon-btn icon-btn-labeled" disabled={busy} onClick={() => void turnOn()}>
                          {t('remote.newCode')}
                        </button>
                      )}
                    </>
                  ) : (
                    <button type="button" className="icon-btn icon-btn-labeled icon-btn-primary" disabled={busy} onClick={showCode}>
                      <Icon of={QrCode} size={13} />
                      {t('tour.remote.showCode')}
                    </button>
                  )}
                </div>
              </>
            )}
            {step === 2 && (
              <>
                <h3>{t('tour.remote.controlTitle')}</h3>
                <p>{t('tour.remote.controlBody')}</p>
                <ul className="phone-card-can">
                  {(
                    [
                      [Presentation, 'remote.feature.present', 'slide'],
                      [SquareMousePointer, 'remote.feature.pc', 'pad'],
                      [Send, 'remote.feature.flick', 'file'],
                      [ClipboardCopy, 'tour.remote.clip', 'file'],
                    ] as [LucideIcon, TKey, Pill][]
                  ).map(([icon, key, part], index) => (
                    <li key={key} className={beat.pill === part ? 'is-now' : undefined} style={{ '--i': index } as CSSProperties}>
                      <Icon of={icon} size={14} />
                      {t(key)}
                    </li>
                  ))}
                </ul>
                <p className="phone-card-small phone-card-twin">
                  <Icon of={MonitorSmartphone} size={14} />
                  {t('tour.remote.twin')}
                </p>
              </>
            )}
            {!film.playing && !live && <Replay onClick={film.replay} />}
          </div>

          <div
            className="pf"
            data-step={step}
            data-pose={live ? 'scan' : beat.pose}
            data-screen={live ? (phone ? 'connected' : 'camera') : beat.screen}
            data-slide={beat.slide ?? 1}
            data-cursor={beat.cursor ?? 0}
            data-live={live || undefined}
          >
            <div className="pf-screen">
              <span className="pf-corners" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
              </span>
              {/* Get the app: the real code, always scannable. */}
              <span className="pf-layer pf-qr pf-qr-app">
                <AppQr label={t('tour.remote.getQr')} />
                <span className="pf-beam" aria-hidden="true" />
              </span>
              {/* Connect: the computer's own code when it is shown for real, a picture of one in the film. */}
              <span className="pf-layer pf-qr pf-qr-pc">
                {realCode ? (
                  // The host's own SVG of its own address: no outside markup.
                  <span className="pf-host" role="img" aria-label={t('remote.qrLabel')} dangerouslySetInnerHTML={{ __html: status!.qr! }} />
                ) : live ? (
                  <span className="pf-making" aria-hidden="true" />
                ) : (
                  <span className="pf-pc-code" aria-hidden="true">
                    <AppQr />
                  </span>
                )}
                <span className="pf-beam" aria-hidden="true" />
              </span>
              {/* Control: the computer's slides, the pointer, and a file arriving. */}
              <span className="pf-layer pf-desk" aria-hidden="true">
                <span className="pf-slides">
                  {[1, 2, 3].map((n) => (
                    <span key={n} className="pf-slide" data-n={n}>
                      <i />
                      <b />
                      <b />
                      <em>{n}</em>
                    </span>
                  ))}
                </span>
                <span className="pf-pointer">
                  <Icon of={MousePointer2} size={16} />
                </span>
                <span className="pf-landed">
                  <Icon of={FileText} size={18} />
                </span>
              </span>
              <span className={pillDone ? 'pf-pill is-done' : 'pf-pill'} role="status">
                {pillDone ? <Icon of={Check} size={11} /> : <span className="pf-dot" aria-hidden="true" />}
                {pill}
              </span>
            </div>
            <span className="pf-base" aria-hidden="true" />

            <span className="pf-phone" aria-hidden="true">
              <span className="pf-notch" />
              <span className="pf-display">
                <span className="pf-view pf-camera">
                  <span className="pf-cam-corners" />
                  <span className="pf-cam-code">
                    <AppQr />
                  </span>
                  <span className="pf-cam-beam" />
                </span>
                <span className="pf-view pf-store">
                  <span className="pf-app-icon">
                    <ZoodMark size={26} />
                  </span>
                  <strong>ZOOD PDF</strong>
                  <span className="pf-get">
                    <span className="pf-get-word pf-get-get">{t('tour.remote.store.get')}</span>
                    <svg className="pf-ring" viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="9" />
                    </svg>
                    <span className="pf-get-word pf-get-open">{t('tour.remote.store.open')}</span>
                  </span>
                </span>
                <span className="pf-view pf-library">
                  <span className="pf-app-bar">
                    <ZoodMark size={12} />
                    <Icon of={Library} size={11} />
                  </span>
                  <span className="pf-remote-btn">
                    <Icon of={Smartphone} size={12} />
                    {t('tour.remote.pathRemote')}
                  </span>
                  <span className="pf-file-row" />
                  <span className="pf-file-row" />
                  <span className="pf-file-row" />
                </span>
                <span className="pf-view pf-connected">
                  <span className="pf-big-check">
                    <Icon of={Check} size={22} />
                  </span>
                  <strong>{t('tour.remote.pill.connected')}</strong>
                </span>
                <span className="pf-view pf-remote">
                  <span className="pf-mini-slide">{t('tour.remote.slide', { n: beat.slide ?? 1 })}</span>
                  <span className="pf-keys">
                    <span>
                      <Icon of={ChevronLeft} size={15} mirror />
                    </span>
                    <span className="pf-next">
                      <Icon of={ChevronRight} size={15} mirror />
                    </span>
                  </span>
                </span>
                <span className="pf-view pf-pad">
                  <span className="pf-finger" />
                </span>
                <span className="pf-view pf-send">
                  <span className="pf-flick">
                    <Icon of={FileText} size={18} />
                  </span>
                  <span className="pf-swipe">
                    <Icon of={ArrowUp} size={12} />
                  </span>
                </span>
              </span>
            </span>
          </div>
        </div>
      </div>
      <p className="tour-note">{t('tour.remote.later')}</p>
    </div>
  );
}
