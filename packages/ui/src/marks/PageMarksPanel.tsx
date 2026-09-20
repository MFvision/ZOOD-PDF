import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ImagePlus, Layers, Pencil, Trash, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { Stepper } from '../components/Stepper';
import { EDIT_FONTS, loadEditFont } from '../edit/editFont';
import type { EditFontId } from '../edit/editFont';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { DEFAULT_FORM, TOKENS, batesSample, formOf, hasContent, pageNumberSample, pagesLabel, parsePages, specOf } from './markSpec';
import type { MarkForm, MarkKind, MarkPosition, MarkSection } from './markSpec';
import './marks.css';

/** A mark in the file, as `marks.list` answers. */
interface ListedMark {
  id: number;
  kind: MarkKind;
  front: boolean;
  spec: Record<string, unknown> | null;
  pages: number[];
}

const SECTIONS: readonly MarkSection[] = ['watermark', 'band', 'pageNumber', 'bates'];
const POSITIONS: readonly MarkPosition[] = ['topLeft', 'top', 'topRight', 'left', 'center', 'right', 'bottomLeft', 'bottom', 'bottomRight'];
const EDGE_POSITIONS: readonly MarkPosition[] = ['topLeft', 'top', 'topRight', 'bottomLeft', 'bottom', 'bottomRight'];
const TOKEN_LABELS: Record<(typeof TOKENS)[number], TKey> = {
  '{page}': 'marks.token.page',
  '{pages}': 'marks.token.pages',
  '{date}': 'marks.token.date',
  '{file}': 'marks.token.file',
};
/** How long the controls must hold still before the preview is drawn again. */
const PREVIEW_DELAY_MS = 350;
/** The file is asked for this many times, this far apart, before the panel says it could not be read. */
const LOAD_ATTEMPTS = 40;
const LOAD_RETRY_MS = 250;

/** A label above its control. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/**
 * What a listed mark says, in a few words — as it is drawn: page numbers
 * from its own start, in its own digits; a Bates number from its start.
 */
function summary(mark: ListedMark, t: (key: TKey, values?: Record<string, string | number>) => string): string {
  const spec = mark.spec ?? {};
  switch (mark.kind) {
    case 'watermark':
      return typeof spec.text === 'string' && spec.text ? spec.text : t('marks.sourcePicture');
    case 'header':
    case 'footer':
      return Array.isArray(spec.slots) ? spec.slots.filter((s) => typeof s === 'string' && s.trim()).join(' · ') : '';
    case 'pageNumber': {
      const numerals = spec.numerals === 'arabic' ? 'arabic' : 'western';
      const start = typeof spec.start === 'number' ? spec.start : 1;
      const sample = pageNumberSample(numerals, start, mark.pages.length, spec.skipFirst === true);
      return t(`marks.format.${typeof spec.format === 'string' ? spec.format : 'plain'}` as TKey, sample);
    }
    case 'bates':
      return batesSample(spec);
  }
}

/**
 * Page marks: watermarks, headers and footers, page numbers and Bates
 * numbers, drawn into the file by Warraq's core (`marks.*`) with Arabic
 * shaped as it should be. The page on screen is previewed with the mark as
 * the core would draw it; Apply writes it as an update of the file, which
 * EmbedPDF then shows. Marks already in the file are listed, to change or
 * take off — the page's own content is never touched.
 */
