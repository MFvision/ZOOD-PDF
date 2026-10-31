import { useCallback, useState } from 'react';
import { Check, ScanSearch, Trash2, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { radioTabIndex, useRadioGroupKeyboard } from '../components/useRadioGroupKeyboard';
import { useI18n, useT } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { warraqOwnsDocument } from '../state/appReducer';
import { findTool } from '../tools/tools';
import { CalculationEditor } from './CalculationEditor';
import { showPagePoint } from './embedForms';
import { FormNotices } from './FormNotices';
import { duplicateNames, proposalsOf, toCreate } from './formTypes';
import type { DetectedPage, PageRect, Proposal, ProposalKind } from './formTypes';
import { KIND_LABELS, ProposalOverlay } from './ProposalOverlay';
import './forms.css';
import { OpenFirst } from '../tools/OpenFirst';

const KINDS: ProposalKind[] = ['text', 'checkbox', 'date', 'hijri', 'signature'];

/**
 * Prepare form: fields made three ways — found by detection on a flat form
 * and accepted, drawn by hand with EmbedPDF's form tools, or given a format,
 * a range and a calculation. Detection and field creation are Warraq's core
 * (`forms.detect`, `forms.create`); the fields it makes are real AcroForm
 * fields, which the file then reopens with.
 */
export function PrepareFormPanel() {
  const t = useT();
  const radioKeys = useRadioGroupKeyboard(useI18n().dir);
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const tool = findTool('prepareForm');
  const ready =
    state.view === 'viewer' &&
    state.document !== null &&
    !warraqOwnsDocument(state) &&
    state.switching === null;
  const [scope, setScope] = useState<'all' | 'page'>('all');
  const [busy, setBusy] = useState(false);
  // Proposals with the bytes they were found on: another file, or the same
  // one changed, and they no longer apply.
  const [detected, setDetected] = useState<{
    bytes: ArrayBuffer | null;
    pages: Set<number>;
    list: Proposal[];
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [created, setCreated] = useState<number | null>(null);
  const bytes = services.documentBytes;
  const proposals = detected && detected.bytes === bytes ? detected.list : null;
  const setProposals = useCallback((change: (list: Proposal[]) => Proposal[]) => {
    setDetected((d) => (d ? { ...d, list: change(d.list) } : d));
  }, []);

  const detect = async () => {
    setBusy(true);
    setCreated(null);
    setSelected(null);
    try {
      const current = await services.currentFileBytes();
      if (!current) return;
      const { result } = await services.client.callStatic<{ pages: DetectedPage[] }>(
        'forms.detect',
        {
          password: services.documentPassword ?? null,
          pages: scope === 'page' ? [state.currentPage - 1] : [],
        },
        [current],
      );
      setDetected({
        bytes,
        pages: new Set(result.pages.map((p) => p.index)),
        list: proposalsOf(result.pages),
      });
    } catch {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'forms.failed' });
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!proposals || proposals.length === 0) return;
    setBusy(true);
    try {
      const { result } = await services.transformFile<{ created: string[] }>('forms.create', {
        fields: toCreate(proposals),
      });
      setDetected(null);
      setSelected(null);
      setCreated(result.created.length);
    } catch {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'forms.failed' });
    } finally {
      setBusy(false);
    }
  };

  const update = useCallback(
    (id: string, change: Partial<Proposal>) =>
      setProposals((list) => list.map((p) => (p.id === id ? { ...p, ...change } : p))),
    [setProposals],
  );
  const remove = useCallback(
    (id: string) => {
      setProposals((list) => list.filter((p) => p.id !== id));
      setSelected((current) => (current === id ? null : current));
    },
    [setProposals],
  );
  const choose = (p: Proposal) => {
    setSelected(p.id);
    if (services.embedRegistry)
      showPagePoint(services.embedRegistry, p.page, p.rect[0], Math.max(0, p.rect[1] - 40));
  };

  const twice = proposals ? duplicateNames(proposals) : new Set<string>();
  const blank = proposals?.some((p) => p.name.trim() === '') ?? false;

  return (
    <div className="tool-panel prepare-form">
      <h3>
        {tool && <Icon of={tool.icon} />}
        {t('tool.prepareForm')}
      </h3>
      {!ready && <OpenFirst />}
      <FormNotices />

      <fieldset disabled={!ready || busy}>
        <legend>{t('forms.detect.legend')}</legend>
        <p className="tool-panel-note">{t('forms.detect.note')}</p>
        <div className="segmented" role="radiogroup" aria-label={t('forms.detect.scope')} onKeyDown={radioKeys}>
          {(['all', 'page'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={scope === value}
              tabIndex={radioTabIndex(scope === value, value === 'all', false)}
              className="segmented-item"
              onClick={() => setScope(value)}
            >
              {t(value === 'all' ? 'forms.detect.allPages' : 'forms.detect.thisPage')}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="tool-actions">
        <IconButton
          label={busy && !proposals ? t('forms.detect.running') : t('forms.detect.go')}
          icon={<Icon of={ScanSearch} />}
          showLabel
          variant="primary"
          disabled={!ready || busy}
          onClick={() => void detect()}
        />
      </div>
      {created !== null && (
        <p className="tool-panel-note" role="status">
          {t('forms.created', { n: created })}
        </p>
      )}

      {proposals && (
        <>
          <p className="tool-panel-note" role="status">
            {proposals.length === 0
              ? t('forms.detect.none')
              : t('forms.detect.found', { n: proposals.length })}
          </p>
          {proposals.length > 0 && (
            <fieldset className="proposal-list" disabled={busy}>
              <legend>{t('forms.proposals.legend')}</legend>
              <p className="tool-panel-note">{t('forms.proposals.note')}</p>
              <ul>
                {proposals.map((p) => (
                  <li key={p.id} className={p.id === selected ? 'is-selected' : undefined}>
                    <select
                      className="select select-compact"
                      aria-label={t('forms.proposal.type', { name: p.name })}
                      value={p.kind}
                      onChange={(event) => {
                        const kind = event.target.value as ProposalKind;
                        update(p.id, {
                          kind,
                          pattern:
                            kind === 'date'
                              ? 'dd/mm/yyyy'
                              : kind === 'hijri'
                                ? 'dd/mm/yyyy هـ'
                                : null,
                        });
                      }}
                      onFocus={() => choose(p)}
                    >
                      {KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {t(KIND_LABELS[kind])}
                        </option>
                      ))}
                    </select>
                    <input
                      className="text-input"
                      dir="auto"
                      aria-label={t('forms.proposal.name')}
                      aria-invalid={twice.has(p.name.trim()) || p.name.trim() === '' || undefined}
                      value={p.name}
                      onChange={(event) => update(p.id, { name: event.target.value })}
                      onFocus={() => choose(p)}
                    />
                    <IconButton
                      label={t('forms.proposal.remove', { name: p.name })}
                      icon={<Icon of={X} />}
                      onClick={() => remove(p.id)}
                    />
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          {(twice.size > 0 || blank) && (
            <p className="field-error" role="alert">
              {blank
                ? t('forms.proposals.blankName')
                : t('forms.proposals.sameName', { name: [...twice][0] ?? '' })}
            </p>
          )}
          <div className="tool-actions">
            {proposals.length > 0 && (
              <IconButton
                label={t('forms.proposals.create', { n: proposals.length })}
                icon={<Icon of={Check} />}
                showLabel
                variant="primary"
                disabled={busy || twice.size > 0 || blank}
                onClick={() => void create()}
              />
            )}
            <IconButton
              label={t('forms.proposals.discard')}
              icon={<Icon of={Trash2} />}
              showLabel
              disabled={busy}
              onClick={() => {
                setDetected(null);
                setSelected(null);
              }}
            />
          </div>
          {services.embedRegistry && services.embedShowing && (
            <ProposalOverlay
              registry={services.embedRegistry}
              proposals={proposals.filter((p) => detected?.pages.has(p.page))}
              selected={selected}
              onSelect={setSelected}
              onChange={(id: string, rect: PageRect) => update(id, { rect })}
              onRemove={remove}
            />
          )}
        </>
      )}

      <p className="form-section-title">{t('forms.byHand.legend')}</p>
      <div className="tool-actions">
        {(tool?.actions ?? []).map((action) => (
          <IconButton
            key={action.command}
            label={t(action.labelKey)}
            icon={<Icon of={action.icon} />}
            showLabel
            disabled={!ready}
            onClick={() => services.runEmbedCommand(action.command)}
          />
        ))}
      </div>

      <CalculationEditor ready={ready} />
    </div>
  );
}
