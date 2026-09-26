/**
 * Standards panel: choose PDF/A-1b/2b/2u/3b, PDF/X-4 or Preflight → Check → findings grouped by ISO
 * clause with object references → Fix automatically (engine conversion, re-validated) → Save as a
 * new file through the host bridge. The open document itself is never changed.
 */
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../services/AppContext';
import { EngineError } from '../services/engine';
import type { OpenDocument } from '../services/state';
import type { ViewerApi } from '../viewer/Viewer';
import type { MessageKey } from '../i18n';
import en from '../i18n/en.json';
import {
  groupByClause,
  loadFonts,
  messageArgs,
  MODES,
  StandardsSession,
  suggestedName,
  type Conversion,
  type Finding,
  type Preflight,
  type Report,
  type StandardsMode,
} from '../services/standards';
import { IconButton } from './primitives';

const known = (key: string): key is MessageKey => key in en;

type Busy = null | 'check' | 'fix' | 'save';

export function StandardsPanel({ doc, api, onClose }: { doc: OpenDocument; api: ViewerApi | null; onClose: () => void }) {
  const app = useApp();
  const { t } = app;
  const [mode, setMode] = useState<StandardsMode>('pdfa-2b');
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [conversion, setConversion] = useState<{ json: Conversion; bytes: Uint8Array } | null>(null);
  const session = useRef<StandardsSession | null>(null);

  useEffect(() => () => session.current?.close(), []);

  const reset = () => {
    setReport(null);
    setPreflight(null);
    setConversion(null);
    setError(null);
  };

  const failure = (e: unknown) => {
    if (e instanceof EngineError && (e.code === 'password_required' || e.code === 'wrong_password')) return t('standards.error.password');
    const reason = e instanceof Error ? e.message : String(e);
    return t('standards.error.failed', { reason });
  };

  /** Bytes as the user sees them now (unsaved viewer edits included). */
  const currentBytes = async (): Promise<Uint8Array> => {
    if (doc.edited && !doc.warraqOwnsDocument && api) return api.exportBytes();
    return doc.bytes;
  };

  const check = async () => {
    reset();
    setBusy('check');
    try {
      session.current ??= new StandardsSession(app.engine());
      await session.current.load(await currentBytes());
      if (mode === 'preflight') setPreflight(await session.current.preflight());
      else setReport(await session.current.validate(mode));
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(null);
    }
  };

  const fix = async () => {
    if (!report || !session.current || mode === 'preflight') return;
    setBusy('fix');
    setError(null);
    try {
      const fonts = await loadFonts(report.fontsNeeded);
      setConversion(await session.current.convert(mode, fonts));
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!conversion) return;
    setBusy('save');
    try {
      const name = suggestedName(doc.name, conversion.json.suffix);
      const res = await app.host.saveFile(name, conversion.bytes, { saveAs: true });
      if (res) app.toast(t('standards.saved', { name: res.name, label: conversion.json.after.label }), 'success');
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(null);
    }
  };

  const label = (m: StandardsMode) => t(`standards.profile.${m}` as MessageKey);

  return (
    <aside className="tool-panel glass" aria-label={t('standards.title')} data-testid="standards-panel">
      <header className="tool-panel-head">
        <h2 className="panel-title">{t('standards.title')}</h2>
        <IconButton icon="close" label={t('standards.close')} onClick={onClose} size={16} />
      </header>
      <div className="tool-panel-body">
        <p className="fineprint">{t('standards.subtitle')}</p>
        <div className="std-modes" role="radiogroup" aria-label={t('standards.profile')}>
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={`std-mode${mode === m ? ' on' : ''}`}
              data-profile={m}
              disabled={busy !== null}
              onClick={() => {
                setMode(m);
                reset();
              }}
            >
              <span className="std-mode-name">{label(m)}</span>
              <span className="std-mode-desc">{t(`standards.desc.${m}` as MessageKey)}</span>
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-primary std-run" onClick={() => void check()} disabled={busy !== null} data-testid="std-check">
          {busy === 'check' ? t('standards.checking') : mode === 'preflight' ? t('standards.runPreflight') : t('standards.check')}
        </button>
        {error && (
          <p className="std-error" role="alert">
            {error}
          </p>
        )}
        {!report && !preflight && !error && busy === null && <p className="fineprint">{t('standards.empty')}</p>}
        {preflight && <PreflightView data={preflight} />}
        {report && !conversion && (
          <>
            <ReportView report={report} testId="std-report" />
            {!report.conforms && (
              <button type="button" className="btn std-fix" onClick={() => void fix()} disabled={busy !== null} data-testid="std-fix">
                {busy === 'fix' ? t('standards.fixing') : t('standards.fix')}
              </button>
            )}
            {!report.conforms && <p className="fineprint">{t('standards.newFile')}</p>}
          </>
        )}
        {conversion && (
          <section className="std-after" aria-label={t('standards.after', { label: conversion.json.after.label })}>
            <h3 className="std-h3">{t('standards.after', { label: conversion.json.after.label })}</h3>
            <ReportView report={conversion.json.after} testId="std-after" />
            {conversion.json.actions.length > 0 && (
              <details className="std-changes" open>
                <summary>{t('standards.changes')}</summary>
                <ul>
                  {conversion.json.actions.map((a) => {
                    const key = `standards.action.${a.id}`;
                    return (
                      <li key={`${a.id}:${a.detail}`} data-action={a.id}>
                        {known(key) ? t(key, { count: a.count, detail: a.detail }) : a.id}
                      </li>
                    );
                  })}
                </ul>
              </details>
            )}
            {conversion.json.after.conforms ? (
              <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy !== null} data-testid="std-save">
                {t('standards.saveAs')}
              </button>
            ) : (
              <p className="fineprint" data-testid="std-cannot-save">
                {t('standards.cannotSave', { label: conversion.json.after.label })}
              </p>
            )}
          </section>
        )}
        {(report || conversion) && <p className="fineprint std-note">{t('standards.note', { rules: (conversion?.json.after ?? report)!.rulesChecked })}</p>}
      </div>
    </aside>
  );
}