export function PageMarksPanel() {
  const { t } = useI18n();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const { client, documentPassword } = services;
  const [form, setForm] = useState<MarkForm>(DEFAULT_FORM);
  const [picture, setPicture] = useState<{ name: string; bytes: ArrayBuffer } | null>(null);
  const [marks, setMarks] = useState<ListedMark[]>([]);
  const [busy, setBusy] = useState(false);
  // The document whose bytes the panel holds: loaded means this one's.
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  const [changing, setChanging] = useState<ListedMark | null>(null);
  const [preview, setPreview] = useState<{ width: number; height: number; rgba: ArrayBuffer } | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const base = useRef<ArrayBuffer | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const focusedSlot = useRef<{ index: number; at: number }>({ index: 0, at: 0 });
  const pictureInput = useRef<HTMLInputElement | null>(null);

  const documentName = state.document?.name ?? 'document.pdf';
  const pageCount = state.document?.pageCount ?? 0;
  const ready = state.view === 'viewer' && state.document !== null && state.switching === null;
  // One array for as long as the field says the same: the preview's request
  // depends on it, and a new one each render drew the preview again forever.
  const pages = useMemo(() => parsePages(form.pages, pageCount), [form.pages, pageCount]);
  const previewPage = Math.min(Math.max(0, state.currentPage - 1), Math.max(0, pageCount - 1));
  const drawable = hasContent(form, picture !== null) && pages !== null;
  const password = documentPassword ?? null;
  const set = <K extends keyof MarkForm>(key: K, value: MarkForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const list = useCallback(
    async (bytes: ArrayBuffer) => {
      const { result } = await client.callStatic<{ marks: ListedMark[] }>('marks.list', { password }, [bytes.slice(0)]);
      setMarks(result.marks);
    },
    [client, password],
  );

  // The file as it stands, when the panel opens and whenever it is reopened.
  const documentId = state.document?.id ?? null;
  const loaded = documentId !== null && loadedFor === documentId;
  const [listFailed, setListFailed] = useState(false);
  useEffect(() => {
    if (!ready || documentId === null) return;
    let cancelled = false;
    void (async () => {
      setListFailed(false);
      // The view may not hold the file yet — the tool chosen before a file
      // was opened, say — so it is asked again for a while.
      let bytes: ArrayBuffer | null = null;
      for (let attempt = 0; attempt < LOAD_ATTEMPTS && !cancelled; attempt += 1) {
        bytes = await services.fileBytesForChange().catch(() => null);
        if (bytes) break;
        await new Promise((wake) => setTimeout(wake, LOAD_RETRY_MS));
      }
      if (cancelled) return;
      try {
        if (!bytes) throw new Error('the file could not be read');
        base.current = bytes;
        await list(bytes);
      } catch {
        if (!cancelled) setListFailed(true);
      }
      // Listed or not, the panel can still add marks: Apply reads the file afresh.
      if (!cancelled) setLoadedFor(documentId);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per document
  }, [documentId, ready]);

  /** `marks.add` or `marks.preview`: the arguments and the blobs. */
  const request = useCallback(
    async (bytes: ArrayBuffer, extra: Record<string, unknown>) => {
      const blobs: ArrayBuffer[] = [bytes.slice(0)];
      const needsFont = !(form.section === 'watermark' && form.watermarkSource === 'picture');
      let fontBlob: number | undefined;
      let imageBlob: number | undefined;
      if (needsFont) {
        blobs.push((await loadEditFont(form.font)).slice().buffer);
        fontBlob = blobs.length - 1;
      }
      if (form.section === 'watermark' && form.watermarkSource === 'picture' && picture) {
        blobs.push(picture.bytes.slice(0));
        imageBlob = blobs.length - 1;
      }
      const args = {
        password,
        mark: specOf(form, { fileName: documentName, now: new Date() }),
        pages: pages ?? [],
        replace: true,
        replaceIds: changing ? [changing.id] : [],
        fontBlob,
        imageBlob,
        ...extra,
      };
      return { args, blobs };
    },
    [form, picture, password, documentName, pages, changing],
  );

  // The page on screen, drawn by the core with the mark on it.
  useEffect(() => {
    // Nothing to draw: the canvas is hidden (below) until there is.
    if (!loaded || !drawable) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const size = state.document?.pageSizes[previewPage];
          const width = canvas.current?.parentElement?.clientWidth ?? 240;
          const scale = Math.min(2, ((width || 240) * (globalThis.devicePixelRatio || 1)) / (size?.[0] ?? 600));
          // The file as the panel read it, or — when it could not then — now.
          base.current ??= await services.fileBytesForChange();
          if (!base.current) throw new Error('the file could not be read');
          const { args, blobs } = await request(base.current, { page: previewPage, scale });
          const { result, blobs: pixels } = await client.callStatic<{ width: number; height: number }>('marks.preview', args, blobs);
          if (!cancelled && pixels[0]) {
            setPreview({ width: result.width, height: result.height, rgba: pixels[0] });
            setPreviewFailed(false);
          }
        } catch {
          if (!cancelled) setPreviewFailed(true);
        }
      })();
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `services` changes with every file handed over; its reader does not
  }, [loaded, drawable, request, previewPage, client, state.document]);

  useEffect(() => {
    const element = canvas.current;
    if (!element || !preview) return;
    element.width = preview.width;
    element.height = preview.height;
    const context = element.getContext('2d');
    if (!context) return;
    context.putImageData(new ImageData(new Uint8ClampedArray(preview.rgba), preview.width, preview.height), 0, 0);
  }, [preview]);

  /** Writes a change through the core and hands the file to both views. */
  const change = async (run: (bytes: ArrayBuffer) => Promise<ArrayBuffer | undefined>, done: TKey) => {
    setBusy(true);
    try {
      // Fresh: something may have been drawn or filled since the panel opened.
      const bytes = await services.fileBytesForChange();
      // Said, not dropped: a change that cannot be made is a failure.
      if (!bytes) throw new Error('the file could not be read');
      const changed = await run(bytes);
      if (!changed) throw new Error('the core returned no file');
      base.current = changed.slice(0);
      await services.replaceFile(changed);
      await list(base.current);
      dispatch({ type: 'TOAST', key: done });
    } catch {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'marks.failed' });
    } finally {
      setBusy(false);
    }
  };

  const apply = () =>
    change(async (bytes) => {
      const { args, blobs } = await request(bytes, {});
      const { blobs: out } = await client.callStatic<{ id: number }>('marks.add', args, blobs);
      setChanging(null);
      return out[0];
    }, 'marks.applied');

  const remove = (ids: number[]) =>
    change(async (bytes) => {
      const { blobs: out } = await client.callStatic<{ removed: number }>('marks.remove', { password, ids }, [bytes]);
      if (changing && (ids.length === 0 || ids.includes(changing.id))) setChanging(null);
      return out[0];
    }, 'marks.removed');

  const startChange = (mark: ListedMark) => {
    setChanging(mark);
    setForm({ ...formOf(mark.spec ?? { kind: mark.kind }, DEFAULT_FORM), pages: pagesLabel(mark.pages).replace(/–/g, '-') });
    if (mark.kind === 'watermark' && mark.spec?.imageWidth !== undefined) setPicture(null);
  };

  const insertToken = (token: string) => {
    const { index, at } = focusedSlot.current;
    const slots = [...form.slots] as MarkForm['slots'];
    const text = slots[index] ?? '';
    const where = Math.min(at, text.length);
    slots[index] = `${text.slice(0, where)}${token}${text.slice(where)}`;
    focusedSlot.current = { index, at: where + token.length };
    set('slots', slots);
  };

  const positionSelect = (key: 'watermarkPosition' | 'numberPosition' | 'batesPosition', options: readonly MarkPosition[]) => (
    <Field label={t('marks.position')}>
      <select className="select" value={form[key]} onChange={(e) => set(key, e.target.value as MarkPosition)}>
        {options.map((p) => (
          <option key={p} value={p}>
            {t(`marks.position.${p}` as TKey)}
          </option>
        ))}
      </select>
    </Field>
  );

  const numberField = (key: keyof MarkForm, label: TKey, min: number, max: number) => (
    <Field label={t(label)}>
      <Stepper min={min} max={max} value={form[key] as number} onChange={(value) => set(key, value as never)} />
    </Field>
  );

  const numeralsSelect = (
    <Field label={t('marks.numerals')}>
      <select className="select" value={form.numerals} onChange={(e) => set('numerals', e.target.value as MarkForm['numerals'])}>
        <option value="western">{t('marks.western')}</option>
        <option value="arabic">{t('marks.arabicIndic')}</option>
      </select>
    </Field>
  );

  const fontSelect = (
    <Field label={t('marks.font')}>
      <select className="select" value={form.font} onChange={(e) => set('font', e.target.value as EditFontId)}>
        {EDIT_FONTS.map((face) => (
          <option key={face.id} value={face.id}>
            {face.name}
          </option>
        ))}
      </select>
    </Field>
  );

  const disabled = !ready || busy || !loaded;

  return (
    <div className="tool-panel marks-panel">
      <h3>
        <Icon of={Layers} />
        {t('tool.pageMarks')}
      </h3>
      <p className="tool-panel-note">{state.document === null ? t('tool.openFirst') : t('marks.intro')}</p>

      <fieldset disabled={disabled}>
        <legend>{t('marks.kind')}</legend>
        {SECTIONS.map((section) => (
          <label key={section}>
            <input
              type="radio"
              name="marks-kind"
              checked={form.section === section}
              // A mark being changed stays its own kind.
              disabled={changing !== null && form.section !== section}
              onChange={() => set('section', section)}
            />
            <span>{t(`marks.section.${section}` as TKey)}</span>
          </label>
        ))}
      </fieldset>

      {changing && (
        <p className="marks-changing" role="status">
          <span>{t('marks.changing', { what: t(`marks.kind.${changing.kind}` as TKey) })}</span>
          <IconButton label={t('marks.cancelChange')} icon={<Icon of={X} />} onClick={() => setChanging(null)} />
        </p>
      )}

      {form.section === 'watermark' && (
        <>
          <fieldset disabled={disabled}>
            <legend>{t('marks.source')}</legend>
            {(['text', 'picture'] as const).map((source) => (
              <label key={source}>
                <input type="radio" name="marks-source" checked={form.watermarkSource === source} onChange={() => set('watermarkSource', source)} />
                <span>{t(source === 'text' ? 'marks.sourceText' : 'marks.sourcePicture')}</span>
              </label>
            ))}
            {form.watermarkSource === 'text' ? (
              <Field label={t('marks.text')}>
                <input className="text-input" dir="auto" value={form.watermarkText} placeholder={t('marks.textPlaceholder')} onChange={(e) => set('watermarkText', e.target.value)} />
              </Field>
            ) : (
              <>
                <input
                  ref={pictureInput}
                  type="file"
                  accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                  className="sr-only"
                  aria-label={t('marks.picture')}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) setPicture({ name: file.name, bytes: await file.arrayBuffer() });
                  }}
                />
                <button type="button" className="icon-btn icon-btn-labeled" onClick={() => pictureInput.current?.click()}>
                  <Icon of={ImagePlus} />
                  <span>{picture ? t('marks.pictureChosen', { name: picture.name }) : t('marks.picture')}</span>
                </button>
              </>
            )}
          </fieldset>
          <fieldset disabled={disabled}>
            <legend>{t('marks.look')}</legend>
            <div className="marks-grid">
              {form.watermarkSource === 'text' ? (
                <>
                  {numberField('watermarkSize', 'marks.size', 6, 400)}
                  {fontSelect}
                  <Field label={t('marks.color')}>
                    <input className="marks-color" type="color" value={form.color} onChange={(e) => set('color', e.target.value)} />
                  </Field>
                </>
              ) : (
                numberField('imageWidth', 'marks.imageWidth', 5, 100)
              )}
              {numberField('opacity', 'marks.opacity', 5, 100)}
              {numberField('rotation', 'marks.rotation', -180, 180)}
              {positionSelect('watermarkPosition', [...POSITIONS, 'tiled'])}
            </div>
            {([true, false] as const).map((front) => (
              <label key={String(front)}>
                <input type="radio" name="marks-layer" checked={form.front === front} onChange={() => set('front', front)} />
                <span>{t(front ? 'marks.front' : 'marks.behind')}</span>
              </label>
            ))}
          </fieldset>
        </>
      )}

      {form.section === 'band' && (
        <>
          <fieldset disabled={disabled}>
            <legend>{t('marks.band')}</legend>
            {(['header', 'footer'] as const).map((band) => (
              <label key={band}>
                <input type="radio" name="marks-band" checked={form.band === band} onChange={() => set('band', band)} />
                <span>{t(band === 'header' ? 'marks.header' : 'marks.footer')}</span>
              </label>
            ))}
          </fieldset>
          <fieldset disabled={disabled}>
            <legend>{t('marks.slots')}</legend>
            {(['marks.slotStart', 'marks.slotCenter', 'marks.slotEnd'] as const).map((label, index) => (
              <Field key={label} label={t(label)}>
                <input
                  className="text-input"
                  dir="auto"
                  value={form.slots[index]}
                  onFocus={(e) => (focusedSlot.current = { index, at: e.target.selectionStart ?? e.target.value.length })}
                  onSelect={(e) => (focusedSlot.current = { index, at: e.currentTarget.selectionStart ?? 0 })}
                  onChange={(e) => {
                    const slots = [...form.slots] as MarkForm['slots'];
                    slots[index] = e.target.value;
                    focusedSlot.current = { index, at: e.target.selectionStart ?? e.target.value.length };
                    set('slots', slots);
                  }}
                />
              </Field>
            ))}
            <div className="marks-tokens" role="group" aria-label={t('marks.insert')}>
              <span>{t('marks.insert')}</span>
              {TOKENS.map((token) => (
                <button key={token} type="button" className="marks-token" onMouseDown={(e) => e.preventDefault()} onClick={() => insertToken(token)}>
                  {t(TOKEN_LABELS[token])}
                </button>
              ))}
            </div>
            <p className="tool-panel-note">{t('marks.slotsHint')}</p>
          </fieldset>
          <fieldset disabled={disabled}>
            <legend>{t('marks.look')}</legend>
            <div className="marks-grid">
              <Field label={t('marks.direction')}>
                <select className="select" value={form.direction} onChange={(e) => set('direction', e.target.value as MarkForm['direction'])}>
                  <option value="auto">{t('marks.directionAuto')}</option>
                  <option value="rtl">{t('marks.directionRtl')}</option>
                  <option value="ltr">{t('marks.directionLtr')}</option>
                </select>
              </Field>
              <Field label={t('marks.calendar')}>
                <select className="select" value={form.calendar} onChange={(e) => set('calendar', e.target.value as MarkForm['calendar'])}>
                  <option value="gregorian">{t('marks.gregorian')}</option>
                  <option value="hijri">{t('marks.hijri')}</option>
                </select>
              </Field>
              {numeralsSelect}
              {fontSelect}
              {numberField('size', 'marks.size', 5, 72)}
              {numberField('margin', 'marks.margin', 0, 200)}
            </div>
          </fieldset>
        </>
      )}

      {form.section === 'pageNumber' && (
        <fieldset disabled={disabled}>
          <legend>{t('marks.numbering')}</legend>
          <div className="marks-grid">
            <Field label={t('marks.format')}>
              <select className="select" value={form.numberFormat} onChange={(e) => set('numberFormat', e.target.value as MarkForm['numberFormat'])}>
                {(['plain', 'ofTotal', 'pageOfEnglish', 'pageOfArabic', 'roman'] as const).map((format) => (
                  <option key={format} value={format}>
                    {t(`marks.format.${format}` as TKey, pageNumberSample(form.numerals, Math.max(0, Math.floor(form.startNumber))))}
                  </option>
                ))}
              </select>
            </Field>
            {numeralsSelect}
            {numberField('startNumber', 'marks.start', 0, 99999)}
            {positionSelect('numberPosition', EDGE_POSITIONS)}
            {numberField('size', 'marks.size', 5, 72)}
            {numberField('margin', 'marks.margin', 0, 200)}
            {fontSelect}
          </div>
          <label>
            <input type="checkbox" checked={form.skipFirst} onChange={(e) => set('skipFirst', e.target.checked)} />
            <span>{t('marks.skipFirst')}</span>
          </label>
        </fieldset>
      )}

      {form.section === 'bates' && (
        <fieldset disabled={disabled}>
          <legend>{t('marks.numbering')}</legend>
          <div className="marks-grid">
            <Field label={t('marks.prefix')}>
              <input className="text-input" dir="auto" value={form.batesPrefix} onChange={(e) => set('batesPrefix', e.target.value)} />
            </Field>
            <Field label={t('marks.suffix')}>
              <input className="text-input" dir="auto" value={form.batesSuffix} onChange={(e) => set('batesSuffix', e.target.value)} />
            </Field>
            {numberField('batesStart', 'marks.start', 0, 999999999)}
            {numberField('batesDigits', 'marks.digits', 1, 20)}
            {positionSelect('batesPosition', EDGE_POSITIONS)}
            {numberField('size', 'marks.size', 5, 72)}
            {numberField('margin', 'marks.margin', 0, 200)}
            {fontSelect}
          </div>
        </fieldset>
      )}

      <fieldset disabled={disabled}>
        <legend>{t('marks.pages')}</legend>
        <Field label={t('marks.pagesLabel')}>
          <input
            className="text-input"
            dir="ltr"
            inputMode="numeric"
            value={form.pages}
            placeholder={t('marks.pagesAll')}
            aria-invalid={pages === null}
            onChange={(e) => set('pages', e.target.value)}
          />
        </Field>
        {pages === null ? (
          <p className="field-error" role="alert">
            {t('marks.pagesInvalid')}
          </p>
        ) : (
          <p className="tool-panel-note">{t('marks.pagesHint')}</p>
        )}
      </fieldset>

      <figure className="marks-preview">
        <canvas ref={canvas} hidden={!preview || !drawable || !loaded} aria-label={t('marks.preview', { page: previewPage + 1 })} role="img" />
        <figcaption className="tool-panel-note">
          {previewFailed && drawable ? t('marks.previewFailed') : t('marks.preview', { page: previewPage + 1 })}
        </figcaption>
      </figure>

      <div className="tool-actions">
        <IconButton
          label={busy ? t('marks.working') : t(changing ? 'marks.applyChange' : 'marks.apply')}
          icon={<Icon of={Layers} />}
          showLabel
          variant="primary"
          disabled={disabled || !drawable}
          onClick={() => void apply()}
        />
      </div>
      <p className="tool-panel-note">{t('marks.replaceNote')}</p>

      <fieldset className="marks-list">
        <legend>{t('marks.inFile')}</legend>
        {listFailed && (
          <p className="tool-panel-note" role="status">
            {t('marks.listFailed')}
          </p>
        )}
        {loaded && !listFailed && marks.length === 0 && <p className="tool-panel-note">{t('marks.none')}</p>}
        {marks.length > 0 && (
          <ul>
            {marks.map((mark) => (
              <li key={mark.id} className="marks-item">
                <span className="marks-item-text">
                  <strong>{t(`marks.kind.${mark.kind}` as TKey)}</strong>
                  <span dir="auto">{summary(mark, t)}</span>
                  <span className="tool-panel-note">{t('marks.onPages', { pages: pagesLabel(mark.pages) })}</span>
                </span>
                <IconButton label={t('marks.change')} icon={<Icon of={Pencil} />} disabled={disabled} onClick={() => startChange(mark)} />
                <IconButton label={t('marks.remove')} icon={<Icon of={Trash} />} disabled={disabled} onClick={() => void remove([mark.id])} />
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {marks.length > 1 && (
        <div className="tool-actions">
          <IconButton label={t('marks.removeAll')} icon={<Icon of={Trash} />} showLabel disabled={disabled} onClick={() => void remove([])} />
        </div>
      )}
    </div>
  );
}
