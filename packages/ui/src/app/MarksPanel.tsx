/**
 * Page marks panel (warraq-marks): watermark (text or picture), header & footer, page numbers and
 * Bates, with a live preview of the page being viewed (the engine draws the mark on a private
 * copy, PDFium renders it), a page-range field, and the list of marks already in the document
 * (ours: edit/remove; other applications': remove when safe). Applying is a core edit: one
 * incremental update, the viewer reloads on the same page, undo goes through the shared history.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../services/AppContext';
import type { OpenDocument } from '../services/state';
import type { ViewerApi } from '../viewer/Viewer';
import { formatNumber, type MessageKey } from '../i18n';
import { formatRanges } from '../services/ranges';
import { errorCode } from '../services/coreOps';
import {
  DEFAULT_FORM,
  TOKENS,
  applyCalls,
  buildSpec,
  describeMark,
  formFromSpec,
  listMarks,
  looksRightToLeft,
  numberPresets,
  previewCalls,
  tabDefaults,
  type ForeignMark,
  type ListedMark,
  type MarkForm,
  type Tab,
} from '../services/marks';
import { IconButton } from './primitives';

const TABS: Tab[] = ['watermark', 'header', 'numbers', 'bates'];
const FONTS = ['amiri', 'cairo', 'inter'] as const;
const VERTICAL = ['top', 'middle', 'bottom'] as const;
const HORIZONTAL = ['start', 'center', 'end'] as const;
const PICTURE_ACCEPT = ['image/jpeg', 'image/png', '.jpg', '.jpeg', '.png'];

function reasonOf(e: unknown): string {
  return e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
}

function Seg<V extends string>({ value, options, onChange, label, testId, name }: { value: V; options: readonly V[]; onChange: (v: V) => void; label: string; testId?: string; name: (v: V) => string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label} data-testid={testId}>
      {options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={value === o} className={value === o ? 'on' : ''} data-value={o} onClick={() => onChange(o)}>
          {name(o)}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field-label">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function MarksPanel({ doc, api, page, onClose }: { doc: OpenDocument; api: ViewerApi | null; page: number; onClose: () => void }) {
  const app = useApp();
  const { t } = app;
  const locale = app.state.locale;
  const tt = t as unknown as (k: string, a?: Record<string, string | number>) => string;
  const [form, setForm] = useState<MarkForm>(() => ({
    ...DEFAULT_FORM,
    font: locale === 'ar' ? 'amiri' : 'inter',
    digits: locale === 'ar' ? 'arabic' : 'latin',
    numberText: numberPresets(locale)[1]!,
  }));
  const [picture, setPicture] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [editing, setEditing] = useState<ListedMark | null>(null);
  const [marks, setMarks] = useState<ListedMark[]>([]);
  const [foreign, setForeign] = useState<ForeignMark[]>([]);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ url: string; page: number } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const set = (patch: Partial<MarkForm>) => setForm((f) => ({ ...f, ...patch }));
  const num = (n: number) => formatNumber(n, locale);
  const pct = (n: number) => `${num(n)}${locale === 'ar' ? '٪' : '%'}`;
  const [tokenField, setTokenField] = useState<'text' | 'start' | 'center' | 'end' | 'numberText'>('center');
  const pagesLabel = (pages: number[]) =>
    formatRanges(pages)
      .replace(/\d+/g, (d) => num(Number(d)))
      .replace(/,/g, locale === 'ar' ? '، ' : ', ');

  // Document direction (what "start" means) from the text of the first page.
  useEffect(() => {
    let alive = true;
    const id = `marks-dir-${doc.id}`;
    const e = app.engine();
    e.open(id, doc.bytes.slice(), doc.password)
      .then(() => e.call<{ text: string }>(id, 'text.plain', { pages: [0] }, []))
      .then((r) => alive && setForm((f) => ({ ...f, rtl: looksRightToLeft(r.json.text) })))
      .catch(() => {})
      .finally(() => e.close(id).catch(() => {}));
    return () => {
      alive = false;
    };
    // Only once per panel: the person may change it afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Marks already in the document (refreshed after every change).
  const refresh = useCallback(() => {
    let alive = true;
    listMarks(app.engine(), doc.bytes, doc.password)
      .then((r) => {
        if (!alive) return;
        setMarks(r.marks);
        setForeign(r.foreign);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [app, doc.bytes, doc.password]);
  useEffect(() => refresh(), [refresh]);

  const built = useMemo(() => buildSpec({ ...form, hasPicture: form.hasPicture || !!picture }, { pageCount: doc.pageCount, fileName: doc.name, now: new Date(), locale }), [form, picture, doc.pageCount, doc.name, locale]);
  const specKey = built.ok ? JSON.stringify({ ...built.spec, now: null }) : null;

  // Live preview: the engine draws the mark on the viewed page of a private copy; PDFium renders it.
  const previewSeq = useRef(0);
  const pageIndex = Math.max(0, Math.min(doc.pageCount - 1, page - 1));
  // Nothing to show when the form is incomplete or the viewed page is not marked.
  const previewable = built.ok && (!built.spec.pages || built.spec.pages.includes(pageIndex));
  useEffect(() => {
    if (!built.ok || !api || !previewable) return;
    const seq = ++previewSeq.current;
    const timer = setTimeout(async () => {
      try {
        const r = await app.runOnDocument(doc.id, previewCalls(built.spec, pageIndex, editing?.id, picture?.bytes));
        if (!r.bytes || seq !== previewSeq.current) return;
        const other = await api.openOther(r.bytes);
        try {
          const blob = await other.renderPage(pageIndex, 520);
          if (seq !== previewSeq.current) return;
          setPreview((old) => {
            if (old) URL.revokeObjectURL(old.url);
            return { url: URL.createObjectURL(blob), page: pageIndex + 1 };
          });
          setPreviewError(null);
        } finally {
          other.close();
        }
      } catch (e) {
        if (seq === previewSeq.current) setPreviewError(errorCode(e) === 'engine_error' ? reasonOf(e) : errorCode(e));
      }
    }, 350);
    return () => clearTimeout(timer);
    // specKey stands for the spec (the date inside changes every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, pageIndex, api, doc.revision, editing?.id, picture]);
  useEffect(() => () => setPreview((old) => (old && URL.revokeObjectURL(old.url), null)), []);

  const choosePicture = async () => {
    try {
      const [f] = await app.host.openFiles({ multiple: false, accept: PICTURE_ACCEPT });
      if (f) {
        setPicture({ name: f.name, bytes: f.bytes });
        set({ hasPicture: true });
      }
    } catch (e) {
      app.toast(t('marks.toast.failed', { reason: reasonOf(e) }), 'error');
    }
  };

  const apply = async () => {
    if (!built.ok) return;
    setBusy(true);
    try {
      const r = await app.coreEdit(doc.id, applyCalls(built.spec, editing?.id, picture?.bytes), t('tool.page-marks.name'));
      if (r) app.toast(t(editing ? 'marks.toast.updated' : 'marks.toast.added'), 'success');
      setEditing(null);
      setPicture(null);
    } catch (e) {
      app.toast(t('marks.toast.failed', { reason: reasonOf(e) }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      const r = await app.coreEdit(doc.id, [{ method: 'marks.remove', params: { id } }], t('tool.page-marks.name'));
      if (r) app.toast(t('marks.toast.removed'), 'success');
      if (editing?.id === id) setEditing(null);
    } catch (e) {
      app.toast(t('marks.toast.failed', { reason: reasonOf(e) }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const edit = (m: ListedMark) => {
    if (!m.spec) return;
    setEditing(m);
    setPicture(null);
    setForm(formFromSpec(m.spec));
  };

  const history = app.historyOf(doc.id);
  const error = built.ok ? null : built.error === 'range' ? t('marks.error.range') : t(`marks.error.${built.error}` as MessageKey);
  const posName = (v: string) => t(`marks.v.${v}` as MessageKey);
  const slotName = (h: string) => t(`marks.slot.${h}` as MessageKey);
  const insertToken = (field: 'text' | 'start' | 'center' | 'end' | 'numberText', token: string) => set({ [field]: `${form[field]}${form[field] && !form[field].endsWith(' ') ? ' ' : ''}${token}` } as Partial<MarkForm>);

  const textInput = (field: 'text' | 'start' | 'center' | 'end' | 'numberText', label: string, testId: string, placeholder?: string) => (
    <Field label={label}>
      <input
        className="text-input"
        dir="auto"
        value={form[field]}
        placeholder={placeholder}
        onChange={(e) => set({ [field]: e.target.value } as Partial<MarkForm>)}
        onFocus={() => setTokenField(field)}
        data-testid={testId}
      />
    </Field>
  );

  const tokens = (
    <div className="marks-tokens" role="group" aria-label={t('marks.insertToken')}>
      {TOKENS.map((tok) => (
        <button key={tok} type="button" className="chip" data-token={tok} title={t(`marks.token.${tok.slice(1, -1)}` as MessageKey)} onClick={() => insertToken(form.tab === 'watermark' ? 'text' : form.tab === 'numbers' ? 'numberText' : tokenField === 'text' || tokenField === 'numberText' ? 'center' : tokenField, tok)}>
          {t(`marks.token.${tok.slice(1, -1)}` as MessageKey)}
        </button>
      ))}
    </div>
  );

  const grid = (vertical: readonly ('top' | 'middle' | 'bottom')[]) => (
    <fieldset className="field">
      <legend>{t('marks.position')}</legend>
      <div className="marks-grid" role="radiogroup" aria-label={t('marks.position')} data-testid="marks-position">
        {vertical.map((v) =>
          HORIZONTAL.map((h) => {
            const on = form.vertical === v && form.horizontal === h;
            return (
              <button
                key={`${v}-${h}`}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={`${posName(v)} · ${slotName(h)}`}
                title={`${posName(v)} · ${slotName(h)}`}
                className={on ? 'on' : ''}
                data-pos={`${v}-${h}`}
                onClick={() => set({ vertical: v, horizontal: h })}
              >
                <span />
              </button>
            );
          }),
        )}
      </div>
    </fieldset>
  );

  const style = (
    <div className="marks-row">
      <Field label={t('marks.font')}>
        <select className="select" value={form.font} onChange={(e) => set({ font: e.target.value as MarkForm['font'] })} data-testid="marks-font">
          {FONTS.map((f) => (
            <option key={f} value={f}>
              {t(`marks.fonts.${f}` as MessageKey)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('marks.size')}>
        <input className="text-input marks-num" type="number" min={4} max={300} value={form.size} onChange={(e) => set({ size: Math.max(1, Math.min(500, Number(e.target.value) || 1)) })} data-testid="marks-size" />
      </Field>
      <Field label={t('marks.color')}>
        <input className="marks-color" type="color" value={form.color} onChange={(e) => set({ color: e.target.value })} data-testid="marks-color" />
      </Field>
    </div>
  );

  const digits = (
    <Field label={t('marks.digits')}>
      <select className="select" value={form.digits} onChange={(e) => set({ digits: e.target.value as MarkForm['digits'] })} data-testid="marks-digits">
        <option value="latin">{t('marks.digits.latin')}</option>
        <option value="arabic">{t('marks.digits.arabic')}</option>
      </select>
    </Field>
  );

  return (
    <aside className="tool-panel glass marks-panel with-foot" aria-label={t('marks.title')} data-testid="marks-panel" data-revision={doc.revision} data-busy={busy ? 'true' : 'false'}>
      <header className="tool-panel-head">
        <h2 className="panel-title">{t('marks.title')}</h2>
        <IconButton icon="close" label={t('marks.close')} onClick={onClose} size={16} />
      </header>
      <div className="tool-panel-body">
        <div className="marks-tabs" role="tablist" aria-label={t('marks.title')}>
          {TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={form.tab === tab}
              className={form.tab === tab ? 'on' : ''}
              data-tab={tab}
              disabled={!!editing && form.tab !== tab}
              onClick={() => set({ tab, ...tabDefaults(tab) })}
            >
              {t(`marks.tab.${tab}` as MessageKey)}
            </button>
          ))}
        </div>
        {editing && (
          <p className="marks-editing" data-testid="marks-editing">
            {t('marks.editing', { name: describeMark(editing.spec, tt) })}
          </p>
        )}

        <figure className="marks-preview" data-testid="marks-preview" data-page={previewable ? (preview?.page ?? '') : ''}>
          {preview && previewable ? <img src={preview.url} alt={t('marks.preview', { page: num(preview.page) })} /> : <span className="page-skeleton" />}
          <figcaption className="fineprint">{previewError ? t('marks.previewFailed', { reason: previewError }) : t('marks.preview', { page: num(page) })}</figcaption>
        </figure>

        {form.tab === 'watermark' && (
          <>
            <Seg value={form.watermarkType} options={['text', 'picture'] as const} onChange={(v) => set({ watermarkType: v })} label={t('marks.type')} testId="marks-type" name={(v) => t(`marks.type.${v}` as MessageKey)} />
            {form.watermarkType === 'text' ? (
              <>
                {textInput('text', t('marks.text'), 'marks-text', t('marks.textPlaceholder'))}
                {tokens}
                {style}
              </>
            ) : (
              <>
                <button type="button" className="btn" onClick={() => void choosePicture()} data-testid="marks-picture">
                  {t('marks.choosePicture')}
                </button>
                <p className="fineprint" data-testid="marks-picture-name">
                  {picture ? t('marks.pictureChosen', { name: picture.name }) : form.hasPicture ? t('marks.keepPicture') : t('marks.noPictureYet')}
                </p>
                <Field label={`${t('marks.scale')} (${pct(form.scale)})`}>
                  <input type="range" min={5} max={100} value={form.scale} onChange={(e) => set({ scale: Number(e.target.value) })} data-testid="marks-scale" />
                </Field>
              </>
            )}
            <Field label={`${t('marks.opacity')} (${pct(form.opacity)})`}>
              <input type="range" min={5} max={100} step={5} value={form.opacity} onChange={(e) => set({ opacity: Number(e.target.value) })} data-testid="marks-opacity" />
            </Field>
            <label className="check-row">
              <input type="checkbox" checked={form.diagonal} onChange={() => set({ diagonal: !form.diagonal })} data-testid="marks-diagonal" />
              <span>{t('marks.diagonal')}</span>
            </label>
            {!form.diagonal && (
              <Field label={t('marks.rotation')}>
                <input className="text-input marks-num" type="number" min={-360} max={360} value={form.rotation} onChange={(e) => set({ rotation: Number(e.target.value) || 0 })} data-testid="marks-rotation" />
              </Field>
            )}
            {grid(VERTICAL)}
            <Seg value={form.layer} options={['front', 'behind'] as const} onChange={(v) => set({ layer: v })} label={t('marks.layer')} testId="marks-layer" name={(v) => t(`marks.layer.${v}` as MessageKey)} />
          </>
        )}

        {form.tab === 'header' && (
          <>
            <Seg value={form.band} options={['header', 'footer'] as const} onChange={(v) => set({ band: v })} label={t('marks.band')} testId="marks-band" name={(v) => t(`marks.band.${v}` as MessageKey)} />
            {textInput('start', t('marks.slot.start'), 'marks-slot-start')}
            {textInput('center', t('marks.slot.center'), 'marks-slot-center')}
            {textInput('end', t('marks.slot.end'), 'marks-slot-end')}
            {tokens}
            <p className="fineprint">{t('marks.slotsHint')}</p>
            {style}
            {digits}
          </>
        )}

        {form.tab === 'numbers' && (
          <>
            <Field label={t('marks.format')}>
              <select className="select" value={numberPresets(locale).includes(form.numberText) ? form.numberText : ''} onChange={(e) => e.target.value && set({ numberText: e.target.value })} data-testid="marks-number-preset">
                {numberPresets(locale).map((p) => (
                  <option key={p} value={p}>
                    {p.replace('{page}', num(1)).replace('{pages}', num(9))}
                  </option>
                ))}
                <option value="">{t('marks.customFormat')}</option>
              </select>
            </Field>
            {textInput('numberText', t('marks.text'), 'marks-number-text')}
            {tokens}
            {digits}
            {style}
            {grid(['top', 'bottom'])}
          </>
        )}

        {form.tab === 'bates' && (
          <>
            <div className="marks-row">
              <Field label={t('marks.bates.prefix')}>
                <input className="text-input" dir="auto" value={form.batesPrefix} onChange={(e) => set({ batesPrefix: e.target.value })} data-testid="marks-bates-prefix" />
              </Field>
              <Field label={t('marks.bates.suffix')}>
                <input className="text-input" dir="auto" value={form.batesSuffix} onChange={(e) => set({ batesSuffix: e.target.value })} data-testid="marks-bates-suffix" />
              </Field>
            </div>
            <div className="marks-row">
              <Field label={t('marks.bates.start')}>
                <input className="text-input marks-num" inputMode="numeric" value={form.batesStart} onChange={(e) => set({ batesStart: e.target.value })} data-testid="marks-bates-start" />
              </Field>
              <Field label={t('marks.bates.digits')}>
                <input className="text-input marks-num" inputMode="numeric" value={form.batesDigits} onChange={(e) => set({ batesDigits: e.target.value })} data-testid="marks-bates-digits" />
              </Field>
            </div>
            {digits}
            {style}
            {grid(['top', 'bottom'])}
          </>
        )}

        <label className="check-row">
          <input type="checkbox" checked={form.rtl} onChange={() => set({ rtl: !form.rtl })} data-testid="marks-rtl" />
          <span>{t('marks.rtl')}</span>
        </label>

        <fieldset className="field">
          <legend>{t('marks.pages')}</legend>
          <Seg value={form.rangeMode} options={['all', 'odd', 'even', 'custom'] as const} onChange={(v) => set({ rangeMode: v })} label={t('marks.pages')} testId="marks-range-mode" name={(v) => t(`marks.range.${v}` as MessageKey)} />
          {form.rangeMode === 'custom' && (
            <input className="text-input" value={form.range} placeholder={t('marks.rangePlaceholder')} onChange={(e) => set({ range: e.target.value })} aria-label={t('marks.pages')} data-testid="marks-range" />
          )}
        </fieldset>

        {error && (
          <p className="form-error" role="alert" data-testid="marks-error">
            {error}
          </p>
        )}

        <section className="marks-list" aria-label={t('marks.existing')} data-testid="marks-list">
          <h3 className="result-page">{t('marks.existing')}</h3>
          {marks.length === 0 && foreign.length === 0 && <p className="fineprint">{t('marks.none')}</p>}
          <ul>
            {marks.map((m) => (
              <li key={m.id} className="marks-item" data-mark-id={m.id} data-kind={m.spec?.kind ?? ''}>
                <span className="marks-item-text" dir="auto">
                  {describeMark(m.spec, tt)}
                  <span className="fineprint"> · {t('marks.onPages', { pages: pagesLabel(m.pages) })}</span>
                </span>
                <span className="results-actions">
                  <button type="button" className="link-btn" onClick={() => edit(m)} disabled={busy || !m.spec} data-action="edit">
                    {t('marks.edit')}
                  </button>
                  <button type="button" className="link-btn danger" onClick={() => void remove(m.id)} disabled={busy} data-action="remove">
                    {t('marks.remove')}
                  </button>
                </span>
              </li>
            ))}
            {foreign.map((m) => (
              <li key={m.id} className="marks-item foreign" data-mark-id={m.id} data-kind={m.kind}>
                <span className="marks-item-text">
                  {t(`marks.foreignKind.${m.kind}` as MessageKey)}
                  <span className="fineprint">
                    {' '}
                    · {t('marks.foreign')} · {t('marks.onPages', { pages: pagesLabel(m.pages) })}
                  </span>
                </span>
                {m.removable ? (
                  <button type="button" className="link-btn danger" onClick={() => void remove(m.id)} disabled={busy} data-action="remove">
                    {t('marks.remove')}
                  </button>
                ) : (
                  <span className="fineprint">{t('marks.notRemovable')}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
      <footer className="tool-panel-foot">
        <button type="button" className="btn btn-primary" disabled={busy || !built.ok} onClick={() => void apply()} data-testid="marks-apply">
          {busy ? t('marks.working') : editing ? t('marks.save') : t('marks.add')}
        </button>
        <div className="marks-foot-row">
          {editing && (
            <button type="button" className="btn" onClick={() => setEditing(null)} data-testid="marks-cancel-edit">
              {t('marks.cancelEdit')}
            </button>
          )}
          <button type="button" className="btn" disabled={busy || !history.canUndo} onClick={() => void app.undoCore(doc.id)} data-testid="marks-undo">
            {t('marks.undo')}
          </button>
          <button type="button" className="btn" disabled={busy || !history.canRedo} onClick={() => void app.redoCore(doc.id)} data-testid="marks-redo">
            {t('marks.redo')}
          </button>
        </div>
      </footer>
    </aside>
  );
}