function ReportView({ report, testId }: { report: Report; testId: string }) {
  const { t } = useApp();
  const errors = report.findings.filter((f) => f.severity === 'error');
  const warnings = report.findings.filter((f) => f.severity === 'warning');
  const shown = [...errors, ...warnings];
  return (
    <div className="std-report" data-testid={testId} data-conforms={report.conforms} data-errors={report.errorCount}>
      <p className={`std-verdict ${report.conforms ? 'ok' : 'bad'}`} role="status">
        {report.conforms ? t('standards.conforms', { label: report.label }) : t('standards.notConform', { label: report.label })}
      </p>
      <p className="fineprint">{t('standards.counts', { errors: report.errorCount, warnings: report.warningCount, fixable: report.fixableCount })}</p>
      {report.incomplete && <p className="fineprint">{t('standards.incomplete')}</p>}
      {groupByClause(shown).map((g) => (
        <section key={g.clause} className="std-group" data-clause={g.clause}>
          <h3 className="std-clause">
            {report.profile === 'pdfx-4'
              ? t('standards.clauseX', { standard: g.standard, clause: t(`standards.rule.${g.rules[0]!.rule}` as MessageKey) })
              : t('standards.clause', { standard: g.standard, clause: g.clause })}
          </h3>
          {g.rules.map((r) => (
            <div key={r.rule} className="std-rule" data-rule={r.rule}>
              <h4 className="std-rule-title">{t(`standards.rule.${r.rule}` as MessageKey)}</h4>
              <ul className="std-findings">
                {r.items.map((f, i) => (
                  <FindingRow key={i} f={f} />
                ))}
              </ul>
              {(report.counts[r.rule] ?? 0) > r.items.length && (
                <p className="fineprint">{t('standards.more', { count: (report.counts[r.rule] ?? 0) - r.items.length })}</p>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function FindingRow({ f }: { f: Finding }) {
  const { t } = useApp();
  const text = known(f.key) ? t(f.key, messageArgs(f.params)) : f.message;
  const badge = f.severity === 'warning' ? 'warning' : f.fixable ? 'fixable' : 'manual';
  return (
    <li className={`std-finding ${f.severity}`} data-rule={f.rule} data-variant={f.variant} data-fixable={f.fixable}>
      <span className="std-msg">{text}</span>
      <span className="std-meta">
        {f.object && <bdi className="std-ref">{t('standards.object', { ref: f.object })}</bdi>}
        {f.page !== null && <span>{t('standards.page', { page: f.page + 1 })}</span>}
        <span className={`std-badge ${badge}`}>{t(`standards.badge.${badge}` as MessageKey)}</span>
      </span>
    </li>
  );
}

function PreflightView({ data }: { data: Preflight }) {
  const { t } = useApp();
  const claims = [data.claims.pdfa, data.claims.pdfx].filter(Boolean).join(', ');
  const entries = (r: Record<string, number>) => Object.entries(r);
  return (
    <div className="std-preflight" data-testid="std-preflight">
      <section className="std-group">
        <h3 className="std-clause">{t('preflight.overview')}</h3>
        <ul className="std-list">
          <li>{t('preflight.version', { version: data.version })}</li>
          <li>{t('preflight.pages', { count: data.pageCount })}</li>
          <li>{claims ? t('preflight.claims', { claims }) : t('preflight.claims.none')}</li>
          <li>{data.encrypted ? t('preflight.encrypted') : t('preflight.notEncrypted')}</li>
          <li>{data.tagged ? t('preflight.tagged') : t('preflight.untagged')}</li>
          {data.embeddedFiles > 0 && <li>{t('preflight.attachments', { count: data.embeddedFiles })}</li>}
          {data.optionalContent && <li>{t('preflight.layers')}</li>}
        </ul>
      </section>
      <section className="std-group" data-section="fonts">
        <h3 className="std-clause">{t('preflight.fonts', { count: data.fontCount })}</h3>
        <ul className="std-list">
          {data.fonts.map((f, i) => (
            <li key={`${f.object ?? ''}${i}`} data-embedded={f.embedded}>
              <bdi className="std-strong">{f.name || '—'}</bdi> <span className="fineprint">{f.type}</span>
              <span className="std-meta">
                <span className={`std-badge ${f.embedded ? 'fixable' : 'manual'}`}>{f.embedded ? t('preflight.embedded') : t('preflight.notEmbedded')}</span>
                {f.subset && <span className="std-badge">{t('preflight.subset')}</span>}
                {f.toUnicode && <span className="std-badge">{t('preflight.unicode')}</span>}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section className="std-group" data-section="images">
        <h3 className="std-clause">{t('preflight.images', { count: data.imageCount })}</h3>
        <ul className="std-list">
          {data.images.length === 0 && <li>{t('preflight.none')}</li>}
          {data.images.map((im) => (
            <li key={im.object}>
              <bdi>{im.object}</bdi> · {t('preflight.imageSize', { width: im.width ?? 0, height: im.height ?? 0 })} · <bdi>{im.colourSpace ?? '—'}</bdi>
              <span className="std-meta">
                {im.minDpi === null ? (
                  <span>{t('preflight.notShown')}</span>
                ) : im.minDpi < 150 ? (
                  <span className="std-badge manual">{t('preflight.dpiLow', { dpi: Math.round(im.minDpi) })}</span>
                ) : (
                  <span>{t('preflight.dpi', { dpi: Math.round(im.minDpi) })}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section className="std-group" data-section="colour">
        <h3 className="std-clause">{t('preflight.colour')}</h3>
        <ul className="std-list">
          {[...entries(data.deviceColourUses), ...entries(data.colourSpaces)].map(([k, v]) => (
            <li key={k}>
              <bdi>{k}</bdi>: {v}
            </li>
          ))}
          {data.outputIntents.map((o, i) => (
            <li key={`oi${i}`}>
              {t('preflight.outputIntents')}: <bdi>{[o.subtype, o.identifier, o.colourSpace].filter(Boolean).join(' · ')}</bdi>
            </li>
          ))}
        </ul>
      </section>
      <section className="std-group" data-section="transparency">
        <h3 className="std-clause">{t('preflight.transparency')}</h3>
        <p className="std-list-p">
          {data.transparency.used
            ? t('preflight.transparencyUsed', { masks: data.transparency.softMasks, alpha: data.transparency.constantAlpha, groups: data.transparency.groups })
            : t('preflight.none')}
        </p>
      </section>
      <section className="std-group" data-section="annotations">
        <h3 className="std-clause">{t('preflight.annotations')}</h3>
        <ul className="std-list">
          {entries(data.annotations).length === 0 && <li>{t('preflight.none')}</li>}
          {entries(data.annotations).map(([k, v]) => (
            <li key={k}>
              <bdi>{k}</bdi>: {v}
            </li>
          ))}
        </ul>
      </section>
      <section className="std-group" data-section="forms">
        <h3 className="std-clause">{t('preflight.forms')}</h3>
        <p className="std-list-p">
          {t('preflight.fields', { count: data.forms.fields })}
          {data.forms.xfa && ` · ${t('preflight.xfa')}`}
        </p>
      </section>
      <section className="std-group" data-section="javascript">
        <h3 className="std-clause">{t('preflight.javascript')}</h3>
        <p className="std-list-p">{t('preflight.scripts', { count: data.javascript.actions + (data.javascript.nameTree ? 1 : 0) })}</p>
      </section>
      <section className="std-group" data-section="boxes">
        <h3 className="std-clause">{t('preflight.boxes')}</h3>
        <ul className="std-list">
          {data.pageBoxes.slice(0, 20).map((b) => (
            <li key={b.page}>
              {t('standards.page', { page: b.page })}:{' '}
              <bdi className="std-mono">
                {Object.entries(b)
                  .filter(([k]) => k.endsWith('Box'))
                  .map(([k, v]) => `${k} [${(v as number[]).map((n) => Math.round(n)).join(' ')}]`)
                  .join(' · ')}
              </bdi>
            </li>
          ))}
        </ul>
      </section>
      {data.incomplete && <p className="fineprint">{t('standards.incomplete')}</p>}
    </div>
  );
}
