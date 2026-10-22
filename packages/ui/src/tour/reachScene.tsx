import { useEffect, useState } from 'react';
import { Check, MousePointerClick, PanelBottom, Printer, RotateCw, Save, Zap } from 'lucide-react';
import { Icon } from '../components/Icon';
import { ZoodMark } from '../components/ZoodMark';
import { configureRing, ringSettings } from '../core/host-tauri';
import type { RingSettings } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import { configurePresence, presenceSettings } from '../ask/presence';
import { Toggle } from '../settings/controls';
import type { SectionId } from '../settings/SettingsWindow';
import { Glow, Replay, Steps, usePhases } from './scenes';

/**
 * Always ready: ZOOD within reach without its window, and Do it for me
 * that no longer waits on the screen. Played on a pretend desktop — the
 * ZOOD icon in the tray, the bubble on the edge, ZOOD's own buttons lit
 * one after another, a button found by its name in another app — with the
 * two real switches under it: keep ZOOD ready (it starts at sign-in, in the
 * tray) and the bubble.
 */

const STEPS = [
  { icon: PanelBottom, text: 'tour.reach.step1' },
  { icon: Zap, text: 'tour.reach.step2' },
  { icon: Check, text: 'tour.reach.step3' },
  { icon: MousePointerClick, text: 'tour.reach.step4' },
] as const;

export function ReachScene({ onSettings }: { onSettings: (section: SectionId) => void }) {
  const { t } = useI18n();
  const { phase, pick, playing, replay } = usePhases(STEPS.length, 3200);
  const [ring, setRing] = useState<RingSettings | null>(null);
  const [bubble, setBubble] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void ringSettings()
      .then((settings) => live && setRing(settings))
      .catch(() => undefined);
    void presenceSettings().then((presence) => live && setBubble(presence?.bubble ?? null));
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="tour-scene">
      <div className="tour-split">
        <div>
          <Steps steps={[...STEPS]} phase={phase} onPick={pick} />
          {!playing && <Replay onClick={replay} />}
        </div>
        <div className="tour-stage reach-stage">
          <Glow />
          <div className="reach-desk" data-phase={phase} aria-hidden="true">
            <div className="reach-window">
              <div className="reach-bar">
                <span className={phase === 2 ? 'reach-button is-lit is-first' : 'reach-button'}>
                  <Icon of={RotateCw} size={12} />
                  {t('tour.reach.rotate')}
                </span>
                <span className={phase === 2 ? 'reach-button is-lit is-second' : 'reach-button'}>
                  <Icon of={Save} size={12} />
                  {t('file.save')}
                </span>
                <span className={phase === 3 ? 'reach-button is-named' : 'reach-button'}>
                  <Icon of={Printer} size={12} />
                  {t('file.print')}
                </span>
              </div>
              {(phase === 0 || phase === 1) && <p className="reach-island">{t('ask.listening')}</p>}
              {phase === 2 && <p className="reach-island">{t('tour.reach.said3')}</p>}
              {phase === 3 && <p className="reach-island">{t('tour.reach.said4')}</p>}
            </div>
            <span className={phase === 1 ? 'reach-bubble is-pressed' : 'reach-bubble'}>
              <ZoodMark size={18} />
            </span>
            <div className="reach-tray">
              <span className={phase === 0 ? 'reach-tray-icon is-pressed' : 'reach-tray-icon'}>
                <ZoodMark size={12} />
              </span>
            </div>
          </div>
        </div>
      </div>
      <p className="tour-note">{t('tour.reach.note')}</p>
      {ring && (
        <Toggle
          label={t('tour.reach.ready')}
          hint={t('tour.reach.readyHint')}
          checked={ring.background}
          onChange={(on) => {
            const next = { ...ring, background: on };
            setRing(next);
            void configureRing(next).catch(() => setRing(ring));
          }}
        />
      )}
      {bubble !== null && (
        <Toggle
          label={t('ask.settings.bubble')}
          hint={t('tour.reach.bubbleHint')}
          checked={bubble}
          onChange={(on) => {
            setBubble(on);
            void configurePresence({ bubble: on });
          }}
        />
      )}
      <button type="button" className="link-btn tour-link" onClick={() => onSettings('ai')}>
        {t('tour.ask.openSettings')}
      </button>
    </div>
  );
}
