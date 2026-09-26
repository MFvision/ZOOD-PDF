/**
 * Compare panel: pick the revised file, see the text changes (click one to jump to it and see both
 * pages side by side with the change highlighted), pages that look different, and save an HTML report.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../services/AppContext';
import type { OpenDocument } from '../services/state';
import { isPdfBytes } from '../services/files';
import {
  buildReport,
  compareText,
  pngToRaster,
  reportFileName,
  reportLabels,
  visualDiff,
  type Change,
  type CompareOptions,
  type PageRect,
  type TextDiff,
} from '../services/comparer';
import type { OtherDocument, ViewerApi } from '../viewer/Viewer';
import { Icon } from './icons';
import { IconButton } from './primitives';

/** Pages checked visually (each is rendered twice by PDFium and diffed by the engine). */
const MAX_VISUAL_PAGES = 30;
/** Raster width for the visual check, in pixels. */
const VISUAL_WIDTH = 480;
const PREVIEW_WIDTH = 520;

interface VisualPage {
  page: number;
  regions: number;
  overlay: Uint8Array;
  url: string;
}

export function ComparePanel({ doc, api, onClose }: { doc: OpenDocument; api: ViewerApi | null; onClose: () => void }) {
  const app = useApp();
  const { t } = app;
  const [options, setOptions] = useState<CompareOptions>({ ignoreDiacritics: true, normalizeLetters: false });
  const [other, setOther] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [result, setResult] = useState<TextDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [visual, setVisual] = useState<VisualPage[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const otherDoc = useRef<OtherDocument | null>(null);
  const [otherPdf, setOtherPdf] = useState<OtherDocument | null>(null);
  const run = useRef(0);

  // Release PDFium's copy of the other file and the overlay URLs.
  useEffect(
    () => () => {
      otherDoc.current?.close();
      otherDoc.current = null;
    },
    [],
  );
  useEffect(() => () => visual?.forEach((v) => URL.revokeObjectURL(v.url)), [visual]);

  const compare = useCallback(
    async (file: { name: string; bytes: Uint8Array }, opts: CompareOptions) => {
      const id = ++run.current;
      setBusy(true);
      setResult(null);
      setVisual(null);
      setSelected(null);
      try {
        const engine = app.engine();
        const bytesA = await app.currentBytes(doc.id);
        const diff = await compareText(engine, bytesA, file.bytes, opts);
        if (id !== run.current) return;
        setResult(diff);
        setBusy(false);
        // Visual pass: PDFium rasters of both files, diffed by the engine.
        if (!api) return;
        otherDoc.current?.close();
        const b = await api.openOther(file.bytes);
        otherDoc.current = b;
        setOtherPdf(b);
        const pages = Math.min(api.pageCount(), b.pageCount, MAX_VISUAL_PAGES);
        const found: VisualPage[] = [];
        for (let p = 0; p < pages; p++) {
          if (id !== run.current) return;
          const [ra, rb] = await Promise.all([api.renderPage(p, VISUAL_WIDTH).then(pngToRaster), b.renderPage(p, VISUAL_WIDTH).then(pngToRaster)]);
          const v = await visualDiff(engine, ra, rb);
          if (v.changedPixels > 0) {
            found.push({ page: p, regions: v.boxes.length, overlay: v.overlay, url: URL.createObjectURL(new Blob([v.overlay.slice().buffer as ArrayBuffer], { type: 'image/png' })) });
          }
        }
        if (id === run.current) setVisual(found);
      } catch (e) {
        if (id !== run.current) return;
        const reason = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
        app.toast(t('compare.failed', { reason }), 'error');
        setBusy(false);
        setVisual((v) => v ?? []);
      }
    },
    [api, app, doc.id, t],
  );

  const choose = async () => {
    try {
      const files = await app.host.openFiles({ multiple: false, accept: ['application/pdf', '.pdf'] });
      const f = files[0];
      if (!f) return;
      if (!isPdfBytes(f.bytes)) {
        app.toast(t('toast.notPdf', { name: f.name }), 'error');
        return;
      }
      setOther({ name: f.name, bytes: f.bytes });
      void compare({ name: f.name, bytes: f.bytes }, options);
    } catch (e) {
      app.toast(t('toast.openFailed', { name: e instanceof Error ? e.message : '' }), 'error');
    }
  };

  const setOption = (k: keyof CompareOptions, v: boolean) => {
    const next = { ...options, [k]: v };
    setOptions(next);
    if (other) void compare(other, next);
  };

  const pick = (i: number, c: Change) => {
    setSelected(i);
    api?.goToPage(c.pageA + 1);
  };

  const saveReport = async () => {
    if (!result || !other) return;
    try {
      const html = await buildReport(app.engine(), {
        locale: app.state.locale,
        nameA: doc.name,
        nameB: other.name,
        labels: reportLabels(t),
        text: result,
        visual: (visual ?? []).map((v) => ({ page: v.page, regions: v.regions, overlay: v.overlay })),
      });
      const saved = await app.host.saveFile(reportFileName(doc.name, t('compare.report.suffix')), html, { saveAs: true });
      if (saved) app.toast(t('compare.report.saved', { name: saved.name }), 'success');
    } catch (e) {
      const reason = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
      app.toast(t('compare.failed', { reason }), 'error');
    }
  };

  const change = selected !== null ? result?.changes[selected] : undefined;
  const s = result?.summary;

  return (
    <aside className="compare-panel glass" aria-label={t('compare.title')} data-testid="compare-panel">
      <header className="compare-head">
        <h2 className="panel-title">{t('compare.title')}</h2>
        <IconButton icon="close" label={t('common.close')} onClick={onClose} size={16} />
      </header>
      <div className="compare-scroll">
        <p className="compare-files">
          <span className="compare-file">
            <span className="compare-file-label">{t('compare.original')}</span>
            <bdi>{doc.name}</bdi>
          </span>
          <span className="compare-file">
            <span className="compare-file-label">{t('compare.revised')}</span>
            {other ? <bdi data-testid="compare-other">{other.name}</bdi> : <span className="muted">{t('compare.noneChosen')}</span>}
          </span>
        </p>
        <button type="button" className={`btn${other ? '' : ' btn-primary'}`} onClick={() => void choose()} disabled={busy} data-testid="compare-choose">
          <Icon name="swap" size={16} />
          {other ? t('compare.chooseAnother') : t('compare.choose')}
        </button>
        <fieldset className="compare-options">
          <legend className="visually-hidden">{t('compare.options')}</legend>
          <label className="check">
            <input type="checkbox" checked={options.ignoreDiacritics} onChange={(e) => setOption('ignoreDiacritics', e.target.checked)} />
            <span>{t('compare.option.diacritics')}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={options.normalizeLetters} onChange={(e) => setOption('normalizeLetters', e.target.checked)} />
            <span>{t('compare.option.letters')}</span>
          </label>
        </fieldset>

        {busy && (
          <p className="compare-status" aria-live="polite">
            <span className="spinner spinner-sm" aria-hidden="true" />
            {t('compare.running')}
          </p>
        )}

        {result && s && (
          <>
            <div className="compare-summary" data-testid="compare-summary">
              <span className="sum sum-ins">{t('compare.count.inserted', { count: s.inserted })}</span>
              <span className="sum sum-del">{t('compare.count.deleted', { count: s.deleted })}</span>
              <span className="sum sum-chg">{t('compare.count.changed', { count: s.changed })}</span>
            </div>
            <button type="button" className="btn" onClick={() => void saveReport()} data-testid="compare-report">
              <Icon name="save" size={16} />
              {t('compare.report.save')}
            </button>

            {change && other && <SideBySide api={api} other={otherPdf} change={change} />}

            {result.changes.length === 0 ? (
              <p className="muted" data-testid="compare-none">
                {t('compare.noChanges')}
              </p>
            ) : (
              <ol className="change-list" data-testid="compare-changes">
                {result.changes.map((c, i) => (
                  <li key={i}>
                    <button type="button" className={`change-item${selected === i ? ' on' : ''}`} data-kind={c.kind} onClick={() => pick(i, c)} data-testid="compare-change">
                      <span className="change-meta">
                        <span className={`badge badge-${c.kind}`}>{t(`compare.kind.${c.kind}`)}</span>
                        <span className="muted">{t('compare.pageShort', { page: c.pageA + 1 })}</span>
                      </span>
                      {c.old && (
                        <del dir="auto" className="change-old">
                          {c.old}
                        </del>
                      )}
                      {c.new && (
                        <ins dir="auto" className="change-new">
                          {c.new}
                        </ins>
                      )}
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {s.truncated && <p className="fineprint">{t('compare.report.truncated')}</p>}

            <h3 className="compare-sub">{t('compare.report.visualChanges')}</h3>
            {visual === null ? (
              <p className="compare-status" aria-live="polite">
                <span className="spinner spinner-sm" aria-hidden="true" />
                {t('compare.visualRunning')}
              </p>
            ) : visual.length === 0 ? (
              <p className="muted" data-testid="compare-visual-none">
                {t('compare.visualNone')}
              </p>
            ) : (
              <ul className="visual-list" data-testid="compare-visual">
                {visual.map((v) => (
                  <li key={v.page}>
                    <button type="button" className="visual-item" onClick={() => api?.goToPage(v.page + 1)}>
                      <img src={v.url} alt={t('compare.visualAlt', { page: v.page + 1 })} />
                      <span>{t('compare.visualRegions', { page: v.page + 1, count: v.regions })}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function SideBySide({ api, other, change }: { api: ViewerApi | null; other: OtherDocument | null; change: Change }) {
  const { t } = useApp();
  return (
    <div className="side-by-side" data-testid="compare-preview">
      <PagePreview label={t('compare.original')} page={change.pageA} rects={change.rectsA} kind="old" source={api} size={api?.pageSizes()[change.pageA]} />
      <PagePreview label={t('compare.revised')} page={change.pageB} rects={change.rectsB} kind="new" source={other} size={other?.pageSizes[change.pageB]} />
    </div>
  );
}

function PagePreview({
  label,
  page,
  rects,
  kind,
  source,
  size,
}: {
  label: string;
  page: number;
  rects: PageRect[];
  kind: 'old' | 'new';
  source: { renderPage(page: number, width: number): Promise<Blob> } | null;
  size?: { width: number; height: number };
}) {
  const { t } = useApp();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!source) return;
    let alive = true;
    let made: string | null = null;
    source
      .renderPage(page, PREVIEW_WIDTH)
      .then((b) => {
        if (!alive) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [source, page]);
  const own = rects.filter((r) => r.page === page);
  return (
    <figure className="preview">
      <figcaption>
        {label} · {t('compare.pageShort', { page: page + 1 })}
      </figcaption>
      {/* Page coordinates are physical (left-to-right) whatever the interface direction. */}
      <div className="preview-page" dir="ltr">
        {url ? <img src={url} alt="" /> : <span className="page-skeleton" />}
        {size &&
          own.map((r, i) => (
            <span
              key={i}
              className={`hl hl-${kind}`}
              style={{
                insetInlineStart: `${(r.x0 / size.width) * 100}%`,
                insetBlockStart: `${(r.y0 / size.height) * 100}%`,
                inlineSize: `${((r.x1 - r.x0) / size.width) * 100}%`,
                blockSize: `${((r.y1 - r.y0) / size.height) * 100}%`,
              }}
            />
          ))}
      </div>
    </figure>
  );
}
