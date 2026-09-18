import { useRef, useState } from 'react';
import { ScanText, Square } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useT } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import type { OcrOutcome } from '../state/AppContext';
import { OCR_LANGUAGES } from './engine';
import type { OcrLanguage } from './engine';
import type { OcrProgress, OcrScope } from './run';

const LANGUAGE_NAMES: Record<OcrLanguage, TKey> = {
  ara: 'ocr.lang.ara',
  eng: 'ocr.lang.eng',
  fas: 'ocr.lang.fas',
  urd: 'ocr.lang.urd',
};

/**
 * Scan & OCR: pages that are pictures of text get a text layer. Tesseract
 * reads each page where it is — nothing is sent anywhere — and Warraq's core
 * writes what it read into the file as invisible text over the words, so the
 * page looks as it did and can be searched, selected and copied.
 */
export function OcrPanel() {
  const t = useT();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const [languages, setLanguages] = useState<OcrLanguage[]>(['ara', 'eng']);
  const [scope, setScope] = useState<OcrScope>('blank');
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const [outcome, setOutcome] = useState<OcrOutcome | null>(null);
  const running = progress !== null;
  const stopper = useRef<AbortController | null>(null);
  const ready = state.view === 'viewer' && state.document !== null && state.switching === null;

  const toggle = (code: OcrLanguage) =>
    setLanguages((list) => (list.includes(code) ? list.filter((c) => c !== code) : [...list, code]));

  const run = async () => {
    setOutcome(null);
    setProgress({ page: 0, of: 0 });
    stopper.current = new AbortController();
    try {
      setOutcome(await services.recognizeText(languages, scope, setProgress, stopper.current.signal));
    } catch {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'ocr.failed' });
    } finally {
      setProgress(null);
      stopper.current = null;
    }
  };

  return (
    <div className="tool-panel">
      <h3>
        <Icon of={ScanText} />
        {t('tool.ocr')}
      </h3>
      {state.document === null && <p className="tool-panel-note">{t('tool.openFirst')}</p>}
      <fieldset className="compress-levels" disabled={!ready || running}>
        <legend>{t('ocr.languages')}</legend>
        {OCR_LANGUAGES.map((code) => (
          <label key={code} className="compress-level">
            <input type="checkbox" checked={languages.includes(code)} onChange={() => toggle(code)} />
            <span>{t(LANGUAGE_NAMES[code])}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="compress-levels" disabled={!ready || running}>
        <legend>{t('ocr.pages')}</legend>
        <label className="compress-level">
          <input type="radio" name="ocr-scope" checked={scope === 'blank'} onChange={() => setScope('blank')} />
          <span>{t('ocr.scopeBlank')}</span>
        </label>
        <label className="compress-level">
          <input type="radio" name="ocr-scope" checked={scope === 'all'} onChange={() => setScope('all')} />
          <span>{t('ocr.scopeAll')}</span>
        </label>
      </fieldset>
      <div className="tool-actions">
        {running ? (
          <IconButton
            label={t('ocr.stop')}
            icon={<Icon of={Square} />}
            showLabel
            onClick={() => stopper.current?.abort()}
          />
        ) : (
          <IconButton
            label={t('ocr.go')}
            icon={<Icon of={ScanText} />}
            showLabel
            variant="primary"
            disabled={!ready || languages.length === 0}
            onClick={() => void run()}
          />
        )}
      </div>
      {running && (
        <p className="tool-panel-note" role="status">
          {progress.of === 0 ? t('ocr.preparing') : t('ocr.progress', { page: progress.page, of: progress.of })}
        </p>
      )}
      {outcome && (
        <p className="tool-panel-note" role="status">
          {outcome.pages === 0
            ? outcome.skipped > 0
              ? t('ocr.alreadyDone')
              : t('ocr.nothing')
            : t('ocr.done', { pages: outcome.pages, words: outcome.words, confidence: Math.round(outcome.confidence) })}
        </p>
      )}
      <p className="tool-panel-note">{t('ocr.note')}</p>
    </div>
  );
}
