import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Accessibility,
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleX,
  Eye,
  GripVertical,
  ListOrdered,
  Save,
  ScanEye,
  Tags,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { cx } from '../components/cx';
import type { RemoteDocument } from '../core/client';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { PagePicture } from './PagePicture';
import { ROLES, automaticFixes, excerpt, moveBlock, readingNumbers, withPage, withRole } from './plan';
import type { Check, CheckStatus, Figure, Plan, PlanAnswer, PlanBlock, Role } from './plan';
import './accessibility.css';
import { OpenFirst } from '../tools/OpenFirst';

type Tab = 'check' | 'order' | 'alt';

const STATUS_ICON: Record<CheckStatus, typeof CircleCheck> = {
  passed: CircleCheck,
  failed: CircleX,
  warning: TriangleAlert,
  manual: Eye,
};

const LANGUAGES = ['ar', 'en', 'fa', 'ur', 'fr'] as const;

/**
 * Accessibility: what a screen reader needs from the file, from Warraq's
 * core (`accessibility.*`). A checker for the PDF/UA-1 and WCAG rules a file
 * can answer, with the fixes Warraq can make itself; the reading order —
 * each page's blocks as numbered boxes, to reorder and relabel — tagged into
 * the file; and the text each figure is read as. Changes are updates of the
 * open file, saved with it. Another document starts the panel afresh.
 */
export function AccessibilityPanel() {
  const state = useAppState();
  return <AccessibilityTools key={state.document?.id ?? 'none'} />;
}

