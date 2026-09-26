/** Export sheet: format gallery, page range (any digits), export through the engine, save via the host. */
import { useId, useState } from 'react';
import { useApp } from '../services/AppContext';
import type { OpenDocument } from '../services/state';
import { EXPORT_FORMATS, parsePageRange, runExport, type ExportFormatId } from '../services/exporter';
import type { ViewerApi } from '../viewer/Viewer';
import { Sheet, Tile } from './primitives';

/** Pixels per PDF point for picture export (144 dpi). */
const PNG_SCALE = 2;

export function ExportSheet({ doc, api, onClose }: { doc: OpenDocument; api: ViewerApi | null; onClose: () => void }) {
  const app = useApp();
  const { t } = app;
  const [format, setFormat] = useState<ExportFormatId>('docx');
  const [scope, setScope] = useState<'all' | 'range'>('all');
  const [range, setRange] = useState('');
  const [busy, setBusy] = useState(false);
  const rangeId = useId();
  const total = doc.pageCount || api?.pageCount() || 0;
  const pages = scope === 'all' ? parsePageRange('', total) : parsePageRange(range, total);
  const invalid = scope === 'range' && (!range.trim() || pages === null);

  const run = async () => {
    if (!pages || busy) return;
    setBusy(true);
    try {
      const bytes = await app.currentBytes(doc.id);
      const sizes = api?.pageSizes() ?? [];
      const out = await runExport({
        engine: app.engine(),
        bytes,
        name: doc.name,
        format,
        pages,
        title: doc.name.replace(/\.pdf$/i, ''),
        sheetNames: { table: t('export.sheet.table'), text: t('export.sheet.text') },
        renderPage: async (p) => {
          if (!api) throw new Error('viewer not ready');
          const width = Math.min(4000, Math.round((sizes[p]?.width ?? 612) * PNG_SCALE));
          return new Uint8Array(await (await api.renderPage(p, width)).arrayBuffer());
        },
      });
      const saved = await app.host.saveFile(out.name, out.bytes, { saveAs: true });
      if (saved) {
        app.toast(t('export.done', { name: saved.name }), 'success');
        onClose();
      }
    } catch (e) {
      const reason = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
      app.toast(t('export.failed', { reason }), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={t('export.title')}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={busy || invalid || !pages} data-testid="export-run">
            {busy && <span className="spinner spinner-sm" aria-hidden="true" />}
            {busy ? t('export.running') : t('export.run')}
          </button>
        </>
      }
    >
      <p className="sheet-sub">{t('export.subtitle')}</p>
      <div className="format-gallery" role="radiogroup" aria-label={t('export.format')} data-testid="export-formats">
        {EXPORT_FORMATS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={format === f.id}
            className={`format-card${format === f.id ? ' on' : ''}`}
            data-format={f.id}
            onClick={() => setFormat(f.id)}
          >
            <Tile icon={f.icon} colour={f.id === 'xlsx' ? 'green' : f.id === 'pptx' ? 'orange' : f.id === 'png' ? 'pink' : f.id === 'docx' ? 'blue' : 'graphite'} size="md" />
            <span className="format-name">{t(f.nameKey)}</span>
            <span className="format-desc">{t(f.descKey)}</span>
          </button>
        ))}
      </div>
      <fieldset className="field">
        <legend>{t('export.pages')}</legend>
        <div className="segmented" role="radiogroup" aria-label={t('export.pages')}>
          <button type="button" role="radio" aria-checked={scope === 'all'} className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')} data-scope="all">
            {t('export.pages.all', { count: total })}
          </button>
          <button type="button" role="radio" aria-checked={scope === 'range'} className={scope === 'range' ? 'on' : ''} onClick={() => setScope('range')} data-scope="range">
            {t('export.pages.range')}
          </button>
        </div>
        {scope === 'range' && (
          <>
            <label htmlFor={rangeId} className="visually-hidden">
              {t('export.pages.range')}
            </label>
            <input
              id={rangeId}
              className="text-input"
              inputMode="numeric"
              dir="auto"
              value={range}
              placeholder={t('export.pages.placeholder')}
              onChange={(e) => setRange(e.target.value)}
              aria-invalid={invalid && range.trim() ? true : undefined}
              data-testid="export-range"
              autoFocus
            />
            {invalid && range.trim() && (
              <p className="field-error" role="alert">
                {t('export.pages.invalid', { total })}
              </p>
            )}
          </>
        )}
      </fieldset>
      <p className="fineprint">{format === 'png' ? t('export.note.png') : t('export.note.local')}</p>
    </Sheet>
  );
}
