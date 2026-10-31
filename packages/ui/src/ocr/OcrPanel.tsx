import { useEffect, useRef, useState } from 'react';
import { CircleStop, Eye, ScanText } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useT } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import type { OcrOutcome } from '../state/AppContext';
import { drawRgba } from '../viewer/useRenderedCanvas';
import type { RenderedPageData } from '../core/types';
import { CLEANUP_STEPS, anyCleanup, cleanUp } from './cleanup';
import type { CleanupStep } from './cleanup';
import { OCR_LANGUAGES } from './engine';
import type { OcrLanguage } from './engine';
import { readOcrOptions, writeOcrOptions } from './run';
import type { OcrProgress, OcrScope, ReadOptions } from './run';
import './ocr.css';
import { OpenFirst } from '../tools/OpenFirst';

const LANGUAGE_NAMES: Record<OcrLanguage, TKey> = {
  ara: 'ocr.lang.ara',
  eng: 'ocr.lang.eng',
  fas: 'ocr.lang.fas',
  urd: 'ocr.lang.urd',
};

const STEP_NAMES: Record<CleanupStep, { label: TKey; note: TKey }> = {
  background: { label: 'ocr.cleanup.background', note: 'ocr.cleanup.backgroundNote' },
  contrast: { label: 'ocr.cleanup.contrast', note: 'ocr.cleanup.contrastNote' },
  binarize: { label: 'ocr.cleanup.binarize', note: 'ocr.cleanup.binarizeNote' },
  despeckle: { label: 'ocr.cleanup.despeckle', note: 'ocr.cleanup.despeckleNote' },
  borders: { label: 'ocr.cleanup.borders', note: 'ocr.cleanup.bordersNote' },
};

/** The preview is drawn at this resolution: enough to judge, quick to clean. */
const PREVIEW_DPI = 100;

/**
 * Scan & OCR: pages that are pictures of text get a text layer. Tesseract
 * reads each page where it is — nothing is sent anywhere — and Warraq's core
 * writes what it read into the file as invisible text over the words, so the
 * page looks as it did and can be searched, selected and copied. A scan can
 * be cleaned up first (`cleanup.ts`), and the cleaned picture put in its place.
 */
