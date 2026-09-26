/**
 * Signatures of the open document: a banner when it is signed, and a panel listing each
 * signature (status, signer, time in Gregorian or Hijri, level, certification, timestamp, chain
 * and EKU policy, warnings and attacks, modifications after signing), "View signed version",
 * and the user's trusted certificates (empty by default → "identity unknown").
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useApp } from '../services/AppContext';
import type { OpenDocument } from '../services/state';
import { formatSignTime, looksSigned, overallStatus, statusTone, formatDay, type Calendar, type Overall, type SignatureReport } from '../services/signatures';
import { signedVersion, verifyPdf } from '../services/signing';
import { idbTrustStore, importTrusted, loadTrusted, type TrustStore, type TrustedCert } from '../services/trust';
import type { MessageKey, Translate } from '../i18n';
import { Icon } from './icons';
import { IconButton } from './primitives';

/* ---------- trust list shared by every document view ---------- */

let trustVersion = 0;
const trustListeners = new Set<() => void>();
function trustChanged() {
  trustVersion++;
  for (const l of trustListeners) l();
}
function useTrustVersion(): number {
  return useSyncExternalStore(
    (l) => {
      trustListeners.add(l);
      return () => trustListeners.delete(l);
    },
    () => trustVersion,
  );
}

let webTrust: TrustStore | null = null;
function useTrustStore(): TrustStore {
  const app = useApp();
  return app.host.signing?.trust ?? (webTrust ??= idbTrustStore());
}

/* ---------- verification of the current bytes ---------- */

export interface SignatureState {
  reports: SignatureReport[] | null;
  checking: boolean;
  error: string | null;
}

/** Verifies `doc.bytes` whenever they change (open, save, sign) or the trust list changes. */
export function useSignatures(doc: OpenDocument): SignatureState {
  const app = useApp();
  const store = useTrustStore();
  const version = useTrustVersion();
  const signed = useMemo(() => looksSigned(doc.bytes), [doc.bytes]);
  const [done, setDone] = useState<{ bytes: Uint8Array; version: number; reports: SignatureReport[] | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!signed) return;
    let alive = true;
    const bytes = doc.bytes;
    (async () => {
      const roots = (await store.list().catch(() => [])).map((c) => c.der);
      return verifyPdf(app.engine(), bytes, roots);
    })().then(
      (reports) => alive && setDone({ bytes, version, reports, error: null }),
      (e: unknown) => alive && setDone({ bytes, version, reports: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      alive = false;
    };
  }, [app, doc.bytes, signed, store, version]);
  if (!signed) return { reports: null, checking: false, error: null };
  const current = done && done.bytes === doc.bytes;
  return {
    // Keep showing the previous result while a new trust list is applied.
    reports: current ? done.reports : null,
    checking: !current || done.version !== version,
    error: current ? done.error : null,
  };
}

const overallKey: Record<Exclude<Overall, 'none'>, MessageKey> = {
  valid: 'sig.status.valid',
  valid_identity_unknown: 'sig.status.valid_identity_unknown',
  modified: 'sig.status.modified',
  invalid: 'sig.status.invalid',
  unsupported: 'sig.status.unsupported',
};

function statusKey(s: string): MessageKey {
  return (overallKey as Record<string, MessageKey>)[s] ?? 'sig.status.unsupported';
}

function toneIcon(tone: string) {
  return tone === 'good' ? '✓' : tone === 'bad' ? '✕' : '!';
}

export function SignatureBanner({ state, onOpen }: { state: SignatureState; onOpen: () => void }) {
  const { t } = useApp();
  if (!state.reports || state.reports.length === 0) return null;
  const overall = overallStatus(state.reports);
  if (overall === 'none') return null;
  const tone = statusTone(overall);
  const names = [...new Set(state.reports.filter((r) => r.kind !== 'documentTimestamp' && r.signer).map((r) => r.signer!.name))];
  return (
    <div className={`sig-banner glass tone-${tone}`} role="status" data-testid="sig-banner" data-status={overall}>
      <span className="sig-icon" aria-hidden="true">
        {toneIcon(tone)}
      </span>
      <span className="sig-banner-text">
        {names.length > 0 ? t('sig.banner.signedBy', { names: names.join(t('sig.listSeparator')) }) : t('sig.banner.timestamped')}
        {' — '}
        <strong>{t(statusKey(overall))}</strong>
      </span>
      <button type="button" className="btn btn-small" onClick={onOpen} data-testid="sig-banner-open">
        {t('sig.panel.open')}
      </button>
    </div>
  );
}

/* ---------- panel ---------- */

function noteText(t: Translate, code: string, message: string, prefix: 'reason' | 'attack' | 'mod'): string {
  const key = `sig.${prefix}.${code}` as MessageKey;
  const s = t(key);
  return s === key ? message : s;
}

