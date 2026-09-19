import { useState } from 'react';
import type { ChangeEvent } from 'react';
import { Clock, FilePlus2, Loader, RefreshCw, ShieldPlus, Trash2 } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useI18n, useT } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useServices } from '../state/AppContext';
import {
  CHANGE_KEY,
  STATUS_KEY,
  TIMESTAMP_AUTHORITIES,
  failureKey,
  fromBase64,
  isolate,
  problemText,
  statusReason,
  toBase64,
  unreachableReasonKey,
} from './model';
import type { CertSummary, SignatureReport, TrustedCert } from './model';
import { STATUS_ICON } from './SignatureBanner';
import { useSignatures } from './SignaturesContext';
import { addValidation, canReachAuthorities, timestampDocument } from './sign';
import { AuthorityPicker } from './AuthorityPicker';

/** A date and time as the reader reads them. */
function when(iso: string | null, lang: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(lang === 'ar' ? 'ar' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * One check in the details. Its words say whether it passed — a failed check
 * is never read aloud as a passed one; the mark and the colour only repeat it.
 */
function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={ok ? 'check-ok' : 'check-bad'}>
      <span aria-hidden="true">{ok ? '✓' : '✗'}</span> {label}
    </li>
  );
}

function CertLine({ cert }: { cert: CertSummary }) {
  const { t, lang } = useI18n();
  return (
    <li>
      <strong>
        <bdi>{cert.name}</bdi>
      </strong>
      <span className="tool-panel-note">
        {' '}
        {t('signatures.detail.issuedBy', { issuer: isolate(cert.issuer) })} · {t('signatures.detail.validUntil', { date: when(cert.notAfter, lang) })}
      </span>
    </li>
  );
}

/** What a reason sentence names: where trust ended. */
function reasonParams(s: SignatureReport): Record<string, string> {
  const trust = s.chain?.trust;
  return {
    anchor: isolate(trust && 'anchor' in trust ? trust.anchor : ''),
    root: isolate(trust?.state === 'untrustedRoot' ? trust.root : ''),
    missing: isolate(trust?.state === 'incomplete' ? trust.missing : ''),
  };
}

