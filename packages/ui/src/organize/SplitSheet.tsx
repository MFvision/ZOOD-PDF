/** Split: every N pages, by typed ranges («١-٣، ٥»), or by top-level bookmarks → one ZIP of PDFs. */
import { useMemo, useState } from 'react';
import { useApp } from '../services/AppContext';
import type { OpenDocument } from '../services/state';
import { Sheet } from '../app/primitives';
import { parseRanges } from '../services/ranges';
import { zipStore } from '../services/zip';
import { baseName, errorText } from './errors';

type Mode = 'every' | 'ranges' | 'bookmarks';

export function SplitSheet({ doc, onClose }: { doc: OpenDocument; onClose: () => void }) {
  const app = useApp();
  const { t } = app;
  const count = doc.pageCount;
  const [mode, setMode] = useState<Mode>('every');
  const [every, setEvery] = useState(1);
  const [ranges, setRanges] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => parseRanges(ranges, count), [ranges, count]);
  const rangeError = (() => {
    if (mode !== 'ranges' || parsed.ok || !ranges.trim()) return null;
    return t(`split.error.${parsed.reason}`, { token: parsed.token ?? '', total: count });
  })();
  const files = mode === 'every' ? Math.ceil(count / Math.max(1, every)) : mode === 'ranges' && parsed.ok ? parsed.ranges.length : null;

  const run = async () => {
    let params: unknown;
    if (mode === 'every') params = { every: Math.max(1, Math.floor(every)) };
    else if (mode === 'ranges') {
      if (!parsed.ok) {
        setError(t(`split.error.${parsed.reason}`, { token: parsed.token ?? '', total: count }));
        return;
      }
      params = { ranges: parsed.ranges };
    } else params = { bookmarks: true };
    setBusy(true);
    setError(null);
    try {
      const res = await app.runOnDocument<{ parts: { pages: number[]; title: string | null }[] }>(doc.id, [{ method: 'pages.split', params }]);
      const base = baseName(doc.name);
      const entries = res.blobs.map((bytes, k) => {
        const title = res.json.parts[k]?.title;
        return { name: title ? `${title}.pdf` : t('split.partName', { name: base, n: k + 1 }), bytes };
      });
      const zip = zipStore(entries);
      if (await app.saveNewFile(t('split.zipName', { name: base }), zip, 'application/zip')) onClose();
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  const modes: Mode[] = ['every', 'ranges', 'bookmarks'];
  return (
    <Sheet
      title={t('split.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" data-action="run-split" disabled={busy || (mode === 'ranges' && !parsed.ok)} onClick={() => void run()}>
            {busy ? t('organize.working') : t('split.run')}
          </button>
        </>
      }
    >
      <fieldset className="field">
        <legend>{t('split.mode')}</legend>
        <div className="segmented" role="radiogroup" aria-label={t('split.mode')}>
          {modes.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} data-mode={m} onClick={() => setMode(m)}>
              {t(`split.mode.${m}`)}
            </button>
          ))}
        </div>
      </fieldset>
      {mode === 'every' && (
        <label className="crop-field">
          <span>{t('split.everyLabel')}</span>
          <input
            type="number"
            className="text-input"
            name="every"
            min={1}
            max={Math.max(1, count)}
            value={every}
            onChange={(e) => setEvery(Math.max(1, Math.min(count || 1, Math.floor(Number(e.target.value) || 1))))}
          />
        </label>
      )}
      {mode === 'ranges' && (
        <label className="crop-field">
          <span>{t('split.rangesLabel')}</span>
          <input
            type="text"
            className="text-input"
            name="ranges"
            dir="auto"
            placeholder={t('split.rangesPlaceholder')}
            value={ranges}
            aria-invalid={!!rangeError}
            onChange={(e) => {
              setRanges(e.target.value);
              setError(null);
            }}
          />
        </label>
      )}
      {mode === 'bookmarks' && <p className="fineprint">{t('split.bookmarksHint')}</p>}
      {files !== null && !rangeError && (
        <p className="fineprint" data-testid="split-summary">
          {t('split.summary', { count: files })}
        </p>
      )}
      {(rangeError || error) && (
        <p className="form-error" role="alert">
          {rangeError ?? error}
        </p>
      )}
    </Sheet>
  );
}
