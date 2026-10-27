import { useEffect } from 'react';
import { isApplePlatform } from '../shell/menuModel';
import { useI18n } from '../i18n/useT';
import { refreshVoices, sayExample, setRate, setVoice, speechSupported, useReadAloud } from './readAloud';
import { openVoiceSettings } from './engines';
import { NaturalVoices } from './NaturalVoices';
import { onlyBasicVoice, voiceLabel, voicesFor } from './voices';

const RATES = [0.75, 1, 1.25, 1.5, 2];

/**
 * Read aloud in the settings: the voice for Arabic and for English — the
 * app's own natural voices once downloaded, and the system's — each with a
 * button to hear it, and the speed. Says where more voices come from, and
 * that Siri's are not offered to apps.
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
  const quality = { premium: t('readAloud.premium'), enhanced: t('readAloud.enhanced'), natural: t('readAloud.natural') };
  const basic = reading.engine === 'apple' && (onlyBasicVoice(reading.voices, 'ar') || onlyBasicVoice(reading.voices, 'en'));
  const pick = (lang: 'ar' | 'en') => (
    <div className="voice-pick">
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
      <button type="button" className="prefs-button" onClick={() => void sayExample(lang)}>
        {t('readAloud.listen')}
      </button>
    </div>
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
      {reading.engine === 'neural' || reading.engine === 'apple' ? <NaturalVoices /> : null}
      {basic ? (
        <>
          <p className="tool-panel-note">{t('readAloud.betterVoiceHint')}</p>
          <button type="button" className="prefs-button" onClick={openVoiceSettings}>
            {t('readAloud.appleVoices')}
          </button>
        </>
      ) : null}
      <p className="tool-panel-note">{t(isApplePlatform() ? 'readAloud.moreVoicesApple' : 'readAloud.moreVoices')}</p>
    </section>
  );
}
