import { Bug, CheckCircle2, ChevronUp, Hand, LifeBuoy, Lightbulb, MessageCircleQuestion, MousePointerClick } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { Glow, Replay, Steps, usePhases } from './scenes';
import './supportScene.css';

/**
 * Help & Support in the tour: a question finds its guide, the pointer shows
 * the way and then does it; a report follows its status to "fixed"; an idea
 * gets a vote. The button opens the real thing.
 */
export function SupportScene({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n();
  const { phase, pick, playing, replay } = usePhases(6, 1900);
  const steps: { icon: LucideIcon; text: TKey }[] = [
    { icon: MessageCircleQuestion, text: 'tour.support.p1' },
    { icon: Bug, text: 'tour.support.p2' },
    { icon: Lightbulb, text: 'tour.support.p3' },
  ];
  const step = phase >= 5 ? 2 : phase >= 4 ? 1 : 0;
  return (
    <div className="tour-scene tour-split">
      <div>
        <Steps steps={steps} phase={step} onPick={(n) => pick(n === 0 ? 0 : n === 1 ? 4 : 5)} />
        <div className="tour-support-open">
          <button type="button" className="icon-btn icon-btn-labeled icon-btn-primary" onClick={onOpen}>
            <Icon of={LifeBuoy} size={14} />
            {t('tour.support.open')}
          </button>
          {!playing && <Replay onClick={replay} />}
        </div>
      </div>
      <div className="tour-stage">
        <Glow />
        <div className="support-mock" data-phase={phase} aria-hidden="true">
          <span className="support-mock-q">
            <Icon of={MessageCircleQuestion} size={13} />
            {t('tour.support.question')}
          </span>
          <span className="support-mock-answer">
            <b>{t('tour.support.answerTitle')}</b>
            <span>1 · {t('tour.support.answer1')}</span>
            <span>2 · {t('tour.support.answer2')}</span>
            <span className="support-mock-buttons">
              <span className="support-mock-show">
                <Icon of={MousePointerClick} size={12} />
                {t('support.showMe')}
              </span>
              <span className="support-mock-do">
                <Icon of={Hand} size={12} />
                {t('support.doIt')}
              </span>
            </span>
          </span>
          <span className="support-mock-tool">{t('tool.combine')}</span>
          <span className="support-mock-pointer">
            <svg width="22" height="26" viewBox="0 0 30 34">
              <path d="M3 2 L3 26 L9.5 20 L14 31 L18.5 29 L14 18.5 L23 18.5 Z" />
            </svg>
          </span>
          <span className="support-mock-ticket">
            <Icon of={Bug} size={13} />
            <span>{t('tour.support.ticket')}</span>
            <span className="support-mock-status">
              <Icon of={CheckCircle2} size={12} />
              {t('support.status.fixedIn', { v: '0.5' })}
            </span>
          </span>
          <span className="support-mock-idea">
            <span className="support-mock-vote">
              <Icon of={ChevronUp} size={14} />
              <span>{phase >= 5 ? 42 : 41}</span>
            </span>
            <span>{t('tour.support.idea')}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
