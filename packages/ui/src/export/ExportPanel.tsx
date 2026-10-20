import { useId, useState } from 'react';
import { Download, FileOutput } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useT } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { saveBytes } from '../state/saveFile';
import { DEFAULT_RESOLUTION, EXPORT_FORMATS, RESOLUTIONS } from './formats';
import type { ExportFormat } from './formats';
import { exportCurrentFile } from './runExport';
import type { SlideMode, WordMode } from './runExport';
import type { SheetMode } from './tables';
import './export.css';

type Outcome = { kind: 'done'; name: string; reduced: boolean } | { kind: 'noText' };

/**
 * Export: the document's content in another format, with Arabic in reading
 * order. The text is Warraq's core's, read from the file as it stands now
 * (`exportCurrentFile`), so what was redacted stays out of every export.
 */
export function ExportPanel() {
  const t = useT();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const id = useId();
  const [format, setFormat] = useState<ExportFormat>('docx');
  const [dpi, setDpi] = useState<number>(DEFAULT_RESOLUTION);
  const [sheets, setSheets] = useState<SheetMode>('page');
  const [slides, setSlides] = useState<SlideMode>('picture');
  const [words, setWords] = useState<WordMode>('layout');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Set when this copy needs a password the app does not have: one set in Protect.
  const [locked, setLocked] = useState<{ wrong: boolean } | null>(null);
  const [password, setPassword] = useState('');
  // A different file starts afresh: no password asked for, nothing exported yet.
  const documentId = state.document?.id ?? null;
  const [shownFor, setShownFor] = useState(documentId);
  if (shownFor !== documentId) {
    setShownFor(documentId);
    setLocked(null);
    setPassword('');
    setOutcome(null);
  }
  const running = progress !== null;
  const ready = state.view === 'viewer' && state.document !== null && state.switching === null && !running;

  const run = async (given?: string) => {
    const name = state.document?.name;
    if (!name || running) return;
    setOutcome(null);
    setProgress({ done: 0, total: state.document?.pageCount ?? 0 });
    try {
      const result = await exportCurrentFile(
        services,
        {
          format,
          dpi,
          sheets,
          slides,
          words,
          name,
          pageLabel: (page) => t('viewer.page', { page }),
          tableLabel: (n) => t('export.tableLabel', { n }),
          pagesWord: t('export.pagesWord'),
          onProgress: (done, total) => setProgress({ done, total }),
        },
        given ?? services.documentPassword,
      );
      setLocked(null);
      if (!result) {
        setOutcome({ kind: 'noText' });
        return;
      }
      if (await saveBytes(result.bytes, result.fileName, result.kind)) {
        setOutcome({ kind: 'done', name: result.fileName, reduced: result.reduced });
      }
    } catch (error) {
      if ((error as { code?: string } | null)?.code === 'E_PASSWORD') {
        setLocked({ wrong: given !== undefined });
        return;
      }
      dispatch({ type: 'DOCUMENT_FAILED', error: 'export.failed' });
    } finally {
      setProgress(null);
    }
  };

  const status = progress
    ? t('export.progress', { page: Math.min(progress.done + 1, progress.total), total: progress.total })
    : outcome?.kind === 'done'
      ? t('export.done', { name: outcome.name })
      : '';

  return (
    <div className="tool-panel">
      <h3>
        <Icon of={FileOutput} />
        {t('tool.export')}
      </h3>
      {state.document === null && <p className="tool-panel-note">{t('tool.openFirst')}</p>}
      <p className="tool-panel-note">{t('export.intro')}</p>
      <fieldset className="export-formats" disabled={running}>
        <legend>{t('export.format')}</legend>
        {EXPORT_FORMATS.map((info) => (
          <label key={info.id} className="export-format">
            <input
              type="radio"
              name={`${id}-format`}
              value={info.id}
              checked={format === info.id}
              onChange={() => setFormat(info.id)}
              aria-labelledby={`${id}-${info.id}`}
              aria-describedby={`${id}-${info.id}-note`}
            />
            <span id={`${id}-${info.id}`} className="export-format-name">
              {t(info.labelKey)}
            </span>
            <span id={`${id}-${info.id}-note`} className="export-format-note">
              {t(info.noteKey)}
            </span>
          </label>
        ))}
      </fieldset>
      {format === 'png' && (
        <label className="export-resolution">
          <span>{t('export.resolution')}</span>
          <select className="select" value={dpi} disabled={running} onChange={(event) => setDpi(Number(event.target.value))}>
            {RESOLUTIONS.map((value) => (
              <option key={value} value={value}>
                {t('export.dpi', { dpi: value })}
              </option>
            ))}
          </select>
        </label>
      )}
      {format === 'xlsx' && (
        <label className="export-resolution">
          <span>{t('export.sheets')}</span>
          <select className="select" value={sheets} disabled={running} onChange={(event) => setSheets(event.target.value as SheetMode)}>
            <option value="page">{t('export.sheetsPage')}</option>
            <option value="table">{t('export.sheetsTable')}</option>
          </select>
        </label>
      )}
      {format === 'docx' && (
        <label className="export-resolution">
          <span>{t('export.words')}</span>
          <select className="select" value={words} disabled={running} onChange={(event) => setWords(event.target.value as WordMode)}>
            <option value="layout">{t('export.wordsLayout')}</option>
            <option value="text">{t('export.wordsText')}</option>
          </select>
        </label>
      )}
      {format === 'pptx' && (
        <label className="export-resolution">
          <span>{t('export.slides')}</span>
          <select className="select" value={slides} disabled={running} onChange={(event) => setSlides(event.target.value as SlideMode)}>
            <option value="picture">{t('export.slidesPicture')}</option>
            <option value="text">{t('export.slidesText')}</option>
          </select>
        </label>
      )}
      {locked && (
        <form
          className="export-unlock"
          onSubmit={(event) => {
            event.preventDefault();
            if (password.length > 0) void run(password);
          }}
        >
          <p className="tool-panel-note">{t('export.password')}</p>
          <label className="field">
            <span>{t('password.label')}</span>
            <input
              className="text-input"
              type="password"
              dir="auto"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {locked.wrong && (
            <p className="field-error" role="alert">
              {t('password.wrong')}
            </p>
          )}
        </form>
      )}
      <div className="tool-actions">
        <IconButton
          label={t('export.go')}
          icon={<Icon of={Download} />}
          showLabel
          variant="primary"
          disabled={!ready || (locked !== null && password.length === 0)}
          onClick={() => void run(locked ? password : undefined)}
        />
      </div>
      <p className="tool-panel-note" role="status">
        {status}
      </p>
      {outcome?.kind === 'done' && outcome.reduced && <p className="tool-panel-note">{t('export.reduced')}</p>}
      {outcome?.kind === 'noText' && (
        <p className="export-alert" role="alert">
          {t('export.noText')}
        </p>
      )}
      {services.pendingRedactions > 0 && <p className="export-alert">{t('export.pendingRedactions')}</p>}
    </div>
  );
}
