/**
 * Redact panel: find text (Arabic-aware) and personal data (patterns with validators) in the engine,
 * pick results, mark them in the viewer (EmbedPDF REDACT marks), and apply every mark through the engine
 * (`redact.apply`): true removal of text, picture pixels, drawings and annotations, then a whole rewrite
 * with a single revision. Also hosts "Remove hidden information" (`redact.sanitize`).
 */
import { useEffect, useMemo, useState } from 'react';
import naskhRegularUrl from '@zood-assets/fonts-arabic/NotoNaskhArabic-Regular.ttf?url';
import { useApp } from '../services/AppContext';
import type { OpenDocument } from '../services/state';
import type { ViewerApi } from '../viewer/Viewer';
import { formatNumber } from '../i18n';
import type { MessageKey } from '../i18n';
import {
  applyRedactions,
  DEFAULT_SANITIZE,
  findInDocument,
  hitsByPage,
  PATTERN_KINDS,
  sanitizeDocument,
  type FindHit,
  type PatternKind,
  type SanitizeOptions,
  type SanitizeReport,
} from '../services/redact';
import { looksProtected, rebaseOnOriginal } from '../services/save';
import { absoluteAssetUrl } from '../viewer/config';
import { IconButton, Sheet } from './primitives';

function reasonOf(e: unknown): string {
  return e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
}

/**
 * Bytes a core tool should work on: the viewer's current state (marks and unsaved edits included). If the
 * original is protected and PDFium exported it decrypted, rebase first so the engine keeps the protection.
 */
export async function workingBytes(
  app: ReturnType<typeof useApp>,
  doc: OpenDocument,
  fromViewer: boolean,
): Promise<Uint8Array> {
  const bytes = await app.currentBytes(doc.id, { fromViewer });
  if (bytes !== doc.bytes && looksProtected(doc.originalBytes) && !looksProtected(bytes)) {
    return (await rebaseOnOriginal(app.engine(), doc.originalBytes, bytes, doc.password)).bytes;
  }
  return bytes;
}

let fontCache: Promise<Uint8Array> | null = null;
/** The bundled Noto Naskh Arabic (OFL) for shaped overlay text on the boxes. */
function overlayFont(): Promise<Uint8Array> {
  fontCache ??= fetch(absoluteAssetUrl(naskhRegularUrl))
    .then((r) => r.arrayBuffer())
    .then((b) => new Uint8Array(b));
  return fontCache;
}