function AccessibilityTools() {
  const { t, lang } = useI18n();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const { client, documentPassword } = services;
  const [tab, setTab] = useState<Tab>('check');
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [title, setTitle] = useState('');
  const [answer, setAnswer] = useState<PlanAnswer | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [figures, setFigures] = useState<Figure[] | null>(null);
  const [alts, setAlts] = useState<Record<string, string>>({});
  const [picture, setPicture] = useState<RemoteDocument | null>(null);
  const pictureRef = useRef<RemoteDocument | null>(null);

  const ready = state.view === 'viewer' && state.document !== null && !busy && state.switching === null;
  const password = documentPassword ?? null;
  const stem = (state.document?.name ?? 'document.pdf').replace(/\.pdf$/i, '');

  // The pages drawn for the panel are let go with it.
  useEffect(
    () => () => {
      void pictureRef.current?.free();
      pictureRef.current = null;
    },
    [],
  );

  /** The pages as the core draws them, from the bytes the plan was made from. */
  const showPictures = useCallback(
    async (bytes: ArrayBuffer) => {
      const doc = await client.open(bytes.slice(0), documentPassword);
      void pictureRef.current?.free();
      pictureRef.current = doc;
      setPicture(doc);
    },
    [client, documentPassword],
  );

  const work = async (run: () => Promise<void>) => {
    setBusy(true);
    try {
      await run();
    } catch {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'access.failed' });
    } finally {
      setBusy(false);
    }
  };

  const runCheck = () =>
    work(async () => {
      const bytes = await services.fileBytesForChange();
      if (!bytes) return;
      const { result } = await client.callStatic<{ checks: Check[] }>('accessibility.check', { password }, [bytes]);
      setChecks(result.checks);
      if (!title && result.checks.some((c) => c.id === 'title' && c.status === 'failed')) setTitle(stem);
    });

  const fixes = checks ? automaticFixes(checks) : [];

  const applyFixes = () =>
    work(async () => {
      const bytes = await services.fileBytesForChange();
      if (!bytes) return;
      const { blobs } = await client.callStatic<{ applied: Record<string, number> }>(
        'accessibility.fix',
        { password, fixes, title: title.trim() || stem },
        [bytes],
      );
      if (!blobs[0]) return;
      await services.replaceFile(blobs[0].slice(0));
      dispatch({ type: 'TOAST', key: 'access.fixed' });
      const { result } = await client.callStatic<{ checks: Check[] }>('accessibility.check', { password }, [blobs[0]]);
      setChecks(result.checks);
    });

  const propose = () =>
    work(async () => {
      const bytes = await services.fileBytesForChange();
      if (!bytes) return;
      const { result } = await client.callStatic<PlanAnswer>('accessibility.plan', { password }, [bytes.slice(0)]);
      await showPictures(bytes);
      setAnswer(result);
      setPlan(result.plan);
      if (result.plan.title && !title) setTitle(result.plan.title);
      setPageIndex(Math.min(Math.max(0, state.currentPage - 1), Math.max(0, result.plan.pages.length - 1)));
      setSelected(null);
    });

  const applyTags = () =>
    work(async () => {
      if (!plan) return;
      const bytes = await services.fileBytesForChange();
      if (!bytes) return;
      const { blobs } = await client.callStatic<{ elements: number }>(
        'accessibility.tag',
        { password, plan: { ...plan, title: title.trim() || plan.title || null } },
        [bytes],
      );
      if (!blobs[0]) return;
      const tagged = blobs[0];
      await services.replaceFile(tagged.slice(0));
      dispatch({ type: 'TOAST', key: 'access.applied' });
      setAnswer((a) => (a ? { ...a, source: 'structure', tagged: true } : a));
      const { result: after } = await client.callStatic<{ checks: Check[] }>('accessibility.check', { password }, [tagged.slice(0)]);
      setChecks(after.checks);
    });

  const loadFigures = () =>
    work(async () => {
      const bytes = await services.fileBytesForChange();
      if (!bytes) return;
      const { result } = await client.callStatic<{ figures: Figure[] }>('accessibility.figures', { password }, [bytes.slice(0)]);
      if (result.figures.length > 0) await showPictures(bytes);
      setFigures(result.figures);
      setAlts(Object.fromEntries(result.figures.map((f) => [f.id, f.alt ?? ''])));
    });

  const saveAlts = () =>
    work(async () => {
      const bytes = await services.fileBytesForChange();
      if (!bytes || !figures) return;
      const { blobs } = await client.callStatic<{ set: number }>(
        'accessibility.alt',
        { password, alts: figures.map((f) => ({ id: f.id, alt: alts[f.id] ?? '' })) },
        [bytes],
      );
      if (!blobs[0]) return;
      await services.replaceFile(blobs[0].slice(0));
      dispatch({ type: 'TOAST', key: 'access.altSaved' });
    });

  const page = plan?.pages[pageIndex] ?? null;
  const blocks = page?.blocks ?? [];
  const numbers = readingNumbers(blocks);
  const setBlocks = (next: PlanBlock[]) => plan && setPlan(withPage(plan, pageIndex, next));
  const move = (from: number, to: number) => {
    setBlocks(moveBlock(blocks, from, to));
    setSelected(to);
  };
  const goTab = (next: Tab) => {
    setTab(next);
    if (next === 'order' && !plan && ready) void propose();
    if (next === 'alt' && !figures && ready) void loadFigures();
  };

  return (
    <div className="tool-panel access-panel">
      <h3>
        <Icon of={Accessibility} />
        {t('tool.accessibility')}
      </h3>
      {state.document === null ? (
        <OpenFirst />
      ) : (
        <>
          <p className="tool-panel-note">{t('access.intro')}</p>
          <div className="segmented access-tabs" role="tablist" aria-label={t('tool.accessibility')}>
            {(['check', 'order', 'alt'] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                className="segmented-item"
                onClick={() => goTab(key)}
              >
                {t(`access.tab.${key}` as TKey)}
              </button>
            ))}
          </div>

          <div role="tabpanel" className="access-tabpanel">
            {tab === 'check' && (
              <>
                <div className="tool-actions">
                  <IconButton
                    label={busy ? t('standards.working') : t('access.run')}
                    icon={<Icon of={ScanEye} />}
                    showLabel
                    variant={checks ? undefined : 'primary'}
                    disabled={!ready}
                    onClick={() => void runCheck()}
                  />
                </div>
                {checks && (
                  <>
                    {checks.some((c) => c.id === 'title' && c.status === 'failed') && (
                      <label className="field">
                        <span>{t('access.titleField')}</span>
                        <input className="text-input" dir="auto" value={title} onChange={(e) => setTitle(e.target.value)} />
                      </label>
                    )}
                    {(fixes.length > 0 || checks.some((c) => c.fix === 'tag' && c.status === 'failed')) && (
                      <div className="tool-actions">
                        {fixes.length > 0 && (
                          <IconButton
                            label={t('access.fixAll', { count: fixes.length })}
                            icon={<Icon of={Wrench} />}
                            showLabel
                            variant="primary"
                            disabled={!ready}
                            onClick={() => void applyFixes()}
                          />
                        )}
                        {checks.some((c) => c.fix === 'tag' && c.status === 'failed') && (
                          <IconButton
                            label={t('access.tagFirst')}
                            icon={<Icon of={Tags} />}
                            showLabel
                            disabled={!ready}
                            onClick={() => goTab('order')}
                          />
                        )}
                      </div>
                    )}
                    <ul className="access-checks" aria-label={t('access.results')}>
                      {checks.map((c) => (
                        <li key={c.id} className={`access-check access-${c.status}`}>
                          <Icon of={STATUS_ICON[c.status]} size={16} />
                          <span className="access-check-body">
                            <span className="access-check-name">{t(`access.check.${c.id}` as TKey)}</span>
                            <span className="access-check-status">{t(`access.status.${c.status}` as TKey)}</span>
                            {c.detail && (
                              <span className="access-check-detail" dir="auto">
                                {c.detail}
                              </span>
                            )}
                            <span className="access-check-clause">
                              {t('access.clauses', { clause: c.clause, wcag: c.wcag })}
                            </span>
                            {c.pages.length > 0 && (
                              <span className="access-check-pages">
                                {c.pages.slice(0, 10).map((p) => (
                                  <button
                                    key={p}
                                    type="button"
                                    className="link-btn"
                                    aria-label={t('standards.goToPage', { page: p + 1 })}
                                    onClick={() => services.goToPage(p + 1)}
                                  >
                                    {t('standards.page', { page: p + 1 })}
                                  </button>
                                ))}
                              </span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="tool-panel-note">{t('access.coverage')}</p>
                  </>
                )}
              </>
            )}

            {tab === 'order' && (
              <>
                <div className="tool-actions">
                  <IconButton
                    label={busy ? t('standards.working') : t('access.propose')}
                    icon={<Icon of={ListOrdered} />}
                    showLabel
                    disabled={!ready}
                    onClick={() => void propose()}
                  />
                </div>
                {plan && page && (
                  <>
                    <p className="tool-panel-note">
                      {t(answer?.source === 'structure' ? 'access.fromStructure' : 'access.fromReading')}
                    </p>
                    <div className="access-doc-fields">
                      <label className="field">
                        <span>{t('access.titleField')}</span>
                        <input className="text-input" dir="auto" value={title} onChange={(e) => setTitle(e.target.value)} />
                      </label>
                      <label className="field">
                        <span>{t('access.language')}</span>
                        <select
                          className="select"
                          value={plan.lang}
                          onChange={(e) => setPlan({ ...plan, lang: e.target.value })}
                        >
                          {[...new Set([plan.lang, ...LANGUAGES])].map((code) => (
                            <option key={code} value={code}>
                              {(LANGUAGES as readonly string[]).includes(code) ? t(`access.lang.${code}` as TKey) : code}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="access-page-nav">
                      <IconButton
                        label={t('access.prevPage')}
                        icon={<Icon of={lang === 'ar' ? ChevronRight : ChevronLeft} />}
                        disabled={pageIndex === 0}
                        onClick={() => {
                          setPageIndex(pageIndex - 1);
                          setSelected(null);
                        }}
                      />
                      <span aria-live="polite">{t('access.page', { page: pageIndex + 1, pages: plan.pages.length })}</span>
                      <IconButton
                        label={t('access.nextPage')}
                        icon={<Icon of={lang === 'ar' ? ChevronLeft : ChevronRight} />}
                        disabled={pageIndex >= plan.pages.length - 1}
                        onClick={() => {
                          setPageIndex(pageIndex + 1);
                          setSelected(null);
                        }}
                      />
                    </div>
                    <PagePicture
                      doc={picture}
                      page={pageIndex}
                      width={page.width}
                      height={page.height}
                      label={t('access.page', { page: pageIndex + 1, pages: plan.pages.length })}
                    >
                      <svg className="access-overlay" viewBox={`0 0 ${page.width} ${page.height}`} aria-hidden="true">
                        {blocks.map((b, i) => {
                          const [x0, y0, x1, y1] = b.rect;
                          const n = numbers[i];
                          return (
                            <g
                              key={i}
                              className={cx('access-box', `access-role-${b.role.toLowerCase()}`, selected === i && 'access-box-selected')}
                              onClick={() => setSelected(i)}
                            >
                              <rect x={x0} y={y0} width={Math.max(1, x1 - x0)} height={Math.max(1, y1 - y0)} />
                              {n !== null && (
                                <text x={x0 + 2} y={y0 + 2} dominantBaseline="hanging">
                                  {n}
                                </text>
                              )}
                            </g>
                          );
                        })}
                      </svg>
                    </PagePicture>
                    {blocks.length === 0 ? (
                      <p className="tool-panel-note">{t('access.empty')}</p>
                    ) : (
                      <>
                        <p className="tool-panel-note">{t('access.dragHint')}</p>
                        <ol className="access-blocks" aria-label={t('access.order')}>
                          {blocks.map((b, i) => (
                            <li
                              key={`${pageIndex}-${i}-${b.rect.join(',')}`}
                              className={cx(
                                'access-block',
                                selected === i && 'access-block-selected',
                                dragging === i && 'access-block-dragging',
                                b.role === 'Artifact' && 'access-block-artifact',
                              )}
                              draggable
                              onDragStart={(e) => {
                                setDragging(i);
                                e.dataTransfer.effectAllowed = 'move';
                                e.dataTransfer.setData('text/plain', String(i));
                              }}
                              onDragEnd={() => setDragging(null)}
                              onDragOver={(e) => e.preventDefault()}
                              onDrop={(e) => {
                                e.preventDefault();
                                const from = Number(e.dataTransfer.getData('text/plain'));
                                if (Number.isInteger(from)) move(from, i);
                                setDragging(null);
                              }}
                              onClick={() => setSelected(i)}
                            >
                              <span className="access-block-grip" aria-hidden="true">
                                <Icon of={GripVertical} size={14} />
                              </span>
                              <span className={cx('access-block-number', `access-role-${b.role.toLowerCase()}`)}>
                                {numbers[i] ?? '–'}
                              </span>
                              <span className="access-block-body">
                                <select
                                  className="select"
                                  aria-label={t('access.roleOf', { number: numbers[i] ?? '–' })}
                                  value={b.role}
                                  onChange={(e) =>
                                    setBlocks(blocks.map((x, k) => (k === i ? withRole(x, e.target.value as Role) : x)))
                                  }
                                >
                                  {ROLES.map((role) => (
                                    <option key={role} value={role}>
                                      {t(`access.role.${role}` as TKey)}
                                    </option>
                                  ))}
                                </select>
                                {b.text && (
                                  <span className="access-block-text" dir="auto">
                                    {excerpt(b.text)}
                                  </span>
                                )}
                                {b.role === 'Figure' && (
                                  <input
                                    className="text-input"
                                    dir="auto"
                                    placeholder={t('access.altPlaceholder')}
                                    aria-label={t('access.altFor', { number: numbers[i] ?? '–' })}
                                    value={b.alt ?? ''}
                                    onChange={(e) =>
                                      setBlocks(blocks.map((x, k) => (k === i ? { ...x, alt: e.target.value } : x)))
                                    }
                                  />
                                )}
                              </span>
                              <span className="access-block-move">
                                <IconButton
                                  label={t('access.moveUp')}
                                  icon={<Icon of={ArrowUp} size={14} />}
                                  disabled={i === 0}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    move(i, i - 1);
                                  }}
                                />
                                <IconButton
                                  label={t('access.moveDown')}
                                  icon={<Icon of={ArrowDown} size={14} />}
                                  disabled={i === blocks.length - 1}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    move(i, i + 1);
                                  }}
                                />
                              </span>
                            </li>
                          ))}
                        </ol>
                      </>
                    )}
                    <div className="tool-actions">
                      <IconButton
                        label={busy ? t('standards.working') : t('access.apply')}
                        icon={<Icon of={Tags} />}
                        showLabel
                        variant="primary"
                        disabled={!ready}
                        onClick={() => void applyTags()}
                      />
                    </div>
                  </>
                )}
              </>
            )}

            {tab === 'alt' && (
              <>
                {figures === null ? (
                  <div className="tool-actions">
                    <IconButton
                      label={t('access.loadFigures')}
                      icon={<Icon of={ScanEye} />}
                      showLabel
                      disabled={!ready}
                      onClick={() => void loadFigures()}
                    />
                  </div>
                ) : figures.length === 0 ? (
                  <>
                    <p className="tool-panel-note">{t('access.noFigures')}</p>
                    <div className="tool-actions">
                      <IconButton
                        label={t('access.tagFirst')}
                        icon={<Icon of={Tags} />}
                        showLabel
                        disabled={!ready}
                        onClick={() => goTab('order')}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <ul className="access-figures">
                      {figures.map((f, i) => (
                        <li key={f.id}>
                          <FigureThumb doc={picture} figure={f} label={t('access.figure', { number: i + 1, page: f.page + 1 })} />
                          <label className="field">
                            <span>{t('access.figure', { number: i + 1, page: f.page + 1 })}</span>
                            <textarea
                              className="text-input"
                              dir="auto"
                              rows={2}
                              placeholder={t('access.altPlaceholder')}
                              value={alts[f.id] ?? ''}
                              onChange={(e) => setAlts({ ...alts, [f.id]: e.target.value })}
                            />
                          </label>
                        </li>
                      ))}
                    </ul>
                    <div className="tool-actions">
                      <IconButton
                        label={t('access.saveAlt')}
                        icon={<Icon of={Save} />}
                        showLabel
                        variant="primary"
                        disabled={!ready}
                        onClick={() => void saveAlts()}
                      />
                    </div>
                  </>
                )}
                <p className="tool-panel-note">{t('access.altNote')}</p>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** A figure cut from its page, drawn by the core. */
function FigureThumb({ doc, figure, label }: { doc: RemoteDocument | null; figure: Figure; label: string }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const rect = figure.rect;
    if (!doc || !rect) return;
    let cancelled = false;
    const [x0, y0, x1, y1] = rect;
    const w = Math.max(1, x1 - x0);
    const scale = Math.min(2, 240 / w);
    void doc
      .render_page(figure.page, scale)
      .then(async (page) => {
        const element = canvas.current;
        if (cancelled || !element) return;
        const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(page.rgba), page.width, page.height));
        const sx = Math.max(0, x0 * scale);
        const sy = Math.max(0, y0 * scale);
        const sw = Math.min(page.width - sx, w * scale);
        const sh = Math.min(page.height - sy, Math.max(1, y1 - y0) * scale);
        element.width = Math.max(1, Math.round(sw));
        element.height = Math.max(1, Math.round(sh));
        element.getContext('2d')?.drawImage(bitmap, sx, sy, sw, sh, 0, 0, element.width, element.height);
        bitmap.close();
      })
      .catch(() => {
        /* the text field still names the figure and its page */
      });
    return () => {
      cancelled = true;
    };
  }, [doc, figure]);
  return <canvas ref={canvas} className="access-figure-thumb" role="img" aria-label={label} />;
}
