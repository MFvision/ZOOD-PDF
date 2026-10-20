import { useEffect } from 'react';
import { isApplePlatform } from '../shell/menuModel';
import { useI18n } from '../i18n/useT';
import { refreshVoices, setRate, setVoice, speechSupported, useReadAloud } from './readAloud';
import { openVoiceSettings } from './engines';
import { onlyBasicVoice, voiceLabel, voicesFor } from './voices';

const RATES = [0.75, 1, 1.25, 1.5, 2];

/**
 * Read aloud in the settings: the voice for Arabic and for English from the
 * system's own, and the speed. Says where more voices come from, and that
 * Siri's are not offered to apps.
 */
export function VoiceSettings() {
  const { t } = useI18n();
  const reading = useReadAloud();
  useEffect(() => {
    refreshVoices();
  }, []);
  if (!speechSupported()) {
    return (
      <section className="settings-section" aria-labelledby="settings-speech">
        <h3 id="settings-speech">{t('settings.speech')}</h3>
        <p className="tool-panel-note">{t('readAloud.unsupported')}</p>
      </section>
    );
  }
  const quality = { premium: t('readAloud.premium'), enhanced: t('readAloud.enhanced') };
  const basic = reading.engine === 'apple' && (onlyBasicVoice(reading.voices, 'ar') || onlyBasicVoice(reading.voices, 'en'));
  const pick = (lang: 'ar' | 'en') => (
    <label className="field">
      <span>{t(lang === 'ar' ? 'readAloud.voiceAr' : 'readAloud.voiceEn')}</span>
      <select className="select" value={(lang === 'ar' ? reading.voiceAr : reading.voiceEn) ?? ''} onChange={(event) => setVoice(lang, event.target.value || null)}>
        <option value="">{t('readAloud.auto')}</option>
        {voicesFor(reading.voices, lang).map((voice) => (
          <option key={voice.id} value={voice.id}>
            {voiceLabel(voice, quality)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section className="settings-section" aria-labelledby="settings-speech">
      <h3 id="settings-speech">{t('settings.speech')}</h3>
      {pick('ar')}
      {pick('en')}
      <label className="field">
        <span>{t('readAloud.speed')}</span>
        <select className="select" value={String(reading.rate)} onChange={(event) => setRate(Number(event.target.value))}>
          {RATES.map((rate) => (
            <option key={rate} value={String(rate)}>
              {rate}×
            </option>
          ))}
        </select>
      </label>
      {basic ? (
        <>
          <p className="tool-panel-note">{t('readAloud.betterVoiceHint')}</p>
          <button type="button" className="prefs-button" onClick={openVoiceSettings}>
            {t('readAloud.betterVoice')}
          </button>
        </>
      ) : null}
      <p className="tool-panel-note">{t(isApplePlatform() ? 'readAloud.moreVoicesApple' : 'readAloud.moreVoices')}</p>
    </section>
  );
}
