import { useEffect, useRef, useState } from 'react';
import { Pause, Play, ScanText, Sparkles, Square, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { openSettingsAt } from '../settings/SettingsWindow';
import { readOcrOptions } from '../ocr/run';
import type { OcrProgress } from '../ocr/run';
import { closeBar, documentChanged, pause, refreshVoices, resume, setRate, setSleep, setVoice, SLEEP_MINUTES, start, stop, useReadAloud } from './readAloud';
import type { Scope } from './readAloud';
import { readingSource } from './readingSource';
import { voiceLabel, voicesFor } from './voices';
import './speech.css';

const RATES = [0.75, 1, 1.25, 1.5, 2, 2.5, 3];

const NOTICE: Record<NonNullable<ReturnType<typeof useReadAloud>['notice']>, TKey> = {
  unsupported: 'readAloud.unsupported',
  noVoices: 'readAloud.noVoices',
  speechFailed: 'readAloud.speechFailed',
  noText: 'readAloud.noText',
  noSelection: 'readAloud.noSelection',
  done: 'readAloud.done',
  slept: 'readAloud.slept',
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

  // Another document: the reading and its message were about the one before
  // (the message stayed on screen over the next file, First Five, Abu Fahad).
  const documentId = state.document?.id ?? null;
  const shownFor = useRef(documentId);
  useEffect(() => {
    if (shownFor.current === documentId) return;
    shownFor.current = documentId;
    documentChanged();
    setOcr((now) => (now === 'failed' || now === 'none' ? null : now));
  }, [documentId]);

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
  // The desktop app has natural voices of its own, downloaded once in the
  // settings; until then the way to them is one click away.
  const noNatural = (reading.engine === 'neural' || reading.engine === 'apple') && reading.voices.length > 0 && !reading.voices.some((voice) => voice.natural);

  return (
    <div className="readaloud" role="region" aria-label={t('readAloud.label')}>
      <div className="readaloud-scope" role="group" aria-label={t('readAloud.what')}>
        {/* Pressed while it reads, not disabled: a disabled button drops the
            keyboard focus, which went nowhere (First Five, Abu Fahad). */}
        {(['page', 'document', 'selection'] as const).map((scope) => {
          const now = busy && !reading.paused && reading.scope === scope;
          return (
            <IconButton
              key={scope}
              label={t(`readAloud.${scope}`)}
              icon={<Icon of={Play} />}
              showLabel
              pressed={now}
              onClick={() => {
                if (!now) void begin(scope);
              }}
            />
          );
        })}
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
        <span>{t('readAloud.sleep')}</span>
        <select
          className="select"
          value={reading.sleep === null ? '' : String(reading.sleep)}
          onChange={(event) => setSleep(event.target.value ? Number(event.target.value) : null)}
        >
          <option value="">{t('readAloud.sleepOff')}</option>
          {SLEEP_MINUTES.map((minutes) => (
            <option key={minutes} value={String(minutes)}>
              {t(minutes <= 10 ? 'readAloud.sleepMinutesFew' : 'readAloud.sleepMinutes', { count: minutes })}
            </option>
          ))}
        </select>
      </label>
      <label className="readaloud-field">
        <span>{t('readAloud.voiceAr')}</span>
        <select className="select" value={reading.voiceAr ?? ''} onChange={(event) => setVoice('ar', event.target.value || null)}>
          <option value="">{t(arabic.length === 0 && reading.engine !== null ? 'readAloud.noneInstalled' : 'readAloud.auto')}</option>
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
          <option value="">{t(english.length === 0 && reading.engine !== null ? 'readAloud.noneInstalled' : 'readAloud.auto')}</option>
          {english.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voiceLabel(voice, quality)}
            </option>
          ))}
        </select>
      </label>
      {noNatural ? (
        <span title={t('readAloud.naturalHint')}>
          <IconButton
            label={t('readAloud.betterVoice')}
            icon={<Icon of={Sparkles} />}
            showLabel
            onClick={() => openSettingsAt('ai', () => dispatch({ type: 'DIALOG', dialog: 'settings' }))}
          />
        </span>
      ) : null}
      {/* A problem (no voice, nothing to read) on a line of its own, in the
          label colour: as small grey text squeezed at the end of the bar it
          was easy to miss (First Five, Abu Fahad). */}
      <span
        className={[
          'readaloud-status',
          !recognizing && (ocr === 'failed' || ocr === 'none' || (!busy && reading.notice !== null && reading.notice !== 'done' && reading.notice !== 'slept')) && 'is-problem',
        ]
          .filter(Boolean)
          .join(' ')}
        role="status"
      >
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
