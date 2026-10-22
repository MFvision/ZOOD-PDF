import { useEffect, useState } from 'react';
import { Pause, Play, ScanText, Sparkles, Square, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { openSettingsAt } from '../settings/SettingsWindow';
import { readOcrOptions } from '../ocr/run';
import type { OcrProgress } from '../ocr/run';
import { closeBar, pause, refreshVoices, resume, setRate, setVoice, start, stop, useReadAloud } from './readAloud';
import type { Scope } from './readAloud';
import { readingSource } from './readingSource';
import { openVoiceSettings } from './engines';
import { onlyBasicVoice, voiceLabel, voicesFor } from './voices';
import './speech.css';

const RATES = [0.75, 1, 1.25, 1.5, 2];

const NOTICE: Record<NonNullable<ReturnType<typeof useReadAloud>['notice']>, TKey> = {
  unsupported: 'readAloud.unsupported',
  noVoices: 'readAloud.noVoices',
  noText: 'readAloud.noText',
  noSelection: 'readAloud.noSelection',
  done: 'readAloud.done',
};

/**
 * The read-aloud bar, under the toolbar: what to read (this page, the
 * document from here, the selection), play, pause and stop, the speed, and
 * a voice for each language from the system's own. Reading follows the
 * sentence on the page in either view. A page with no text — a scan, a
 * photo — is offered Scan & OCR first, and read once its text is found.
 */
export function ReadAloudBar() {
  const { t } = useI18n();
  const state = useAppState();
  const services = useServices();
  const dispatch = useAppDispatch();
  const reading = useReadAloud();

  useEffect(() => {
    refreshVoices();
  }, []);

  const [ocr, setOcr] = useState<OcrProgress | 'failed' | 'none' | null>(null);

  const begin = async (scope: Scope) => {
    setOcr(null);
    const source = await readingSource(services, state.currentPage);
    if (source) void start(source, scope);
  };

  // Scan & OCR for a document with nothing to read, then this page read
  // from the file with its new text.
  const recognize = async () => {
    setOcr({ page: 0, of: 0 });
    try {
      const { cleanup } = readOcrOptions();
      const outcome = await services.recognizeText(['ara', 'eng'], 'blank', setOcr, undefined, { cleanup, replaceImage: false });
      if (outcome.words === 0) {
        setOcr('none');
        return;
      }
      setOcr(null);
      setReadNext(1);
    } catch {
      setOcr('failed');
    }
  };
  // The file reopens with its text after OCR; the view catches up a moment
  // later. Reading starts once the open file can be read, tried again as the
  // view settles (a few times, then given up).
  const [readNext, setReadNext] = useState<number | null>(null);
  const ready = state.switching === null && state.loadingName === null;
  useEffect(() => {
    if (readNext === null || !ready) return;
    let live = true;
    const timer = window.setTimeout(() => {
      readingSource(services, state.currentPage)
        .then((source) => {
          if (!live) return;
          setReadNext(null);
          if (source) void start(source, 'page');
        })
        .catch(() => {
          if (live) setReadNext(readNext >= 10 ? null : readNext + 1);
          if (live && readNext >= 10) setOcr('failed');
        });
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [readNext, ready, services, state.currentPage]);
  const recognizing = ocr !== null && typeof ocr === 'object';

  const arabic = voicesFor(reading.voices, 'ar');
  const english = voicesFor(reading.voices, 'en');
  const busy = reading.active;
  const quality = { premium: t('readAloud.premium'), enhanced: t('readAloud.enhanced'), natural: t('readAloud.natural') };
  // Apple's engine reads with whatever voices are downloaded; with only the
  // basic ones, the way to a natural voice is one click away.
  const basic = reading.engine === 'apple' && reading.voices.length > 0 && (onlyBasicVoice(reading.voices, 'ar') || onlyBasicVoice(reading.voices, 'en'));
  // On Windows the app has natural voices of its own, downloaded in the settings.
  const noNatural = reading.engine === 'neural' && !arabic.some((voice) => voice.natural);

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
              {voiceLabel(voice, quality)}
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
              {voiceLabel(voice, quality)}
            </option>
          ))}
        </select>
      </label>
      {basic ? (
        <span title={t('readAloud.betterVoiceHint')}>
          <IconButton label={t('readAloud.betterVoice')} icon={<Icon of={Sparkles} />} showLabel onClick={openVoiceSettings} />
        </span>
      ) : noNatural ? (
        <span title={t('readAloud.naturalHint')}>
          <IconButton
            label={t('readAloud.betterVoice')}
            icon={<Icon of={Sparkles} />}
            showLabel
            onClick={() => openSettingsAt('ai', () => dispatch({ type: 'DIALOG', dialog: 'settings' }))}
          />
        </span>
      ) : null}
      <span className="readaloud-status" role="status">
        {recognizing
          ? t('readAloud.recognizing', { page: Math.max(1, ocr.page), of: Math.max(1, ocr.of) })
          : ocr === 'failed'
            ? t('readAloud.ocrFailed')
            : ocr === 'none'
              ? t('readAloud.ocrNone')
              : busy && reading.page !== null
                ? t('readAloud.reading', { page: reading.page })
                : reading.notice
                  ? t(NOTICE[reading.notice])
                  : ''}
      </span>
      {reading.notice === 'noText' && !busy && ocr === null && reading.scope !== 'selection' ? (
        <IconButton label={t('readAloud.ocrThenRead')} icon={<Icon of={ScanText} />} showLabel onClick={() => void recognize()} />
      ) : null}
      <IconButton label={t('readAloud.close')} icon={<Icon of={X} />} onClick={closeBar} />
    </div>
  );
}