export function SignaturesPanel({ doc, state, onClose }: { doc: OpenDocument; state: SignatureState; onClose: () => void }) {
  const app = useApp();
  const { t } = app;
  const [calendar, setCalendar] = useState<Calendar>('gregory');
  return (
    <aside className="compare-panel signatures-panel glass" aria-label={t('sig.panel.title')} data-testid="signatures-panel">
      <header className="compare-head">
        <h2 className="panel-title">{t('sig.panel.title')}</h2>
        <IconButton icon="close" label={t('common.close')} onClick={onClose} size={16} />
      </header>
      <div className="compare-scroll">
        <div className="segmented" role="radiogroup" aria-label={t('sig.calendar')} data-testid="sig-calendar">
          {(['gregory', 'islamic'] as Calendar[]).map((c) => (
            <button key={c} type="button" role="radio" aria-checked={calendar === c} className={calendar === c ? 'on' : ''} onClick={() => setCalendar(c)} data-calendar={c}>
              {t(c === 'gregory' ? 'sig.calendar.gregorian' : 'sig.calendar.hijri')}
            </button>
          ))}
        </div>
        {state.checking && (
          <p className="compare-status" aria-live="polite">
            <span className="spinner spinner-sm" aria-hidden="true" />
            {t('sig.checking')}
          </p>
        )}
        {state.error && <p className="field-error">{t('sig.error', { reason: state.error })}</p>}
        {!state.checking && (state.reports?.length ?? 0) === 0 && !state.error && <p className="muted">{t('sig.none')}</p>}
        <ol className="sig-list">
          {(state.reports ?? []).map((r) => (
            <li key={`${r.field}-${r.index}`}>
              <SignatureCard doc={doc} report={r} calendar={calendar} />
            </li>
          ))}
        </ol>
        <TrustSection />
      </div>
    </aside>
  );
}

function SignatureCard({ doc, report: r, calendar }: { doc: OpenDocument; report: SignatureReport; calendar: Calendar }) {
  const app = useApp();
  const { t, state } = app;
  const tone = statusTone(r.status);
  const time = r.timestamp?.time ?? r.claimedTime;
  const kindLabel =
    r.kind === 'documentTimestamp' ? t('sig.kind.documentTimestamp') : r.kind === 'certification' ? t('sig.kind.certification', { p: t(`sign.kind.p${(r.certification ?? 2) as 1 | 2 | 3}`) }) : t('sig.kind.approval');
  const viewSigned = async () => {
    const bytes = signedVersion(doc.bytes, r);
    if (!bytes) return;
    const base = doc.name.replace(/\.pdf$/i, '');
    await app.openFiles([{ name: `${base} (${t('sig.signedVersionSuffix')}).pdf`, bytes }]);
  };
  const disallowed = r.modifications.filter((m) => !m.allowed);
  return (
    <article className={`sig-card tone-${tone}`} data-testid="sig-card" data-status={r.status}>
      <header className="sig-card-head">
        <span className="sig-icon" aria-hidden="true">
          {toneIcon(tone)}
        </span>
        <div>
          <strong className="sig-signer" data-testid="sig-signer">
            <bdi>{r.signer?.name ?? r.timestamp?.authority ?? r.field}</bdi>
          </strong>
          <span className="sig-status" data-testid="sig-status">
            {t(statusKey(r.status))}
          </span>
        </div>
      </header>
      <dl className="props sig-props">
        <dt>{t('sig.field.kind')}</dt>
        <dd>{kindLabel}</dd>
        {time && (
          <>
            <dt>{r.timestamp?.time ? t('sig.field.timestamped') : t('sig.field.claimedTime')}</dt>
            <dd data-testid="sig-time">{formatSignTime(time, state.locale, calendar)}</dd>
          </>
        )}
        <dt>{t('sig.field.level')}</dt>
        <dd dir="ltr">{r.level}</dd>
        {r.timestamp && (
          <>
            <dt>{t('sig.field.tsa')}</dt>
            <dd>
              <bdi>{r.timestamp.authority ?? '—'}</bdi> · {r.timestamp.valid ? (r.timestamp.trusted ? t('sig.tsa.trusted') : t('sig.tsa.untrusted')) : t('sig.tsa.invalid')}
            </dd>
          </>
        )}
        <dt>{t('sig.field.identity')}</dt>
        <dd>{t(r.identity === 'trusted' ? 'sig.identity.trusted' : r.identity === 'invalid' ? 'sig.identity.invalid' : 'sig.identity.unknown')}</dd>
        {r.chain.length > 0 && (
          <>
            <dt>{t('sig.field.chain')}</dt>
            <dd className="sig-chain">
              {r.chain.map((c, i) => (
                <span key={i}>
                  {i > 0 && <span aria-hidden="true"> ← </span>}
                  <bdi>{c}</bdi>
                </span>
              ))}
            </dd>
          </>
        )}
        {r.signer && (
          <>
            <dt>{t('sig.field.validity')}</dt>
            <dd>{t('sign.cert.validRange', { from: formatDay(r.signer.notBefore, state.locale, calendar), to: formatDay(r.signer.notAfter, state.locale, calendar) })}</dd>
          </>
        )}
        {r.reason && (
          <>
            <dt>{t('sign.ap.reasonLabel')}</dt>
            <dd dir="auto">{r.reason}</dd>
          </>
        )}
        {r.location && (
          <>
            <dt>{t('sign.ap.locationLabel')}</dt>
            <dd dir="auto">{r.location}</dd>
          </>
        )}
        {r.revocation && !r.revocation.startsWith('unknown') && (
          <>
            <dt>{t('sig.field.revocation')}</dt>
            <dd dir="ltr">{r.revocation}</dd>
          </>
        )}
      </dl>
      {r.reasons.length > 0 && (
        <ul className="sig-notes sig-reasons" data-testid="sig-reasons">
          {r.reasons.map((n, i) => (
            <li key={i} data-code={n.code}>
              {noteText(t, n.code, n.message, 'reason')}
            </li>
          ))}
        </ul>
      )}
      {r.attacks.length > 0 && (
        <ul className="sig-notes sig-attacks" data-testid="sig-attacks">
          {r.attacks.map((a, i) => (
            <li key={i} data-kind={a.kind}>
              <Icon name="redact" size={14} /> {noteText(t, a.kind, a.detail, 'attack')}
            </li>
          ))}
        </ul>
      )}
      {r.warnings.length > 0 && (
        <ul className="sig-notes sig-warnings" data-testid="sig-warnings">
          {r.warnings.map((n, i) => (
            <li key={i} data-code={n.code}>
              {noteText(t, n.code, n.message, 'reason')}
            </li>
          ))}
        </ul>
      )}
      <h4 className="sig-sub">{r.coversWholeDocument ? t('sig.mods.none') : t('sig.mods.title', { count: r.modifications.length })}</h4>
      {r.modifications.length > 0 && (
        <ul className="sig-mods" data-testid="sig-mods">
          {r.modifications.map((m, i) => (
            <li key={i} data-kind={m.kind} data-allowed={m.allowed}>
              <span className={`badge ${m.allowed ? 'badge-inserted' : 'badge-deleted'}`}>{m.allowed ? t('sig.mods.allowed') : t('sig.mods.disallowed')}</span>{' '}
              {noteText(t, m.kind, m.detail, 'mod')}
              {m.page != null && <span className="muted"> · {t('compare.pageShort', { page: m.page + 1 })}</span>}
            </li>
          ))}
        </ul>
      )}
      {disallowed.length > 0 && <p className="field-error">{t('sig.mods.disallowedNote')}</p>}
      {!r.coversWholeDocument && r.byteRange[0] === 0 && (
        <button type="button" className="btn btn-small" onClick={() => void viewSigned()} data-testid="sig-view-signed">
          <Icon name="doc" size={14} />
          {t('sig.viewSigned')}
        </button>
      )}
    </article>
  );
}

