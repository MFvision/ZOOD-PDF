import { useEffect, useState } from 'react';
import { FolderClosed, Layers, PanelLeft, Power, Settings2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import type { SectionId } from '../settings/SettingsWindow';
import { updateSettings, useSettings } from '../state/settings';
import { Glow, Replay, Steps, usePhases } from './scenes';
import './tabsScene.css';

/**
 * Tabs in the tour: a little ZOOD window that does it all by itself. Files
 * open as tabs; two of them gather under a coloured label, "Contracts"; the
 * group folds away and opens again; the tabs slide from the top down the
 * side; and the window closes and opens with every tab back where it was.
 * Each step can be picked by hand, and "Top" and "Side" under the picture
 * move the real app's tabs, not only the picture's.
 */

const STEPS: { icon: LucideIcon; text: TKey }[] = [
  { icon: Layers, text: 'tour.tabs.s1' },
  { icon: FolderClosed, text: 'tour.tabs.s2' },
  { icon: PanelLeft, text: 'tour.tabs.s3' },
  { icon: Power, text: 'tour.tabs.s4' },
];

const FILES: { name: TKey; group: boolean }[] = [
  { name: 'tour.tabs.f1', group: true },
  { name: 'tour.tabs.f2', group: true },
  { name: 'tour.tabs.f3', group: false },
];

export function TabsScene({ onSettings }: { onSettings: (section: SectionId) => void }) {
  const { t } = useI18n();
  const settings = useSettings();
  const { phase, pick, playing, replay } = usePhases(STEPS.length, 2600);
  // The picture's own side, until the real setting is changed below.
  const [mine, setMine] = useState<'top' | 'side' | null>(null);
  const side = mine ? mine === 'side' : phase >= 2;
  const grouped = phase >= 1;
  // In the group step, the group folds away a moment after it is made.
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setFolded(phase === 1), phase === 1 ? 1300 : 0);
    return () => window.clearTimeout(timer);
  }, [phase]);
  const restarting = phase === 3;
  const real = settings.tabPosition === 'side' ? 'side' : settings.tabPosition === 'auto' ? 'auto' : 'top';

  const place = (where: 'top' | 'side') => {
    setMine(where);
    pick(2);
    updateSettings({ tabPosition: where });
  };

  return (
    <div className="tour-scene tour-split">
      <div>
        <Steps steps={STEPS} phase={phase} onPick={(n) => {
          setMine(null);
          pick(n);
        }} />
        <div className="tour-field">
          <p className="tour-field-label" id="tour-tabs-place">
            {t('tour.tabs.where')}
          </p>
          <div className="tour-choice" role="radiogroup" aria-labelledby="tour-tabs-place">
            {(['top', 'side'] as const).map((where) => (
              <button key={where} type="button" role="radio" aria-checked={real === where} className="tour-choice-item" onClick={() => place(where)}>
                {t(where === 'top' ? 'prefs.tabPosition.top' : 'prefs.tabPosition.side')}
              </button>
            ))}
          </div>
        </div>
        <div className="tour-support-open">
          <button type="button" className="icon-btn icon-btn-labeled" onClick={() => onSettings('viewing')}>
            <Icon of={Settings2} size={14} />
            {t('tour.tabs.settings')}
          </button>
          {!playing && <Replay onClick={() => {
            setMine(null);
            replay();
          }} />}
        </div>
      </div>
      <div className="tour-stage">
        <Glow />
        <div className={['ts-window', side && 'is-side', restarting && 'is-restarting'].filter(Boolean).join(' ')} aria-hidden="true">
          <div className="ts-titlebar">
            <i />
            <i />
            <i />
          </div>
          <div className="ts-tabs">
            {grouped && (
              <span className={['ts-chip', folded && 'is-folded'].filter(Boolean).join(' ')} data-colour="blue">
                <span className="ts-dot" />
                <span className="ts-chip-name">{folded ? '2' : t('tour.tabs.group')}</span>
              </span>
            )}
            {FILES.map((file, index) => {
              if (folded && file.group && index > 0) return null;
              return (
                <span
                  key={file.name}
                  className={['ts-tab', index === 0 && 'is-live', grouped && file.group && 'in-group'].filter(Boolean).join(' ')}
                  data-colour={grouped && file.group ? 'blue' : undefined}
                  style={{ animationDelay: `${index * 160}ms` }}
                >
                  <span className="ts-tab-name">{t(file.name)}</span>
                </span>
              );
            })}
          </div>
          <div className="ts-toolbar">
            <i />
            <i />
            <i />
            <b />
          </div>
          <div className="ts-page">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          {restarting && (
            <div className="ts-back" role="presentation">
              <span>{t('tour.tabs.back')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
