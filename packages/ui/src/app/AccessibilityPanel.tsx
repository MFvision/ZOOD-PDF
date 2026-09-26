/**
 * Accessibility panel (side slot, tools/panels.ts): auto-tag (title + language asked here), the
 * reading-order list (type badges, text in logical order, drag or Alt+↑/↓ to reorder, change type,
 * language, merge/split, decorative), alt text for pictures (Arabic or English, with /Lang), and a
 * PDF/UA-style checker (Matterhorn-inspired subset, not a certified validator) with fixes.
 *
 * Reads run on a private engine copy; every change is one incremental update through `coreEdit`
 * (shared undo history, viewer reloads). The reading order is also drawn over the page (numbered
 * boxes) in the viewer area through a portal.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../services/AppContext';
import { EngineError } from '../services/engine';
import type { OpenDocument } from '../services/state';
import type { ViewerApi } from '../viewer/Viewer';
import { formatNumber, type MessageKey } from '../i18n';
import en from '../i18n/en.json';
import {
  A11yDoc,
  ASSIGNABLE_TYPES,
  LANGUAGES,
  dropIndex,
  figuresOf,
  findingArgs,
  groupFindings,
  moveIndex,
  overlayBoxes,
  suggestTitle,
  type A11yElement,
  type A11yFinding,
  type A11yListing,
  type A11yReport,
} from '../services/a11y';
import { rectToView, type PageGeometry } from '../services/editor';
import { IconButton } from './primitives';

const known = (key: string): key is MessageKey => key in en;

type Tab = 'order' | 'alt' | 'check';

export function AccessibilityPanel({
  doc,
  api,
  page,
  overlayHost,
  onClose,
}: {
  doc: OpenDocument;
  api: ViewerApi | null;
  /** Current page (1-based) shown by the viewer. */
  page: number;
  /** The viewer area: the reading-order overlay is drawn there. */
  overlayHost: HTMLDivElement | null;
  onClose: () => void;
}) {
  const app = useApp();
  const { t } = app;
  const locale = app.state.locale;
  const session = useMemo(() => new A11yDoc(app.engine(), doc.id), [app, doc.id]);
  useEffect(() => () => void session.close(), [session]);

  const [listing, setListing] = useState<A11yListing | null>(null);
  const [pages, setPages] = useState<{ width: number; height: number; rotation: number }[]>([]);
  const [tab, setTab] = useState<Tab>('order');
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<A11yReport | null>(null);
  const [showOnPage, setShowOnPage] = useState(true);
  const [title, setTitle] = useState<string | null>(null);
  const [lang, setLang] = useState<string>('auto');
  const listRef = useRef<HTMLOListElement>(null);
  const host = overlayHost;

  const failure = useCallback(
    (e: unknown) => {
      if (e instanceof EngineError && e.code === 'permission_denied') return t('a11y.error.permission');
      if (e instanceof EngineError && e.code === 'not_possible') return t('a11y.error.notPossible', { reason: e.message });
      return t('a11y.error.failed', { reason: e instanceof Error ? e.message : String(e) });
    },
    [t],
  );

  // The structure of every new version of the bytes (each change, undo/redo, a save).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await session.sync(doc.bytes, doc.password);
        const [l, p] = await Promise.all([session.structure(), session.pages()]);
        if (!alive) return;
        setListing(l);
        setPages(p);
        setTitle((cur) => cur ?? l.title ?? suggestTitle(doc.name));
      } catch (e) {
        if (alive) setError(failure(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [session, doc.bytes, doc.password, doc.name, failure]);

  /** One engine change as an undoable incremental update; reloads the listing from the result. */
  const change = async (label: string, method: string, params: Record<string, unknown>): Promise<Uint8Array | null> => {
    if (busy) return null;
    setBusy(method);
    setError(null);
    try {
      const r = await app.coreEdit(doc.id, [{ method, params }], label);
      return r?.bytes ?? null;
    } catch (e) {
      setError(failure(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const autotag = async (mode: 'untagged' | 'retag') => {
    const params: Record<string, unknown> = { mode };
    if (title?.trim()) params.title = title.trim();
    if (lang !== 'auto') params.lang = lang;
    const ok = await change(t('tool.accessibility.name'), 'a11y.autotag', params);
    if (ok) app.toast(t('a11y.autotag.done'), 'success');
  };

  const runCheck = async (bytes?: Uint8Array) => {
    setBusy('check');
    setError(null);
    try {
      if (bytes) await session.sync(bytes, doc.password);
      setReport(await session.check());
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(null);
    }
  };

  const fix = async (rules: string[]) => {
    const params: Record<string, unknown> = { rules };
    if (title?.trim()) params.title = title.trim();
    const bytes = await change(t('a11y.check.fixAll'), 'a11y.fix', params);
    if (bytes) {
      app.toast(t('a11y.check.fixed'), 'success');
      await runCheck(bytes);
    }
  };

  const elements = useMemo(() => listing?.elements ?? [], [listing]);
  const sel = elements.find((e) => e.id !== null && e.id === selected) ?? null;
  const editable = !!listing && listing.tagged && !listing.truncated;

  const move = async (id: number, index: number) => {
    const ok = await change(t('a11y.order.moved'), 'a11y.move', { id, index });
    if (ok) {
      setSelected(id);
      requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.focus());
    }
  };

  const typeLabel = (role: string) => {
    const k = `a11y.type.${role}`;
    return known(k) ? t(k) : role;
  };
  const langLabel = (l: string) => {
    const k = `a11y.lang.${l}`;
    return known(k) ? t(k) : l;
  };

  const onRowKey = (e: React.KeyboardEvent<HTMLLIElement>, el: A11yElement, i: number) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const delta = e.key === 'ArrowUp' ? -1 : 1;
    if (e.altKey && el.id !== null && editable) {
      const to = moveIndex(elements, el.id, delta);
      if (to !== null) void move(el.id, to);
      return;
    }
    const next = elements[i + delta];
    if (next) {
      setSelected(next.id);
      listRef.current?.querySelector<HTMLElement>(`[data-index="${i + delta}"]`)?.focus();
    }
  };

  const [drag, setDrag] = useState<number | null>(null);

  const pageIndex = Math.max(0, page - 1);
  const overlay =
    host && listing?.tagged && showOnPage && tab === 'order' && api && !doc.switching
      ? createPortal(
          <OrderOverlay
            api={api}
            revision={doc.revision}
            pageIndex={pageIndex}
            geom={pages[pageIndex] ? { ...pages[pageIndex], rotation: ((pages[pageIndex].rotation % 360) + 360) % 360 } : null}
            elements={elements}
            selected={sel}
            onSelect={(id) => {
              setSelected(id);
              listRef.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
            }}
          />,
          host,
        )
      : null;

  return (
    <aside className="tool-panel glass a11y-panel" aria-label={t('a11y.title')} data-testid="a11y-panel" data-busy={busy !== null || !listing}>
      {overlay}
      <header className="tool-panel-head">
        <h2 className="panel-title">{t('a11y.title')}</h2>
        <IconButton icon="close" label={t('a11y.close')} onClick={onClose} size={16} />
      </header>
      <div className="tool-panel-body">
        <p className="fineprint">{t('a11y.subtitle')}</p>
        {!listing && !error && <p className="fineprint">{t('a11y.loading')}</p>}
        {error && (
          <p className="std-error" role="alert">
            {error}
          </p>
        )}
        {listing && (
          <div className="a11y-status" data-testid="a11y-status" data-tagged={listing.tagged} data-lang={listing.lang ?? ''}>
            <span className={`std-badge ${listing.tagged ? 'fixable' : 'manual'}`}>{listing.tagged ? t('a11y.status.tagged') : t('a11y.status.untagged')}</span>
            <span>{listing.lang ? t('a11y.status.lang', { lang: langLabel(listing.lang) }) : t('a11y.status.noLang')}</span>
            <bdi dir="auto">{listing.title ? t('a11y.status.title', { title: listing.title }) : t('a11y.status.noTitle')}</bdi>
            {listing.tagged && <span>{t('a11y.status.elements', { count: elements.length })}</span>}
          </div>
        )}

        {listing && !listing.tagged && (
          <section className="a11y-autotag tool-form" aria-label={t('a11y.autotag.heading')}>
            <h3 className="std-h3">{t('a11y.autotag.heading')}</h3>
            <p className="fineprint">{t('a11y.autotag.intro')}</p>
            <TagForm title={title ?? ''} setTitle={setTitle} lang={lang} setLang={setLang} langLabel={langLabel} />
            <button type="button" className="btn btn-primary" onClick={() => void autotag('untagged')} disabled={busy !== null} data-testid="a11y-autotag">
              {busy === 'a11y.autotag' ? t('a11y.autotag.running') : t('a11y.autotag.run')}
            </button>
          </section>
        )}

        {listing?.tagged && (
          <>
            <details className="a11y-more">
              <summary>{t('a11y.autotag.more')}</summary>
              <div className="tool-form">
                <TagForm title={title ?? ''} setTitle={setTitle} lang={lang} setLang={setLang} langLabel={langLabel} />
                <button type="button" className="btn" onClick={() => void autotag('untagged')} disabled={busy !== null || !editable} data-testid="a11y-tag-untagged">
                  {t('a11y.autotag.untagged')}
                </button>
                <button type="button" className="btn" onClick={() => void autotag('retag')} disabled={busy !== null} data-testid="a11y-retag">
                  {t('a11y.autotag.retag')}
                </button>
                <p className="fineprint">{t('a11y.autotag.retagHint')}</p>
              </div>
            </details>
            <div className="a11y-tabs" role="tablist" aria-label={t('a11y.tabs')}>
              {(['order', 'alt', 'check'] as Tab[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  id={`a11y-tab-${k}`}
                  aria-selected={tab === k}
                  aria-controls={`a11y-pane-${k}`}
                  className={`a11y-tab${tab === k ? ' on' : ''}`}
                  data-tab={k}
                  onClick={() => setTab(k)}
                >
                  {t(`a11y.tab.${k}` as MessageKey)}
                </button>
              ))}
            </div>
          </>
        )}

        {listing?.tagged && tab === 'order' && (
          <section id="a11y-pane-order" role="tabpanel" aria-labelledby="a11y-tab-order" className="a11y-pane">
            {listing.truncated && <p className="fineprint">{t('a11y.order.truncated')}</p>}
            <p className="fineprint">{t('a11y.order.hint')}</p>
            <label className="check-row">
              <input type="checkbox" checked={showOnPage} onChange={(e) => setShowOnPage(e.target.checked)} data-testid="a11y-show-on-page" />
              {t('a11y.order.showOnPage')}
            </label>
            {sel && sel.id !== null && editable && (
              <ElementEditor
                el={sel}
                elements={elements}
                busy={busy !== null}
                typeLabel={typeLabel}
                langLabel={langLabel}
                onMove={(to) => void move(sel.id!, to)}
                onType={(ty) => void change(t('a11y.order.type'), 'a11y.setType', { id: sel.id, type: ty })}
                onLang={(l) => void change(t('a11y.order.lang'), 'a11y.setLang', { id: sel.id, lang: l || null })}
                onMerge={() => void change(t('a11y.order.merge'), 'a11y.merge', { id: sel.id })}
                onSplit={() => void change(t('a11y.order.split'), 'a11y.split', { id: sel.id })}
                onDecorative={() => void change(t('a11y.order.decorative'), 'a11y.decorative', { id: sel.id }).then(() => setSelected(null))}
              />
            )}
            {elements.length === 0 ? (
              <p className="fineprint">{t('a11y.order.empty')}</p>
            ) : (
              <ol className="a11y-list" ref={listRef} aria-label={t('a11y.order.list')} data-testid="a11y-order" role="listbox">
                {elements.map((el, i) => (
                  <li
                    key={`${el.id ?? 'd'}-${i}`}
                    role="option"
                    aria-selected={el.id !== null && el.id === selected}
                    tabIndex={(selected === null ? i === 0 : el.id === selected) ? 0 : -1}
                    className={`a11y-row${el.id !== null && el.id === selected ? ' on' : ''}${drag !== null && drag === el.id ? ' dragging' : ''}`}
                    style={{ paddingInlineStart: 6 + Math.min(el.depth, 8) * 14 }}
                    data-id={el.id ?? undefined}
                    data-index={i}
                    data-role={el.role}
                    data-depth={el.depth}
                    draggable={editable && el.id !== null && el.depth > 0}
                    onClick={() => setSelected(el.id)}
                    onKeyDown={(e) => onRowKey(e, el, i)}
                    onDragStart={(e) => {
                      if (el.id === null) return;
                      setDrag(el.id);
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', String(el.id));
                    }}
                    onDragEnd={() => setDrag(null)}
                    onDragOver={(e) => {
                      if (drag !== null && el.id !== null && dropIndex(elements, drag, el.id) !== null) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (drag === null || el.id === null) return;
                      const to = dropIndex(elements, drag, el.id);
                      const id = drag;
                      setDrag(null);
                      if (to !== null) void move(id, to);
                    }}
                  >
                    <span className="a11y-n">{formatNumber(i + 1, locale)}</span>
                    <span className={`a11y-type role-${el.role}`}>{typeLabel(el.role)}</span>
                    <bdi className="a11y-text" dir="auto">
                      {el.role === 'Figure' ? el.alt || t('a11y.alt.missing') : el.text || t('a11y.order.noText')}
                    </bdi>
                    {el.lang && <span className="a11y-lang">{el.lang}</span>}
                    {el.page !== null && el.depth <= 1 && <span className="a11y-pg">{t('a11y.order.page', { page: el.page + 1 })}</span>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}

        {listing?.tagged && tab === 'alt' && (
          <section id="a11y-pane-alt" role="tabpanel" aria-labelledby="a11y-tab-alt" className="a11y-pane" data-testid="a11y-alt">
            {figuresOf(elements).length === 0 && <p className="fineprint">{t('a11y.alt.empty')}</p>}
            {figuresOf(elements).map((f, i) => (
              <FigureCard
                key={`${f.id}:${f.alt ?? ''}`}
                el={f}
                n={i + 1}
                busy={busy !== null}
                langLabel={langLabel}
                defaultLang={f.lang ?? listing.lang ?? (locale === 'ar' ? 'ar' : 'en')}
                onSave={async (alt, l) => {
                  const ok = await change(t('a11y.alt.save'), 'a11y.setAlt', { id: f.id, alt, lang: l });
                  if (ok) app.toast(t('a11y.alt.saved'), 'success');
                }}
                onDecorative={() => void change(t('a11y.order.decorative'), 'a11y.decorative', { id: f.id })}
              />
            ))}
          </section>
        )}

        {listing?.tagged && tab === 'check' && (
          <section id="a11y-pane-check" role="tabpanel" aria-labelledby="a11y-tab-check" className="a11y-pane">
            <CheckPane
              report={report}
              busy={busy}
              title={title ?? ''}
              setTitle={setTitle}
              onRun={() => void runCheck()}
              onFix={(rules) => void fix(rules)}
              onShow={(id) => {
                setTab('order');
                setSelected(id);
                requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' }));
              }}
            />
          </section>
        )}
        {listing && !listing.tagged && (
          <section className="a11y-pane" aria-label={t('a11y.tab.check')}>
            <CheckPane report={report} busy={busy} title={title ?? ''} setTitle={setTitle} onRun={() => void runCheck()} onFix={(rules) => void fix(rules)} />
          </section>
        )}
      </div>
    </aside>
  );
}

function TagForm({
  title,
  setTitle,
  lang,
  setLang,
  langLabel,
}: {
  title: string;
  setTitle: (v: string) => void;
  lang: string;
  setLang: (v: string) => void;
  langLabel: (l: string) => string;
}) {
  const { t } = useApp();
  return (
    <>
      <label className="field-label">
        {t('a11y.autotag.titleLabel')}
        <input className="text-input" dir="auto" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="a11y-title" />
        <span className="fineprint">{t('a11y.autotag.titleHint')}</span>
      </label>
      <label className="field-label">
        {t('a11y.autotag.lang')}
        <select className="select" value={lang} onChange={(e) => setLang(e.target.value)} data-testid="a11y-lang">
          <option value="auto">{t('a11y.lang.auto')}</option>
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {langLabel(l)}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function ElementEditor({
  el,
  elements,
  busy,
  typeLabel,
  langLabel,
  onMove,
  onType,
  onLang,
  onMerge,
  onSplit,
  onDecorative,
}: {
  el: A11yElement;
  elements: A11yElement[];
  busy: boolean;
  typeLabel: (r: string) => string;
  langLabel: (l: string) => string;
  onMove: (index: number) => void;
  onType: (ty: string) => void;
  onLang: (l: string) => void;
  onMerge: () => void;
  onSplit: () => void;
  onDecorative: () => void;
}) {
  const { t } = useApp();
  const id = el.id!;
  const up = moveIndex(elements, id, -1);
  const down = moveIndex(elements, id, 1);
  const types: string[] = ASSIGNABLE_TYPES.includes(el.role as (typeof ASSIGNABLE_TYPES)[number]) ? [...ASSIGNABLE_TYPES] : [el.role, ...ASSIGNABLE_TYPES];
  return (
    <div className="a11y-editor" data-testid="a11y-editor" data-id={id} aria-label={t('a11y.order.selected')} role="group">
      <div className="a11y-editor-row">
        <button type="button" className="btn btn-small" disabled={busy || up === null} onClick={() => up !== null && onMove(up)} data-testid="a11y-up">
          {t('a11y.order.moveUp')}
        </button>
        <button type="button" className="btn btn-small" disabled={busy || down === null} onClick={() => down !== null && onMove(down)} data-testid="a11y-down">
          {t('a11y.order.moveDown')}
        </button>
      </div>
      <div className="a11y-editor-row">
        <label className="field-label">
          {t('a11y.order.type')}
          <select className="select" value={el.role} disabled={busy || el.depth === 0} onChange={(e) => onType(e.target.value)} data-testid="a11y-type">
            {types.map((ty) => (
              <option key={ty} value={ty}>
                {typeLabel(ty)}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          {t('a11y.order.lang')}
          <select className="select" value={el.lang ?? ''} disabled={busy} onChange={(e) => onLang(e.target.value)} data-testid="a11y-el-lang">
            <option value="">{t('a11y.lang.none')}</option>
            {[...new Set([...(el.lang ? [el.lang] : []), ...LANGUAGES])].map((l) => (
              <option key={l} value={l}>
                {langLabel(l)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="a11y-editor-row">
        <button type="button" className="btn btn-small" disabled={busy || down === null} onClick={onMerge} data-testid="a11y-merge">
          {t('a11y.order.merge')}
        </button>
        <button type="button" className="btn btn-small" disabled={busy || el.mcids + el.children < 2} onClick={onSplit} data-testid="a11y-split">
          {t('a11y.order.split')}
        </button>
        <button type="button" className="btn btn-small" disabled={busy || el.annotations > 0 || el.depth === 0} onClick={onDecorative} data-testid="a11y-decorative">
          {t('a11y.order.decorative')}
        </button>
      </div>
    </div>
  );
}

function FigureCard({
  el,
  n,
  busy,
  defaultLang,
  langLabel,
  onSave,
  onDecorative,
}: {
  el: A11yElement;
  n: number;
  busy: boolean;
  defaultLang: string;
  langLabel: (l: string) => string;
  onSave: (alt: string, lang: string) => void | Promise<void>;
  onDecorative: () => void;
}) {
  const { t } = useApp();
  const [alt, setAlt] = useState(el.alt ?? '');
  const [lang, setLang] = useState(defaultLang);
  const langs = [...new Set([lang, ...LANGUAGES])];
  return (
    <div className="a11y-figure" data-testid="a11y-figure" data-id={el.id ?? undefined}>
      <h4 className="std-rule-title">{t('a11y.alt.figure', { n, page: (el.page ?? 0) + 1 })}</h4>
      {!el.alt && <span className="std-badge manual">{t('a11y.alt.missing')}</span>}
      <label className="field-label">
        {t('a11y.alt.label')}
        <textarea className="text-input a11y-alt-input" dir="auto" rows={3} value={alt} placeholder={t('a11y.alt.placeholder')} onChange={(e) => setAlt(e.target.value)} data-testid="a11y-alt-text" />
      </label>
      <label className="field-label">
        {t('a11y.alt.lang')}
        <select className="select" value={lang} onChange={(e) => setLang(e.target.value)} data-testid="a11y-alt-lang">
          {langs.map((l) => (
            <option key={l} value={l}>
              {langLabel(l)}
            </option>
          ))}
        </select>
      </label>
      <div className="a11y-editor-row">
        <button type="button" className="btn btn-primary btn-small" disabled={busy || alt.trim() === (el.alt ?? '')} onClick={() => void onSave(alt.trim(), lang)} data-testid="a11y-alt-save">
          {t('a11y.alt.save')}
        </button>
        <button type="button" className="btn btn-small" disabled={busy} onClick={onDecorative} data-testid="a11y-alt-decorative">
          {t('a11y.alt.decorative')}
        </button>
      </div>
    </div>
  );
}

function CheckPane({
  report,
  busy,
  title,
  setTitle,
  onRun,
  onFix,
  onShow,
}: {
  report: A11yReport | null;
  busy: string | null;
  title: string;
  setTitle: (v: string) => void;
  onRun: () => void;
  onFix: (rules: string[]) => void;
  onShow?: (id: number) => void;
}) {
  const { t } = useApp();
  const needsTitle = !!report?.findings.some((f) => f.rule === 'title');
  return (
    <div className="a11y-check" data-testid="a11y-check">
      <button type="button" className="btn btn-primary std-run" onClick={onRun} disabled={busy !== null} data-testid="a11y-run-check">
        {busy === 'check' ? t('a11y.check.running') : t('a11y.check.run')}
      </button>
      {!report && <p className="fineprint">{t('a11y.check.empty')}</p>}
      {report && (
        <div className="std-report" data-testid="a11y-report" data-passed={report.passed} data-errors={report.errorCount} data-warnings={report.warningCount}>
          <p className={`std-verdict ${report.passed ? 'ok' : 'bad'}`} role="status">
            {report.passed ? t('a11y.check.passed') : t('a11y.check.failed')}
          </p>
          <p className="fineprint">{t('a11y.check.counts', { errors: report.errorCount, warnings: report.warningCount })}</p>
          {report.incomplete && <p className="fineprint">{t('a11y.check.incomplete')}</p>}
          {needsTitle && (
            <label className="field-label">
              {t('a11y.check.titleNeeded')}
              <input className="text-input" dir="auto" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="a11y-check-title" />
            </label>
          )}
          {report.fixableCount > 0 && (
            <button type="button" className="btn std-fix" onClick={() => onFix([])} disabled={busy !== null} data-testid="a11y-fix-all">
              {busy === 'a11y.fix' ? t('a11y.check.fixing') : t('a11y.check.fixAll')}
            </button>
          )}
          {groupFindings(report.findings).map((g) => (
            <section key={g.rule} className="std-group" data-rule={g.rule}>
              <h4 className="std-rule-title">
                {known(`a11y.rule.${g.rule}`) ? t(`a11y.rule.${g.rule}` as MessageKey) : g.rule}{' '}
                <span className="std-meta">
                  {g.items[0]!.clause !== '—' && <span className="std-ref">{t('a11y.check.clause', { clause: g.items[0]!.clause })}</span>}
                  {g.items[0]!.matterhorn && <span className="std-ref">{t('a11y.check.matterhorn', { id: g.items[0]!.matterhorn })}</span>}
                </span>
              </h4>
              <ul className="std-findings">
                {g.items.map((f, i) => (
                  <FindingRow key={i} f={f} busy={busy !== null} onFix={() => onFix([f.rule])} onShow={onShow} />
                ))}
              </ul>
              {(report.counts[g.rule] ?? 0) > g.items.length && <p className="fineprint">{t('a11y.check.more', { count: (report.counts[g.rule] ?? 0) - g.items.length })}</p>}
            </section>
          ))}
          <p className="fineprint std-note" data-testid="a11y-not-certified">
            {t('a11y.check.note', { rules: report.rulesChecked })}
          </p>
        </div>
      )}
    </div>
  );
}

function FindingRow({ f, busy, onFix, onShow }: { f: A11yFinding; busy: boolean; onFix: () => void; onShow?: (id: number) => void }) {
  const { t } = useApp();
  const text = known(f.key) ? t(f.key, findingArgs(f.params)) : f.message;
  const badge = f.fixable ? f.fix : 'manual';
  return (
    <li className={`std-finding ${f.severity}`} data-rule={f.rule} data-variant={f.variant} data-fixable={f.fixable}>
      <span className="std-msg">{text}</span>
      <span className="std-meta">
        {f.object && <bdi className="std-ref">{f.object}</bdi>}
        {f.page !== null && <span>{t('a11y.check.page', { page: f.page + 1 })}</span>}
        <span className={`std-badge ${f.severity === 'warning' ? 'warning' : f.fixable ? 'fixable' : 'manual'}`}>{t(`a11y.badge.${f.severity}` as MessageKey)}</span>
        <span className="std-badge">{t(`a11y.badge.${badge}` as MessageKey)}</span>
        {f.element !== null && onShow && (
          <button type="button" className="btn btn-small a11y-link" onClick={() => onShow(f.element!)}>
            {t('a11y.check.show')}
          </button>
        )}
        {f.fixable && f.fix !== 'manual' && (
          <button type="button" className="btn btn-small" disabled={busy} onClick={onFix} data-testid="a11y-fix-one">
            {t('a11y.check.fix')}
          </button>
        )}
      </span>
    </li>
  );
}

/** The current page with the reading order drawn as numbered boxes (portal into the viewer area). */
function OrderOverlay({
  api,
  revision,
  pageIndex,
  geom,
  elements,
  selected,
  onSelect,
}: {
  api: ViewerApi;
  revision: number;
  pageIndex: number;
  geom: PageGeometry | null;
  elements: A11yElement[];
  selected: A11yElement | null;
  onSelect: (id: number) => void;
}) {
  const { t } = useApp();
  const { state } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [picture, setPicture] = useState<string | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const view = geom ? (geom.rotation % 180 === 0 ? { w: geom.width, h: geom.height } : { w: geom.height, h: geom.width }) : { w: 612, h: 792 };
  const scale = Math.max(0.3, Math.min(2.5, (width - 48) / view.w));
  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    api
      .renderPage(pageIndex, Math.round(view.w * scale * dpr))
      .then((blob) => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setPicture(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (url) setTimeout(() => URL.revokeObjectURL(url!), 1000);
    };
  }, [api, revision, pageIndex, view.w, scale]);
  const boxes = geom ? overlayBoxes(elements, pageIndex) : [];
  const box = (b: [number, number, number, number]) => {
    const r = rectToView(geom!, { x0: b[0], y0: b[1], x1: b[2], y1: b[3] });
    return { left: r.left * scale - 3, top: r.top * scale - 3, width: r.width * scale + 6, height: r.height * scale + 6 };
  };
  const selBox = selected?.bbox && selected.page === pageIndex && geom ? box(selected.bbox) : null;
  return (
    <div className="a11y-surface" ref={ref} data-testid="a11y-overlay" aria-label={t('a11y.order.overlay', { page: pageIndex + 1 })} role="region">
      <div className="a11y-page" dir="ltr" style={{ width: view.w * scale, height: view.h * scale }}>
        {picture && <img src={picture} alt="" draggable={false} />}
        {geom &&
          boxes.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`a11y-box role-${b.role}${selected?.id === b.id ? ' on' : ''}`}
              style={box(b.bbox)}
              onClick={() => onSelect(b.id)}
              aria-label={`${formatNumber(b.n, state.locale)} ${b.role}`}
              data-n={b.n}
            >
              <span className="a11y-box-n">{formatNumber(b.n, state.locale)}</span>
            </button>
          ))}
        {selBox && <span className="a11y-box-sel" style={selBox} />}
      </div>
    </div>
  );
}