function TrustSection() {
  const app = useApp();
  const { t, state } = app;
  const store = useTrustStore();
  const version = useTrustVersion();
  const [certs, setCerts] = useState<TrustedCert[] | null>(null);
  const reload = useCallback(() => {
    loadTrusted(app.engine(), store).then(setCerts, () => setCerts([]));
  }, [app, store]);
  useEffect(reload, [reload, version]);
  const add = async () => {
    try {
      const [f] = await app.host.openFiles({ multiple: false, accept: ['.pem', '.cer', '.crt', '.der', 'application/x-x509-ca-cert'] });
      if (!f) return;
      const added = await importTrusted(app.engine(), store, f.bytes);
      app.toast(t('sig.trust.added', { count: added.length }), 'success');
      trustChanged();
    } catch (e) {
      app.toast(t('sig.trust.failed', { reason: e instanceof Error ? e.message : String(e) }), 'error');
    }
  };
  return (
    <section className="sign-section sig-trust" data-testid="sig-trust">
      <h3 className="compare-sub">{t('sig.trust.title')}</h3>
      <p className="fineprint">{t('sig.trust.note')}</p>
      {certs && certs.length === 0 && <p className="muted">{t('sig.trust.empty')}</p>}
      <ul className="trust-list">
        {(certs ?? []).map((c) => (
          <li key={c.info.sha256} data-testid="sig-trust-item">
            <span>
              <bdi>{c.info.name}</bdi>
              <span className="fineprint"> · {t('sig.trust.until', { date: formatDay(c.info.notAfter, state.locale) })}</span>
            </span>
            <IconButton
              icon="trash"
              label={t('sig.trust.remove', { name: c.info.name })}
              size={14}
              onClick={() => void store.remove(c.info.sha256).then(trustChanged)}
            />
          </li>
        ))}
      </ul>
      <button type="button" className="btn" onClick={() => void add()} data-testid="sig-trust-add">
        <Icon name="plus" size={16} />
        {t('sig.trust.add')}
      </button>
    </section>
  );
}