function SignatureCard({ s }: { s: SignatureReport }) {
  const { t, lang } = useI18n();
  const services = useServices();
  const { trust } = useSignatures();
  // A time is an authority's only when an authority trusted for timestamps stamped it.
  const stamped = s.timestamp?.valid && s.timestamp.trusted ? s.timestamp : null;
  const time = stamped ? stamped.time : s.claimedTime;
  // What trusting would trust: the signer's own certificate when it is not
  // for signing documents at all, else the top of its path.
  const forItself = s.problems.some((p) => p === 'eku' || p === 'eku:web' || p.startsWith('ekuCa:'));
  const trustName = (forItself ? s.signer?.name : s.chain?.certs.at(-1)?.name) ?? s.signedBy;
  const reason = statusReason(s);
  const kind: TKey =
    s.kind === 'certification'
      ? (`signatures.kind.certification${s.docMdp ?? 2}` as TKey)
      : s.kind === 'timestamp'
        ? 'signatures.kind.timestamp'
        : 'signatures.kind.approval';
  const problems = s.problems.map((p) => problemText(p, t)).filter((p): p is string => p !== null);
  return (
    <article className={`signature-card signature-${s.status}`} data-status={s.status} aria-label={s.field}>
      <header className="signature-card-head">
        <Icon of={STATUS_ICON[s.status]} />
        <strong>{t(STATUS_KEY[s.status])}</strong>
      </header>
      {reason && <p className="signature-reason">{t(reason, reasonParams(s))}</p>}
      <p className="signature-signer">
        <bdi>{s.signedBy || t('signatures.detail.unknownSigner')}</bdi>
      </p>
      {s.claimedName && s.claimedName !== s.signedBy && (
        <p className="tool-panel-note">{t('signatures.detail.claimedName', { name: isolate(s.claimedName) })}</p>
      )}
      <p className="tool-panel-note">
        {t(kind)}
        {s.page !== null && s.visible ? ` · ${t('signatures.detail.onPage', { page: s.page + 1 })}` : ''}
      </p>
      {time && (
        <p className="tool-panel-note">
          <Icon of={Clock} size={14} />{' '}
          {stamped
            ? t('signatures.detail.timestamped', { date: when(time, lang), authority: isolate(stamped.authority) })
            : t('signatures.detail.claimedTime', { date: when(time, lang) })}
        </p>
      )}
      {s.timestamp?.valid && !s.timestamp.trusted && (
        <p className="tool-panel-note">
          {t('signatures.detail.timestampUntrusted', { authority: isolate(s.timestamp.authority), date: when(s.timestamp.time, lang) })}
        </p>
      )}
      {s.reason && <p className="tool-panel-note">{t('signatures.detail.reason', { reason: isolate(s.reason) })}</p>}
      {s.location && <p className="tool-panel-note">{t('signatures.detail.location', { location: isolate(s.location) })}</p>}
      {s.changes.length > 0 && (
        <ul className="signature-changes">
          {s.changes.map((c) => (
            <li key={c.kind} className={c.allowed ? 'check-ok' : 'check-bad'}>
              {t(CHANGE_KEY[c.kind])} — {t(c.allowed ? 'signatures.change.allowed' : 'signatures.change.notAllowed')}
            </li>
          ))}
        </ul>
      )}
      {s.trustCandidate && s.status === 'untrusted' && (
        <div className="tool-actions">
          <IconButton
            label={t('signatures.trust.this', { name: isolate(trustName) })}
            icon={<Icon of={ShieldPlus} />}
            showLabel
            onClick={() => s.trustCandidate && trust([{ name: trustName, der: s.trustCandidate }])}
          />
        </div>
      )}
      <details className="signature-details">
        <summary>{t('signatures.detail.more')}</summary>
        <ul className="signature-checks">
          <Check
            ok={s.integrity.byteRangeOk}
            label={t(
              s.integrity.byteRangeOk
                ? 'signatures.detail.byteRange'
                : s.problems.includes('notInRevision')
                  ? 'signatures.detail.notInRevision'
                  : 'signatures.detail.byteRangeBad',
            )}
          />
          <Check ok={s.integrity.digestOk} label={t(s.integrity.digestOk ? 'signatures.detail.digest' : 'signatures.detail.digestBad')} />
          <Check
            ok={s.integrity.signatureOk}
            label={t(s.integrity.signatureOk ? 'signatures.detail.signature' : 'signatures.detail.signatureBad', {
              algorithm: s.integrity.algorithm || '—',
            })}
          />
          <Check ok={s.chain?.trust.state === 'trusted' && s.chain.purposeOk} label={trustText(s, t)} />
          <Check
            ok={s.chain?.validAtTime ?? false}
            label={t(s.chain?.validAtTime ? 'signatures.detail.validAtSigning' : 'signatures.detail.validAtSigningBad')}
          />
          {s.timestamp && (
            <Check
              ok={s.timestamp.valid && s.timestamp.trusted}
              label={t(
                !s.timestamp.valid
                  ? 'signatures.detail.timestampBad'
                  : s.timestamp.trusted
                    ? 'signatures.detail.timestampOk'
                    : 'signatures.detail.timestampUntrustedCheck',
                { authority: isolate(s.timestamp.authority) },
              )}
            />
          )}
          <Check ok={s.revocation.status === 'good'} label={t(`signatures.revocation.${s.revocation.status}` as TKey)} />
          <li className="tool-panel-note">
            {t(s.integrity.coversWholeFile ? 'signatures.detail.wholeFile' : 'signatures.detail.laterRevisions')}
          </li>
        </ul>
        {s.chain && s.chain.certs.length > 0 && (
          <>
            <p className="signature-subhead">{t('signatures.detail.chain')}</p>
            <ol className="signature-chain">
              {s.chain.certs.map((c) => (
                <CertLine key={c.serial + c.subject} cert={c} />
              ))}
            </ol>
          </>
        )}
        {problems.length > 0 && (
          <ul className="signature-problems">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {s.page !== null && s.visible && (
          <IconButton label={t('signatures.detail.goTo')} icon={<Icon of={FilePlus2} />} showLabel onClick={() => services.goToPage((s.page ?? 0) + 1)} />
        )}
      </details>
    </article>
  );
}

function trustText(s: SignatureReport, t: (key: TKey, params?: Record<string, string>) => string): string {
  const trust = s.chain?.trust;
  if (!trust) return t('signatures.trust.unknown');
  switch (trust.state) {
    case 'trusted':
      return t(trust.user ? 'signatures.trust.byYou' : 'signatures.trust.mozilla', { anchor: isolate(trust.anchor) });
    case 'webRoot':
      return t('signatures.trust.webRoot', { anchor: isolate(trust.anchor) });
    case 'untrustedRoot':
      return t('signatures.trust.untrustedRoot', { root: isolate(trust.root) });
    case 'broken':
      return t('signatures.trust.broken', { name: isolate(trust.name) });
    case 'incomplete':
      return t('signatures.trust.incomplete', { missing: isolate(trust.missing) });
  }
}

/** The certificates the person trusts on this device, and adding one. */
function TrustedList() {
  const t = useT();
  const services = useServices();
  const { trusted, trust, forget } = useSignatures();
  const [error, setError] = useState(false);
  const add = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(false);
    try {
      const { result, blobs } = await services.client.callStatic<{ certificates: CertSummary[] }>('signatures.certificates', {}, [await file.arrayBuffer()]);
      const found: TrustedCert[] = result.certificates.map((c, i) => ({ name: c.name, der: toBase64(blobs[i] ?? new ArrayBuffer(0)) }));
      if (found.length === 0) setError(true);
      else trust(found);
    } catch {
      setError(true);
    }
  };
  return (
    <fieldset>
        <legend>{t('signatures.trust.title')}</legend>
      {trusted.length === 0 ? (
        <p className="tool-panel-note">{t('signatures.trust.none')}</p>
      ) : (
        <ul className="signatures-trusted">
          {trusted.map((c) => (
            <li key={c.der}>
              <bdi>{c.name}</bdi>
              <IconButton label={t('signatures.trust.forget', { name: isolate(c.name) })} icon={<Icon of={Trash2} />} onClick={() => forget(c.der)} />
            </li>
          ))}
        </ul>
      )}
      <label className="field">
        <span>{t('signatures.trust.add')}</span>
        <input type="file" accept=".cer,.crt,.der,.pem,.p7b,.p7c" onChange={(event) => void add(event)} />
      </label>
      {error && (
        <p className="field-error" role="alert">
          {t('signatures.trust.notCertificate')}
        </p>
      )}
      <p className="tool-panel-note">{t('signatures.trust.note')}</p>
    </fieldset>
  );
}

/** Long-term validation and document timestamps: the desktop fetches them. */
function Validation() {
  const t = useT();
  const services = useServices();
  const dispatch = useAppDispatch();
  const { report, trusted, refresh } = useSignatures();
  const [busy, setBusy] = useState<'ltv' | 'timestamp' | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [authority, setAuthority] = useState<string>(TIMESTAMP_AUTHORITIES[0].url);
  if (!report || report.signatures.length === 0) return null;
  if (!canReachAuthorities()) {
    return (
      <fieldset>
        <legend>{t('signatures.ltv.title')}</legend>
        <p className="tool-panel-note">{t('signatures.ltv.webNote')}</p>
      </fieldset>
    );
  }
  const run = async (what: 'ltv' | 'timestamp') => {
    setBusy(what);
    setOutcome(null);
    setFailure(null);
    try {
      const bytes = await services.fileBytesForChange();
      if (!bytes) throw new Error('E_NOT_FOUND');
      if (what === 'ltv') {
        const done = await addValidation(services.client, bytes, services.documentPassword, trusted.map((c) => fromBase64(c.der)));
        await services.replaceFile(done.bytes);
        const lines = [t('signatures.ltv.added', { certs: done.certs, ocsps: done.ocsps, crls: done.crls })];
        for (const u of done.unreachable) {
          lines.push(t('signatures.ltv.unreachable', { url: isolate(u.url), about: isolate(u.about), reason: t(unreachableReasonKey(u.reason)) }));
        }
        if (done.rejected > 0) lines.push(t('signatures.ltv.rejected', { count: done.rejected }));
        setOutcome(lines.join('\n'));
      } else {
        await services.replaceFile(await timestampDocument(services.client, bytes, services.documentPassword, authority));
        setOutcome(t('signatures.docTimestamp.done'));
      }
      refresh();
      dispatch({ type: 'TOAST', key: 'signatures.saveToKeep' });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };
  return (
    <fieldset>
        <legend>{t('signatures.ltv.title')}</legend>
      <p className="tool-panel-note">{t('signatures.ltv.note')}</p>
      <div className="tool-actions">
        <IconButton
          label={busy === 'ltv' ? t('signatures.working') : t('signatures.ltv.go')}
          icon={<Icon of={busy === 'ltv' ? Loader : ShieldPlus} />}
          showLabel
          disabled={busy !== null}
          onClick={() => void run('ltv')}
        />
      </div>
      <AuthorityPicker value={authority} onChange={setAuthority} />
      <div className="tool-actions">
        <IconButton
          label={busy === 'timestamp' ? t('signatures.working') : t('signatures.docTimestamp.go')}
          icon={<Icon of={busy === 'timestamp' ? Loader : Clock} />}
          showLabel
          disabled={busy !== null || authority === ''}
          onClick={() => void run('timestamp')}
        />
      </div>
      {outcome && (
        <p className="signature-outcome" role="status">
          {outcome}
        </p>
      )}
      {failure && (
        <div className="field-error" role="alert">
          <p>{t(failureKey(failure))}</p>
          <details>
            <summary>{t('signatures.error.technical')}</summary>
            <p dir="ltr">{failure}</p>
          </details>
        </div>
      )}
    </fieldset>
  );
}

/** The file's signatures, each checked, and what can be done about them. */
export function SignatureList() {
  const { t, lang } = useI18n();
  const { report, checking, failed, refresh } = useSignatures();
  return (
    <div className="signature-list">
      {checking && (
        <p className="tool-panel-note" role="status">
          <Icon of={Loader} className="spin" /> {t('signatures.checking')}
        </p>
      )}
      {failed && (
        <p className="field-error" role="alert">
          {t('signatures.error.check')}
        </p>
      )}
      {report && report.signatures.length === 0 && !checking && <p className="tool-panel-note">{t('signatures.none')}</p>}
      {report?.signatures.map((s) => <SignatureCard key={`${s.field}-${s.revisionEnd}`} s={s} />)}
      {report && report.emptyFields.length > 0 && (
        <p className="tool-panel-note">{t('signatures.emptyFields', { names: report.emptyFields.map(isolate).join(lang === 'ar' ? '، ' : ', ') })}</p>
      )}
      {report && report.dss.certs + report.dss.ocsps + report.dss.crls > 0 && (
        <p className="tool-panel-note">{t('signatures.dss', { certs: report.dss.certs, ocsps: report.dss.ocsps, crls: report.dss.crls })}</p>
      )}
      <div className="tool-actions">
        <IconButton label={t('signatures.recheck')} icon={<Icon of={RefreshCw} />} showLabel disabled={checking} onClick={refresh} />
      </div>
      <Validation />
      <TrustedList />
    </div>
  );
}
