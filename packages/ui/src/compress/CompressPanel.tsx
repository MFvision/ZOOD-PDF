import { useState } from 'react';
import { FileDown, FolderOpen, Minimize2 } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useI18n } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import type { CompressResult } from '../state/AppContext';
import { compressedFileName } from '../state/saveFile';
import { COMPRESS_LEVELS } from './levels';
import type { CompressLevel } from './levels';
import './compress.css';
import { OpenFirst } from '../tools/OpenFirst';

/** The three choices, from none of the images touched to the smallest file. */
const LEVELS = COMPRESS_LEVELS;
type Level = CompressLevel;

/** Bytes as a person reads them: 870 KB, 12.4 MB. */
export function formatSize(bytes: number, lang: string): string {
  const units = lang === 'ar' ? ['بايت', 'كيلوبايت', 'ميغابايت'] : ['bytes', 'KB', 'MB'];
  if (bytes < 1024) return `${bytes} ${units[0]}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} ${units[1]}`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} ${units[2]}`;
}

/**
 * Compress: a smaller copy of the file as it stands now, written from scratch
 * by Warraq's core (`compress.file`) — unused objects dropped, duplicates
 * shared, everything recompressed, and, only if chosen, images larger than
 * any page needs downsampled. The open file is not changed; the copy is saved
 * beside it or opened in its place.
 */
export function CompressPanel() {
  const { t, lang } = useI18n();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const [level, setLevel] = useState<Level>('balanced');
  const [busy, setBusy] = useState(false);
  // The smaller copy, with the document it was made from: shown and saved
  // for that document only. Kept bare, it stayed on screen when another tab
  // was chosen, and "Save the smaller copy" saved the first file's pages
  // under the second one's name (break-zood, files-ui).
  const [made, setMade] = useState<{ documentId: number; name: string; result: CompressResult } | null>(null);
  const documentId = state.document?.id ?? null;
  const result = made && made.documentId === documentId ? made.result : null;
  const name = made?.name ?? state.document?.name ?? 'document.pdf';
  const ready = state.view === 'viewer' && state.document !== null && !busy && state.switching === null;

  const run = async () => {
    const from = state.document;
    if (!from) return;
    setBusy(true);
    setMade(null);
    try {
      const result = await services.compressFile(LEVELS[level]);
      setMade({ documentId: from.id, name: from.name, result });
    } catch {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'compress.failed' });
    } finally {
      setBusy(false);
    }
  };

  const done = result && 'bytes' in result ? result : null;
  const saved = done ? Math.max(0, Math.round((1 - done.after / done.before) * 100)) : 0;

  return (
    <div className="tool-panel">
      <h3>
        <Icon of={Minimize2} />
        {t('tool.compress')}
      </h3>
      {state.document === null && <OpenFirst />}
      <fieldset className="compress-levels" disabled={!ready}>
        <legend>{t('compress.level')}</legend>
        {(Object.keys(LEVELS) as Level[]).map((key) => (
          <label key={key} className="compress-level">
            <input type="radio" name="compress-level" value={key} checked={level === key} onChange={() => setLevel(key)} />
            <span>
              <strong>{t(`compress.${key}` as const)}</strong>
              <span className="compress-level-note">{t(`compress.${key}Note` as const)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="tool-actions">
        <IconButton
          label={busy ? t('compress.working') : t('compress.go')}
          icon={<Icon of={Minimize2} />}
          showLabel
          variant="primary"
          disabled={!ready}
          onClick={() => void run()}
        />
      </div>
      {result && 'refused' in result && (
        <p className="field-error" role="alert">
          {t(result.refused === 'protected' ? 'compress.refusedProtected' : 'compress.refusedSigned')}
        </p>
      )}
      {done && (
        <div className="compress-result" role="status">
          {done.unchanged ? (
            <p>{t('compress.unchanged')}</p>
          ) : (
            <>
              {/* The number first, large; what it means, small, after it. */}
              <p className="compress-metric">
                <span className="compress-metric-value">{t('compress.percent', { percent: saved })}</span>{' '}
                <span className="compress-metric-label">{t('compress.smaller')}</span>
              </p>
              <p className="compress-sizes">{t('compress.beforeAfter', { before: formatSize(done.before, lang), after: formatSize(done.after, lang) })}</p>
              {done.images > 0 && <p className="tool-panel-note">{t('compress.images', { count: done.images })}</p>}
              <div className="tool-actions">
                <IconButton
                  label={t('compress.save')}
                  icon={<Icon of={FileDown} />}
                  showLabel
                  onClick={() => void services.saveCopy(done.bytes, compressedFileName(name, t('compress.fileWord')))}
                />
                <IconButton
                  label={t('compress.open')}
                  icon={<Icon of={FolderOpen} />}
                  showLabel
                  onClick={() => {
                    dispatch({ type: 'SET_ACTIVE_TOOL', tool: null });
                    void services.openFile(new File([done.bytes], compressedFileName(name, t('compress.fileWord')), { type: 'application/pdf' }), undefined, { unsaved: true });
                  }}
                />
              </div>
            </>
          )}
        </div>
      )}
      <p className="tool-panel-note">{t('compress.note')}</p>
    </div>
  );
}