export function OcrPanel() {
  const t = useT();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const [languages, setLanguages] = useState<OcrLanguage[]>(['ara', 'eng']);
  const [scope, setScope] = useState<OcrScope>('blank');
  const [options, setOptions] = useState<ReadOptions>(readOcrOptions);
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const [outcome, setOutcome] = useState<OcrOutcome | null>(null);
  const [preview, setPreview] = useState<{ page: number; pixels: RenderedPageData } | 'failed' | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const running = progress !== null;
  const stopper = useRef<AbortController | null>(null);
  // Stop pressed: the page being read is finished first, and the button says so.
  const [stopping, setStopping] = useState(false);
  // The file it was reading went away (closed, or another tab chosen).
  const [gone, setGone] = useState(false);
  // Another document on screen, or none: the reading stops there.
  const documentId = state.document?.id ?? null;
  useEffect(() => () => stopper.current?.abort(), [documentId]);
  const ready = state.view === 'viewer' && state.document !== null && state.switching === null;
  const cleaning = anyCleanup(options.cleanup);

  useEffect(() => writeOcrOptions(options), [options]);
  // Drawn once the canvas is in the panel.
  useEffect(() => {
    if (preview && preview !== 'failed' && previewRef.current) drawRgba(previewRef.current, preview.pixels);
  }, [preview]);

  const toggle = (code: OcrLanguage) =>
    setLanguages((list) => (list.includes(code) ? list.filter((c) => c !== code) : [...list, code]));

  const toggleStep = (step: CleanupStep) => {
    setPreview(null);
    setOptions((current) => ({ ...current, cleanup: { ...current.cleanup, [step]: !current.cleanup[step] } }));
  };

  const run = async () => {
    setOutcome(null);
    setGone(false);
    setStopping(false);
    setProgress({ page: 0, of: 0 });
    stopper.current = new AbortController();
    try {
      setOutcome(await services.recognizeText(languages, scope, setProgress, stopper.current.signal, {
        cleanup: options.cleanup,
        replaceImage: options.replaceImage && cleaning,
      }));
    } catch (error) {
      if (String(error instanceof Error ? error.message : error).startsWith('E_DOCUMENT_GONE')) setGone(true);
      else dispatch({ type: 'DOCUMENT_FAILED', error: 'ocr.failed' });
    } finally {
      setProgress(null);
      setStopping(false);
      stopper.current = null;
    }
  };

  // The page on screen, cleaned up as chosen, drawn small in the panel.
  const showPreview = async () => {
    const page = state.currentPage;
    try {
      const bytes = await services.currentFileBytes();
      if (!bytes) throw new Error('E_NOT_FOUND: no open file');
      const doc = await services.client.open(bytes, services.documentPassword);
      try {
        const render = await doc.render_page(page - 1, PREVIEW_DPI / 72);
        cleanUp(render, options.cleanup, PREVIEW_DPI);
        setPreview({ page, pixels: render });
      } finally {
        void doc.free();
      }
    } catch {
      setPreview('failed');
    }
  };

  return (
    <div className="tool-panel">
      <h3>
        <Icon of={ScanText} />
        {t('tool.ocr')}
      </h3>
      {state.document === null && <OpenFirst />}
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
      <fieldset className="compress-levels" disabled={!ready || running}>
        <legend>{t('ocr.cleanup')}</legend>
        {CLEANUP_STEPS.map((step) => (
          <label key={step} className="compress-level">
            <input type="checkbox" checked={options.cleanup[step]} onChange={() => toggleStep(step)} />
            <span>
              <strong>{t(STEP_NAMES[step].label)}</strong>
              <span className="compress-level-note">{t(STEP_NAMES[step].note)}</span>
            </span>
          </label>
        ))}
        <label className="compress-level">
          <input
            type="checkbox"
            className="switch"
            checked={options.replaceImage && cleaning}
            disabled={!cleaning}
            onChange={(event) => setOptions((current) => ({ ...current, replaceImage: event.target.checked }))}
          />
          <span>
            <strong>{t('ocr.replaceImage')}</strong>
            <span className="compress-level-note">{t('ocr.replaceImageNote')}</span>
          </span>
        </label>
      </fieldset>
      {cleaning && (
        <div className="tool-actions">
          <IconButton
            label={t('ocr.preview', { page: state.currentPage })}
            icon={<Icon of={Eye} />}
            showLabel
            disabled={!ready || running}
            onClick={() => void showPreview()}
          />
        </div>
      )}
      {preview === 'failed' && (
        <p className="field-error" role="alert">
          {t('ocr.previewFailed')}
        </p>
      )}
      {preview && preview !== 'failed' && cleaning && (
        <canvas
          ref={previewRef}
          className="ocr-preview"
          role="img"
          aria-label={t('ocr.previewAlt', { page: preview.page })}
        />
      )}
      <div className="tool-actions">
        {running ? (
          <IconButton
            label={t(stopping ? 'ocr.stopping' : 'ocr.stop')}
            icon={<Icon of={CircleStop} />}
            showLabel
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              stopper.current?.abort();
            }}
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
      {gone && (
        <p className="tool-panel-note" role="status">
          {t('ocr.gone')}
        </p>
      )}
      {outcome && (
        <div role="status">
          <p className="tool-panel-note">
            {outcome.stopped
              ? outcome.pages === 0
                ? t('ocr.stoppedNothing')
                : t('ocr.stoppedKept', { pages: outcome.pages, words: outcome.words })
              : outcome.pages === 0
                ? outcome.skipped > 0
                  ? t('ocr.alreadyDone')
                  : (outcome.tried ?? 0) > 0
                    ? t('ocr.noWords', { count: outcome.tried ?? 0 })
                    : t('ocr.nothing')
                : t('ocr.done', { pages: outcome.pages, words: outcome.words, confidence: Math.round(outcome.confidence) })}
          </p>
          {(outcome.images ?? 0) > 0 && <p className="tool-panel-note">{t('ocr.imagesReplaced', { count: outcome.images ?? 0 })}</p>}
          {(outcome.imagesKept ?? 0) > 0 && <p className="tool-panel-note">{t('ocr.imagesKept', { count: outcome.imagesKept ?? 0 })}</p>}
        </div>
      )}
      <p className="tool-panel-note">{t('ocr.note')}</p>
    </div>
  );
}