export function RedactPanel({ doc, api, onClose }: { doc: OpenDocument; api: ViewerApi | null; onClose: () => void }) {
  const app = useApp();
  const { t } = app;
  const [query, setQuery] = useState('');
  const [patterns, setPatterns] = useState<Set<PatternKind>>(new Set());
  const [regex, setRegex] = useState('');
  const [busy, setBusy] = useState<'find' | 'apply' | null>(null);
  const [hits, setHits] = useState<FindHit[] | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const [marks, setMarks] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [overlay, setOverlay] = useState('');
  const [sanitizeOpen, setSanitizeOpen] = useState(false);

  useEffect(() => (api ? api.onRedactionMarks(setMarks) : undefined), [api]);

  const groups = useMemo(() => (hits ? hitsByPage(hits) : []), [hits]);

  const find = async () => {
    if (!query.trim() && patterns.size === 0 && !regex.trim()) return;
    setBusy('find');
    try {
      const bytes = doc.warraqOwnsDocument || !doc.edited ? doc.bytes : await workingBytes(app, doc, false);
      const r = await findInDocument(app.engine(), bytes, doc.password, {
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(patterns.size ? { patterns: [...patterns] } : {}),
        ...(regex.trim() ? { regex: regex.trim() } : {}),
      });
      setHits(r.hits);
      setChecked(new Set(r.hits.map((_, i) => i)));
      setMarked(new Set());
    } catch (e) {
      app.toast(t('redact.toast.failed', { reason: reasonOf(e) }), 'error');
    } finally {
      setBusy(null);
    }
  };

  const markSelected = () => {
    if (!api || !hits) return;
    const pick = [...checked].filter((i) => !marked.has(i));
    const n = api.addRedactionMarks(pick.map((i) => ({ page: hits[i]!.page, rects: hits[i]!.viewRects })));
    setMarked(new Set([...marked, ...pick]));
    app.toast(t('redact.toast.marked', { count: n }), 'success');
  };

  const pendingAreas = () =>
    hits ? [...checked].filter((i) => !marked.has(i)).flatMap((i) => hits[i]!.rects.map((rect) => ({ page: hits[i]!.page, rect }))) : [];

  const canApply = marks > 0 || pendingAreas().length > 0;

  const apply = async () => {
    setConfirm(false);
    if (!api) return;
    setBusy('apply');
    try {
      const bytes = await workingBytes(app, doc, true);
      const text = overlay.trim();
      const font = text && !/^[\x20-\x7e]*$/.test(text) ? await overlayFont() : undefined;
      const r = await applyRedactions(app.engine(), bytes, doc.password, { areas: pendingAreas(), ...(text ? { overlayText: text } : {}) }, font);
      await app.replaceWithCoreBytes(doc.id, r.bytes);
      const c = r.report.content;
      app.toast(
        t('redact.toast.applied', {
          glyphs: c.glyphsRemoved,
          images: c.imagesRedacted + c.imagesRemoved + c.inlineImagesRedacted + c.inlineImagesRemoved,
        }),
        'success',
      );
    } catch (e) {
      app.toast(t('redact.toast.failed', { reason: reasonOf(e) }), 'error');
    } finally {
      setBusy(null);
    }
  };

  const toggle = (set: Set<number>, i: number) => {
    const n = new Set(set);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    return n;
  };

  return (
    <aside className="tool-panel glass" aria-label={t('redact.panel.title')} data-testid="redact-panel">
      <header className="tool-panel-head">
        <h2 className="panel-title">{t('redact.panel.title')}</h2>
        <IconButton icon="close" label={t('common.close')} onClick={onClose} />
      </header>
      <div className="tool-panel-body">
        <p className="fineprint">{t('redact.panel.hint')}</p>
        <form
          className="tool-form"
          onSubmit={(e) => {
            e.preventDefault();
            void find();
          }}
        >
          <label className="field-label">
            <span>{t('redact.find.label')}</span>
            <input
              className="text-input"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('redact.find.placeholder')}
              data-testid="redact-query"
              dir="auto"
            />
          </label>
          <fieldset className="field">
            <legend>{t('redact.patterns')}</legend>
            {PATTERN_KINDS.map((k) => (
              <label key={k} className="check-row">
                <input
                  type="checkbox"
                  checked={patterns.has(k)}
                  data-pattern={k}
                  onChange={() => {
                    const n = new Set(patterns);
                    if (n.has(k)) n.delete(k);
                    else n.add(k);
                    setPatterns(n);
                  }}
                />
                <span>{t(`redact.pattern.${k}` as MessageKey)}</span>
              </label>
            ))}
          </fieldset>
          <label className="field-label">
            <span>{t('redact.regex.label')}</span>
            <input
              className="text-input mono"
              value={regex}
              onChange={(e) => setRegex(e.target.value)}
              placeholder={t('redact.regex.placeholder')}
              maxLength={512}
              dir="ltr"
              data-testid="redact-regex"
            />
          </label>
          <button type="submit" className="btn" disabled={busy !== null} data-testid="redact-find">
            {busy === 'find' ? t('redact.finding') : t('redact.find')}
          </button>
        </form>

        {hits && (
          <section className="results" data-testid="redact-results" aria-live="polite">
            <div className="results-head">
              <strong>{t('redact.results', { count: hits.length })}</strong>
              {hits.length > 0 && (
                <span className="results-actions">
                  <button type="button" className="link-btn" onClick={() => setChecked(new Set(hits.map((_, i) => i)))}>
                    {t('redact.selectAll')}
                  </button>
                  <button type="button" className="link-btn" onClick={() => setChecked(new Set())}>
                    {t('redact.selectNone')}
                  </button>
                </span>
              )}
            </div>
            {hits.length === 0 && <p className="fineprint">{t('redact.noResults')}</p>}
            {groups.map((g) => (
              <div key={g.page} className="result-group" data-page={g.page + 1}>
                <h3 className="result-page">{t('doc.page', { page: g.page + 1 })}</h3>
                <ul>
                  {g.hits.map(({ hit, index }) => (
                    <li key={index}>
                      <label className="check-row result" data-kind={hit.kind}>
                        <input type="checkbox" checked={checked.has(index)} onChange={() => setChecked(toggle(checked, index))} data-testid="redact-hit" />
                        <span className="hit-text" dir="auto">
                          {hit.text}
                        </span>
                        <span className="hit-kind">
                          {marked.has(index) ? t('redact.marked') : t(`redact.pattern.${hit.kind}` as MessageKey)}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}
      </div>
      <footer className="tool-panel-foot">
        <span className="fineprint" data-testid="redact-marks">
          {t('redact.marksCount', { count: marks })}
        </span>
        <button type="button" className="btn" disabled={!api || !hits || checked.size === 0} onClick={markSelected} data-testid="redact-mark">
          {t('redact.markAll')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!api || busy !== null}
          onClick={() => (canApply ? setConfirm(true) : app.toast(t('redact.toast.nothing')))}
          data-testid="redact-apply"
        >
          {busy === 'apply' ? t('redact.applying') : t('redact.apply')}
        </button>
        <button type="button" className="btn" onClick={() => setSanitizeOpen(true)} disabled={!api || busy !== null} data-testid="sanitize-open">
          {t('redact.sanitize')}
        </button>
      </footer>

      {confirm && (
        <Sheet
          title={t('redact.confirm.title')}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirm(false)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn btn-danger" onClick={() => void apply()} data-testid="redact-confirm">
                {t('redact.confirm.apply')}
              </button>
            </>
          }
        >
          <p>{t('redact.confirm.body')}</p>
          <p className="fineprint">{t('redact.confirm.rewrite')}</p>
          <label className="field-label">
            <span>{t('redact.overlay.label')}</span>
            <input
              className="text-input"
              value={overlay}
              onChange={(e) => setOverlay(e.target.value)}
              placeholder={t('redact.overlay.placeholder')}
              maxLength={80}
              dir="auto"
              data-testid="redact-overlay"
            />
          </label>
        </Sheet>
      )}
      {sanitizeOpen && <SanitizeSheet doc={doc} onClose={() => setSanitizeOpen(false)} />}
    </aside>
  );
}

const SANITIZE_KEYS: (keyof Omit<SanitizeOptions, 'forms'>)[] = [
  'metadata',
  'xmp',
  'javascript',
  'actions',
  'attachments',
  'comments',
  'hiddenLayers',
  'hiddenText',
  'thumbnails',
  'pieceInfo',
  'bookmarks',
  'links',
];

const REPORT_KEYS: (keyof SanitizeReport)[] = [
  'metadata',
  'xmp',
  'javascript',
  'actions',
  'attachments',
  'comments',
  'formFields',
  'hiddenLayers',
  'hiddenText',
  'thumbnails',
  'pieceInfo',
  'bookmarks',
  'links',
  'earlierRevisions',
  'orphans',
];

export function SanitizeSheet({ doc, onClose }: { doc: OpenDocument; onClose: () => void }) {
  const app = useApp();
  const { t, state } = app;
  const [opts, setOpts] = useState<SanitizeOptions>(DEFAULT_SANITIZE);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<SanitizeReport | null>(null);

  const run = async () => {
    setBusy(true);
    try {
      const bytes = await workingBytes(app, doc, doc.edited && !doc.warraqOwnsDocument);
      const r = await sanitizeDocument(app.engine(), bytes, doc.password, opts);
      await app.replaceWithCoreBytes(doc.id, r.bytes);
      setReport(r.report);
    } catch (e) {
      app.toast(t('sanitize.failed', { reason: reasonOf(e) }), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (report) {
    const rows = REPORT_KEYS.filter((k) => (report[k] ?? 0) > 0);
    return (
      <Sheet
        title={t('sanitize.report')}
        onClose={onClose}
        footer={
          <button type="button" className="btn btn-primary" onClick={onClose} data-testid="sanitize-done">
            {t('common.done')}
          </button>
        }
      >
        {rows.length === 0 ? (
          <p>{t('sanitize.reportNone')}</p>
        ) : (
          <dl className="props report" data-testid="sanitize-report">
            {rows.map((k) => (
              <div key={k} className="report-row" data-item={k}>
                <dt>{t(`sanitize.${k}` as MessageKey)}</dt>
                <dd>{formatNumber(report[k], state.locale)}</dd>
              </div>
            ))}
          </dl>
        )}
      </Sheet>
    );
  }

  return (
    <Sheet
      title={t('sanitize.title')}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void run()} disabled={busy} data-testid="sanitize-run">
            {busy ? t('sanitize.running') : t('sanitize.run')}
          </button>
        </>
      }
    >
      <p>{t('sanitize.body')}</p>
      <div className="check-grid">
        {SANITIZE_KEYS.map((k) => (
          <label key={k} className="check-row">
            <input type="checkbox" checked={opts[k]} data-sanitize={k} onChange={() => setOpts({ ...opts, [k]: !opts[k] })} />
            <span>{t(`sanitize.${k}` as MessageKey)}</span>
          </label>
        ))}
        <label className="check-row">
          <span>{t('sanitize.forms')}</span>
          <select className="select" value={opts.forms} onChange={(e) => setOpts({ ...opts, forms: e.target.value as SanitizeOptions['forms'] })} data-testid="sanitize-forms">
            <option value="clear">{t('sanitize.forms.clear')}</option>
            <option value="flatten">{t('sanitize.forms.flatten')}</option>
            <option value="keep">{t('sanitize.forms.keep')}</option>
          </select>
        </label>
      </div>
    </Sheet>
  );
}
