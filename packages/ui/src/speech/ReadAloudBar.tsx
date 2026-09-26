import { useEffect } from 'react';
import { Pause, Play, Square, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppState, useServices } from '../state/AppContext';
import { closeBar, pause, refreshVoices, resume, setRate, setVoice, start, stop, useReadAloud } from './readAloud';
import type { Scope } from './readAloud';
import { readingSource } from './readingSource';
import { voicesFor } from './voices';
import './speech.css';

const RATES = [0.75, 1, 1.25, 1.5, 2];

const NOTICE: Record<NonNullable<ReturnType<typeof useReadAloud>['notice']>, TKey> = {
  unsupported: 'readAloud.unsupported',
  noVoices: 'readAloud.noVoices',
  noText: 'readAloud.noText',
  done: 'readAloud.done',
};

/**
 * The read-aloud bar, under the toolbar: what to read (this page, the
 * document from here, the selection), play, pause and stop, the speed, and
 * a voice for each language from the system's own. Reading follows the
 * sentence on the page in either view.
 */
export function ReadAloudBar() {
  const { t } = useI18n();
  const state = useAppState();
  const services = useServices();
  const reading = useReadAloud();

  useEffect(() => {
    refreshVoices();
  }, []);

  const begin = async (scope: Scope) => {
    const source = await readingSource(services, state.currentPage);
    if (source) void start(source, scope);
  };

  const arabic = voicesFor(reading.voices, 'ar');
  const english = voicesFor(reading.voices, 'en');
  const busy = reading.active;

  return (
    <div className="readaloud" role="region" aria-label={t('readAloud.label')}>
      <div className="readaloud-scope" role="group" aria-label={t('readAloud.what')}>
        {(['page', 'document', 'selection'] as const).map((scope) => (
          <IconButton
            key={scope}
            label={t(`readAloud.${scope}`)}
            icon={<Icon of={Play} />}
            showLabel
            disabled={busy && !reading.paused && reading.scope === scope}
            onClick={() => void begin(scope)}
          />
        ))}
      </div>
      {busy && (
        <>
          {reading.paused ? (
            <IconButton label={t('readAloud.resume')} icon={<Icon of={Play} />} showLabel onClick={resume} />
          ) : (
            <IconButton label={t('readAloud.pause')} icon={<Icon of={Pause} />} showLabel onClick={pause} />
          )}
          <IconButton label={t('readAloud.stop')} icon={<Icon of={Square} />} showLabel onClick={stop} />
        </>
      )}
      <label className="readaloud-field">
        <span>{t('readAloud.speed')}</span>
        <select className="select" value={String(reading.rate)} onChange={(event) => setRate(Number(event.target.value))}>
          {RATES.map((rate) => (
            <option key={rate} value={String(rate)}>
              {rate}×
            </option>
          ))}
        </select>
      </label>
      <label className="readaloud-field">
        <span>{t('readAloud.voiceAr')}</span>
        <select className="select" value={reading.voiceAr ?? ''} onChange={(event) => setVoice('ar', event.target.value || null)}>
          <option value="">{t('readAloud.auto')}</option>
          {arabic.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.name}
            </option>
          ))}
        </select>
      </label>
      <label className="readaloud-field">
        <span>{t('readAloud.voiceEn')}</span>
        <select className="select" value={reading.voiceEn ?? ''} onChange={(event) => setVoice('en', event.target.value || null)}>
          <option value="">{t('readAloud.auto')}</option>
          {english.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.name}
            </option>
          ))}
        </select>
      </label>
      <span className="readaloud-status" role="status">
        {busy && reading.page !== null ? t('readAloud.reading', { page: reading.page }) : reading.notice ? t(NOTICE[reading.notice]) : ''}
      </span>
      <IconButton label={t('readAloud.close')} icon={<Icon of={X} />} onClick={closeBar} />
    </div>
  );
}
