import { useState } from 'react';
import type { FormEvent } from 'react';
import { EyeOff, FileSearch, Search, ShieldCheck, SquareCheck, SquareX, Trash2 } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { warraqOwnsDocument } from '../state/appReducer';
import { EmbedToolPanel } from '../tools/EmbedToolPanel';
import type { ToolDefinition } from '../tools/tools';
import { PATTERNS, defaultChoices, detailText, marksOf } from './findings';
import type { FoundMatch, HiddenKind, HiddenReport, PatternKind } from './findings';
import './redact.css';

/**
 * Redact: EmbedPDF's own marking and applying (ADR-0007), and two things it
 * does not do, by Warraq's core — find and redact, with the Arabic-aware
 * search and ready-made patterns, and Remove hidden information.
 */
export function RedactPanel({ tool }: { tool: ToolDefinition }) {
  return (
    <>
      <EmbedToolPanel tool={tool} />
      <FindAndRedact />
      <HiddenInformation />
    </>
  );
}

/** The panel may act: the EmbedPDF view holds the file and no switch is under way. */
function useReady(): boolean {
  const state = useAppState();
  return state.view === 'viewer' && state.document !== null && !warraqOwnsDocument(state) && state.switching === null;
}

function FindAndRedact() {
  const { t } = useI18n();
  const services = useServices();
  const ready = useReady();
  const [query, setQuery] = useState('');
  const [patterns, setPatterns] = useState<ReadonlySet<PatternKind>>(new Set());
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TKey | null>(null);
  const [found, setFound] = useState<{ matches: FoundMatch[]; total: number } | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set());
  const [marked, setMarked] = useState<number | null>(null);

  const togglePattern = (kind: PatternKind) =>
    setPatterns((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim() && patterns.size === 0 && !custom.trim()) {
      setError('redact.search.empty');
      return;
    }
    setBusy(true);
    setError(null);
    setFound(null);
    setMarked(null);
    try {
      const bytes = await services.readFile();
      if (!bytes) throw new Error('E_NOT_FOUND: no open file');
      // Warraq's own reading of the file as it stands: the same search as Find.
      const reading = await services.client.open(bytes, services.documentPassword);
      try {
        const { result } = await reading.call<{ matches: FoundMatch[]; total: number }>('redact.find', {
          query,
          patterns: [...patterns],
          custom: custom.trim() || null,
        });
        setFound(result);
        setChosen(new Set(result.matches.map((_, index) => index)));
      } finally {
        void reading.free();
      }
    } catch (failure) {
      setError(/E_ARGS/.test(String((failure as Error)?.message ?? failure)) && custom.trim() ? 'redact.search.badPattern' : 'redact.search.failed');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (index: number) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const mark = () => {
    if (!found) return;
    const count = services.markForRedaction(marksOf(found.matches, chosen));
    setMarked(count);
    setChosen(new Set());
  };

  return (
    <section className="tool-panel redact-section" aria-labelledby="redact-search-title">
      <h3 id="redact-search-title">
        <Icon of={FileSearch} />
        {t('redact.search.title')}
      </h3>
      <form className="redact-form" onSubmit={(event) => void search(event)}>
        <label className="field">
          <span>{t('redact.search.query')}</span>
          <input className="text-input" type="search" dir="auto" value={query} disabled={!ready || busy} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <p className="tool-panel-note">{t('redact.search.queryHint')}</p>
        <fieldset className="redact-patterns" disabled={!ready || busy}>
          <legend>{t('redact.search.patterns')}</legend>
          {PATTERNS.map((kind) => (
            <label key={kind} className="redact-check">
              <input type="checkbox" checked={patterns.has(kind)} onChange={() => togglePattern(kind)} />
              <span>{t(`redact.kind.${kind}` as TKey)}</span>
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span>{t('redact.search.custom')}</span>
          <input
            className="text-input redact-pattern"
            dir="ltr"
            spellCheck={false}
            autoComplete="off"
            maxLength={1000}
            value={custom}
            disabled={!ready || busy}
            onChange={(event) => setCustom(event.target.value)}
          />
        </label>
        <div className="tool-actions">
          <IconButton type="submit" label={busy ? t('redact.search.working') : t('redact.search.go')} icon={<Icon of={Search} />} showLabel disabled={!ready || busy} />
        </div>
      </form>
      {error && (
        <p className="field-error" role="alert">
          {t(error)}
        </p>
      )}
      {found && found.matches.length === 0 && <p role="status">{t('redact.search.none')}</p>}
      {found && found.matches.length > 0 && (
        <div className="redact-results">
          <div className="redact-results-head">
            <strong role="status">{t('redact.search.found', { count: found.total })}</strong>
            <IconButton label={t('redact.search.all')} icon={<Icon of={SquareCheck} />} onClick={() => setChosen(new Set(found.matches.map((_, i) => i)))} />
            <IconButton label={t('redact.search.clear')} icon={<Icon of={SquareX} />} onClick={() => setChosen(new Set())} />
          </div>
          {found.total > found.matches.length && <p className="tool-panel-note">{t('redact.search.more', { shown: found.matches.length, count: found.total })}</p>}
          <ul className="redact-list" aria-label={t('redact.search.results')}>
            {found.matches.map((match, index) => (
              <li key={index}>
                <label className="redact-match">
                  <input type="checkbox" checked={chosen.has(index)} onChange={() => toggle(index)} />
                  <span className="redact-match-page">{t('redact.search.page', { page: match.page + 1 })}</span>
                  <bdi className="redact-match-context" dir="auto">
                    {match.before}
                    <mark>{match.text}</mark>
                    {match.after}
                  </bdi>
                  <span className="badge">{t(`redact.kind.${match.kind}` as TKey)}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="tool-actions">
            <IconButton
              label={t('redact.search.mark', { count: chosen.size })}
              icon={<Icon of={EyeOff} />}
              showLabel
              variant="primary"
              disabled={!ready || chosen.size === 0}
              onClick={mark}
            />
          </div>
        </div>
      )}
      {marked !== null && (
        <p className="tool-panel-note" role="status">
          {t('redact.search.marked', { count: marked })}
        </p>
      )}
    </section>
  );
}

function HiddenInformation() {
  const { t } = useI18n();
  const services = useServices();
  const dispatch = useAppDispatch();
  const ready = useReady();
  const [busy, setBusy] = useState<'checking' | 'removing' | null>(null);
  const [report, setReport] = useState<HiddenReport | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<HiddenKind>>(new Set());
  const [done, setDone] = useState(false);

  const inspect = async (file?: ArrayBuffer): Promise<HiddenReport | null> => {
    const bytes = file ?? (await services.readFile());
    if (!bytes) return null;
    const { result } = await services.client.callStatic<HiddenReport>('redact.inspect', { password: services.documentPassword ?? null }, [bytes]);
    return result;
  };

  const check = async () => {
    setBusy('checking');
    setDone(false);
    try {
      const found = await inspect();
      setReport(found);
      if (found) setChosen(defaultChoices(found));
    } catch {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'redact.hidden.failed' });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('removing');
    try {
      const bytes = await services.readFile();
      if (!bytes) return;
      const { result, blobs } = await services.client.callStatic<{ refused?: string }>(
        'redact.scrub',
        { password: services.documentPassword ?? null, remove: [...chosen] },
        [bytes],
      );
      if (result.refused || !blobs[0]) throw new Error('E_EDIT: refused');
      // A file written whole replaces the open one in both views, as an
      // applied redaction does: what is saved next is built on it, so no
      // earlier revision comes back.
      const written = blobs[0];
      await services.replaceFile(written.slice(0));
      setReport(await inspect(written));
      setChosen(new Set());
      setDone(true);
    } catch {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'redact.hidden.failed' });
    } finally {
      setBusy(null);
    }
  };

  const toggle = (kind: HiddenKind) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const marksPending = services.pendingRedactions > 0;
  const always = report ? report.revisions + report.unreachable > 0 : false;
  const nothing = report !== null && report.findings.length === 0 && !always;
  const canRemove = ready && !busy && report !== null && !report.protected && !marksPending && (chosen.size > 0 || always);

  return (
    <section className="tool-panel redact-section" aria-labelledby="redact-hidden-title">
      <h3 id="redact-hidden-title">
        <Icon of={ShieldCheck} />
        {t('redact.hidden.title')}
      </h3>
      <p className="tool-panel-note">{t('redact.hidden.intro')}</p>
      <div className="tool-actions">
        <IconButton
          label={busy === 'checking' ? t('redact.hidden.checking') : t('redact.hidden.check')}
          icon={<Icon of={FileSearch} />}
          showLabel
          disabled={!ready || busy !== null}
          onClick={() => void check()}
        />
      </div>
      {nothing && <p role="status">{t('redact.hidden.nothing')}</p>}
      {report && report.findings.length > 0 && (
        <fieldset className="redact-hidden" disabled={busy !== null || report.protected}>
          <legend>{t('redact.hidden.found')}</legend>
          {report.findings.map((finding) => (
            <label key={finding.kind} className="redact-check redact-finding">
              <input type="checkbox" checked={chosen.has(finding.kind)} onChange={() => toggle(finding.kind)} />
              <span>
                <strong>
                  {t(`redact.hidden.kind.${finding.kind}` as TKey)} ({finding.count})
                </strong>
                {finding.details.length > 0 && (
                  <bdi className="redact-finding-details" dir="auto">
                    {finding.details.map((detail) => detailText(detail, t)).join(' · ')}
                  </bdi>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {report && always && <p className="tool-panel-note">{t('redact.hidden.always', { revisions: report.revisions, unreachable: report.unreachable })}</p>}
      {report?.signed && <p className="field-error">{t('redact.hidden.signed')}</p>}
      {report?.protected && (
        <p className="field-error" role="alert">
          {t('redact.hidden.protected')}
        </p>
      )}
      {report && marksPending && <p className="field-error">{t('redact.hidden.pendingMarks')}</p>}
      {report && !nothing && (
        <div className="tool-actions">
          <IconButton
            label={busy === 'removing' ? t('redact.hidden.removing') : t('redact.hidden.remove')}
            icon={<Icon of={Trash2} />}
            showLabel
            variant="primary"
            disabled={!canRemove}
            onClick={() => void remove()}
          />
        </div>
      )}
      {done && (
        <p className="tool-panel-note" role="status">
          {t('redact.hidden.done')}
        </p>
      )}
    </section>
  );
}
