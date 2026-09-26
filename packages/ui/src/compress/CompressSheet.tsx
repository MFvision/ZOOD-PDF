/**
 * Compress: `doc.compress` makes a NEW file (whole rewrite with object streams, recompressed
 * pictures…). The open document is never replaced: the user saves the copy or opens it.
 */
import { useState } from 'react';
import { useApp } from '../services/AppContext';
import type { OpenDocument } from '../services/state';
import { formatBytes, formatNumber, type MessageKey } from '../i18n';
import { Sheet } from '../app/primitives';
import { baseName, errorText } from '../organize/errors';

type Preset = 'high' | 'balanced' | 'smallest';

interface Report {
  before: number;
  after: number;
  images: { recompressed: number; unchanged: number; skipped: { reason: string; count: number }[] };
}

const REASONS: Record<string, MessageKey> = {
  mask: 'compress.reason.mask',
  'decode array': 'compress.reason.decode',
  'too large': 'compress.reason.large',
  'colour space': 'compress.reason.colour',
  filter: 'compress.reason.filter',
  'bit depth': 'compress.reason.depth',
  corrupt: 'compress.reason.corrupt',
  encoder: 'compress.reason.encoder',
};

export function CompressSheet({ doc, onClose }: { doc: OpenDocument; onClose: () => void }) {
  const app = useApp();
  const { t } = app;
  const locale = app.state.locale;
  const [preset, setPreset] = useState<Preset>('balanced');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ report: Report; bytes: Uint8Array; preset: Preset } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await app.runOnDocument<Report>(doc.id, [{ method: 'doc.compress', params: { preset } }]);
      if (!res.bytes) throw new Error('no output');
      setResult({ report: res.json, bytes: res.bytes, preset });
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  const name = t('compress.fileName', { name: baseName(doc.name) });
  const r = result?.report;
  const smaller = r ? r.after < r.before : false;
  const percent = r && r.before > 0 ? Math.round((1 - r.after / r.before) * 100) : 0;
  const skipped = r?.images.skipped
    .map((s) => (REASONS[s.reason] ? t(REASONS[s.reason]!, { count: s.count }) : null))
    .filter((s): s is string => !!s)
    .join(locale === 'ar' ? '، ' : ', ');

  const presets: Preset[] = ['high', 'balanced', 'smallest'];
  return (
    <Sheet
      title={t('compress.title')}
      onClose={onClose}
      footer={
        result && result.preset === preset ? (
          <>
            <button type="button" className="btn" onClick={onClose}>
              {t('common.close')}
            </button>
            <button type="button" className="btn" data-action="open-copy" disabled={!smaller} onClick={() => void app.openNewDocument(name, result.bytes).then(onClose)}>
              {t('compress.openCopy')}
            </button>
            <button type="button" className="btn btn-primary" data-action="save-copy" disabled={!smaller} onClick={() => void app.saveNewFile(name, result.bytes)}>
              {t('compress.saveCopy')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-primary" data-action="run-compress" disabled={busy} onClick={() => void run()}>
              {busy ? t('compress.working') : t('compress.run')}
            </button>
          </>
        )
      }
    >
      <p className="sheet-sub">{t('compress.subtitle')}</p>
      <div className="preset-list" role="radiogroup" aria-label={t('compress.preset')}>
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={preset === p}
            className={`preset${preset === p ? ' on' : ''}`}
            data-preset={p}
            disabled={busy}
            onClick={() => setPreset(p)}
          >
            <span className="preset-name">{t(`compress.preset.${p}`)}</span>
            <span className="preset-desc">{t(`compress.preset.${p}.desc`)}</span>
          </button>
        ))}
      </div>
      {r && result?.preset === preset && (
        <div className="compress-result" data-testid="compress-result" aria-live="polite">
          <dl className="props">
            <dt>{t('compress.before')}</dt>
            <dd data-testid="size-before">{formatBytes(r.before, locale)}</dd>
            <dt>{t('compress.after')}</dt>
            <dd data-testid="size-after">{formatBytes(r.after, locale)}</dd>
          </dl>
          <p className="compress-headline">{smaller ? t('compress.smaller', { percent: formatNumber(percent, locale) }) : t('compress.notSmaller')}</p>
          <p className="fineprint">{t('compress.images', { count: r.images.recompressed })}</p>
          {skipped && <p className="fineprint">{t('compress.skipped', { list: skipped })}</p>}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}
