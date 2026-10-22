import { useEffect, useState } from 'react';
import { Check, FolderInput, HelpCircle, Mic, RotateCcw, Zap } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import { modelReady } from '../ask/settings';
import { quickModel } from '../ask/quick';
import type { SectionId } from '../settings/SettingsWindow';
import { Glow, Replay, Steps, usePhases } from './scenes';

/**
 * Quick asks: what the small decider does, played on a pretend island. A
 * quick ask is done at once with a one-line reply; "organize my Downloads"
 * shows the moves first and keeps an Undo; when the decider is not sure it
 * offers its two best guesses instead of guessing. The decider is a download
 * of its own, so the chapter says when it is not on this computer yet and
 * opens Settings at it.
 */

const STEPS = [
  { icon: Zap, text: 'tour.quickask.step1' },
  { icon: FolderInput, text: 'tour.quickask.step2' },
  { icon: RotateCcw, text: 'tour.quickask.step3' },
  { icon: HelpCircle, text: 'tour.quickask.step4' },
] as const;

export function QuickAskScene({ onSettings }: { onSettings: (section: SectionId) => void }) {
  const { t } = useI18n();
  const { phase, pick, playing, replay } = usePhases(STEPS.length, 3200);
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    const model = quickModel();
    void (model ? modelReady(model) : Promise.resolve(false)).then((on) => live && setReady(on));
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
        <div className="tour-stage ask-stage">
          <Glow />
          <div className="quickask-mock" data-phase={phase} aria-hidden="true">
            <p className="quickask-said">
              <Icon of={Mic} size={13} />
              <span dir="auto">{t(`tour.quickask.said${phase + 1}` as 'tour.quickask.said1')}</span>
            </p>
            <div className="quickask-island">
              {phase === 0 && (
                <p className="quickask-line">
                  <Icon of={Check} size={13} />
                  {t('tour.quickask.reply1')}
                </p>
              )}
              {phase === 1 && (
                <>
                  <p className="quickask-line">{t('tour.quickask.reply2')}</p>
                  <ul className="quickask-moves">
                    <li>{t('tour.quickask.move1')}</li>
                    <li>{t('tour.quickask.move2')}</li>
                    <li>{t('tour.quickask.move3')}</li>
                  </ul>
                  <span className="quickask-buttons">
                    <span className="quickask-button is-main">{t('ask.tidy.go')}</span>
                    <span className="quickask-button">{t('ask.cancel')}</span>
                  </span>
                </>
              )}
              {phase === 2 && (
                <>
                  <p className="quickask-line">
                    <Icon of={Check} size={13} />
                    {t('tour.quickask.reply3')}
                  </p>
                  <span className="quickask-buttons">
                    <span className="quickask-button">
                      <Icon of={RotateCcw} size={12} />
                      {t('ask.tidy.undo')}
                    </span>
                  </span>
                </>
              )}
              {phase === 3 && (
                <>
                  <p className="quickask-line">{t('ask.quick.choose')}</p>
                  <span className="quickask-buttons">
                    <span className="quickask-button">{t('tour.quickask.pick1')}</span>
                    <span className="quickask-button">{t('tour.quickask.pick2')}</span>
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <p className="tour-note">{t('tour.quickask.private')}</p>
      {ready === false && (
        <p className="tour-note" role="status">
          {t('tour.quickask.download')}{' '}
          <button type="button" className="link-btn" onClick={() => onSettings('ai')}>
            {t('tour.ask.openSettings')}
          </button>
        </p>
      )}
      {ready && (
        <p className="ask-ready is-on" role="status">
          <Icon of={Check} size={14} />
          <span>{t('tour.quickask.ready')}</span>
        </p>
      )}
    </div>
  );
}
