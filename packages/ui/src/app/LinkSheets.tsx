/**
 * Links: the confirm-before-open sheet (every link click in a document lands here, never straight in
 * a browser tab) and the add/edit link sheet of the Edit tool. Both show the REAL hostname
 * prominently (IDN decoded, credentials stripped), refuse URLs with bidi control characters, and
 * make the person type the hostname before opening or writing a look-alike (mixed-script) host.
 */
import { useEffect, useId, useState } from 'react';
import { useApp } from '../services/AppContext';
import { checkUrl, openableScheme, type UrlCheck } from '../services/editor';
import { Sheet } from './primitives';
import type { MessageKey } from '../i18n';

const PROBLEM_KEYS: Record<string, MessageKey> = {
  bidi_controls: 'link.problem.bidi',
  control_chars: 'link.problem.control',
  scheme: 'link.problem.scheme',
  no_host: 'link.problem.noHost',
  bad_punycode: 'link.problem.punycode',
  mixed_script: 'link.problem.mixed',
  confusable: 'link.problem.confusable',
  credentials: 'link.problem.credentials',
  ip_address: 'link.problem.ip',
  too_long: 'link.problem.long',
};

/** Arabic-Indic / Persian digits → ASCII. */
export function asciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10));
}

function Problems({ check }: { check: UrlCheck }) {
  const { t } = useApp();
  const list = check.problems.filter((p) => PROBLEM_KEYS[p] && p !== 'ip_address');
  if (list.length === 0) return null;
  return (
    <ul className="link-problems" data-testid="link-problems">
      {list.map((p) => (
        <li key={p} data-problem={p}>
          {t(PROBLEM_KEYS[p]!)}
        </li>
      ))}
    </ul>
  );
}

/** Host display: big, isolated, left-to-right, with the network (Punycode) form under it when different. */
function HostLine({ check }: { check: UrlCheck }) {
  const { t } = useApp();
  return (
    <div className="link-host-box">
      <span className="link-host-label">{t('link.host')}</span>
      <bdi className="link-host" dir="ltr" data-testid="link-host">
        {check.host || check.url}
      </bdi>
      {check.asciiHost && check.asciiHost !== check.host && (
        <bdi className="link-host-ascii" dir="ltr">
          {check.asciiHost}
        </bdi>
      )}
    </div>
  );
}

/** Confirm before opening a link found in a document. */
export function LinkConfirmSheet({ url, onClose }: { url: string; onClose: () => void }) {
  const app = useApp();
  const { t } = app;
  const [check, setCheck] = useState<UrlCheck | null>(null);
  const [typed, setTyped] = useState('');
  const inputId = useId();
  useEffect(() => {
    let alive = true;
    checkUrl(app.engine(), url)
      .then((c) => alive && setCheck(c))
      .catch(() => alive && setCheck({ verdict: 'reject', scheme: '', host: '', asciiHost: '', url, problems: ['scheme'] }));
    return () => {
      alive = false;
    };
  }, [app, url]);
  const blocked = !check || check.verdict === 'reject' || !openableScheme(check);
  const needsTyping = check?.verdict === 'warn';
  const typedOk = !needsTyping || typed.trim().toLowerCase() === check?.host;
  const open = () => {
    if (!check || blocked || !typedOk) return;
    window.open(check.url, '_blank', 'noopener,noreferrer');
    onClose();
  };
  return (
    <Sheet
      title={check && blocked ? t('link.blocked.title') : t('link.open.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} data-testid="link-cancel">
            {blocked ? t('common.close') : t('common.cancel')}
          </button>
          {!blocked && (
            <button type="button" className="btn btn-primary" onClick={open} disabled={!typedOk} data-testid="link-open">
              {t('link.open.action')}
            </button>
          )}
        </>
      }
    >
      <div className="link-sheet" data-testid="link-confirm" data-verdict={check?.verdict ?? 'pending'}>
        {check ? (
          <>
            <HostLine check={check} />
            <p className="link-url-label">{t('link.fullUrl')}</p>
            <code className="link-url" dir="ltr" data-testid="link-url">
              {check.url}
            </code>
            {check.verdict === 'reject' && <p className="field-error">{t('link.blocked.body')}</p>}
            <Problems check={check} />
            {needsTyping && !blocked && (
              <div className="link-typing">
                <label htmlFor={inputId}>{t('link.typeHost')}</label>
                <input id={inputId} className="text-input" dir="ltr" value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="link-type-host" autoComplete="off" />
              </div>
            )}
          </>
        ) : (
          <span className="spinner" aria-label={t('doc.loading')} />
        )}
      </div>
    </Sheet>
  );
}

export interface LinkDraft {
  mode: 'add' | 'edit';
  uri?: string;
  page?: number;
}

/** Add or edit a link target (web address or page of this document). */
export function LinkEditSheet({
  draft,
  pageCount,
  onSubmit,
  onClose,
}: {
  draft: LinkDraft;
  pageCount: number;
  onSubmit: (target: { uri?: string; targetPage?: number; confirmHost?: string }) => void;
  onClose: () => void;
}) {
  const app = useApp();
  const { t, state } = app;
  const [kind, setKind] = useState<'uri' | 'page'>(draft.page !== undefined ? 'page' : 'uri');
  const [uri, setUri] = useState(draft.uri ?? 'https://');
  const [page, setPage] = useState(draft.page !== undefined ? String(draft.page + 1) : '');
  const [checked, setCheck] = useState<UrlCheck | null>(null);
  const [typed, setTyped] = useState('');
  const check = kind === 'uri' && uri.trim() && checked?.url === uri.trim() ? checked : null;
  const uriId = useId();
  const pageId = useId();
  const hostId = useId();

  useEffect(() => {
    if (kind !== 'uri' || !uri.trim()) return;
    let alive = true;
    const h = setTimeout(() => {
      checkUrl(app.engine(), uri)
        .then((c) => alive && setCheck(c))
        .catch(() => alive && setCheck(null));
    }, 120);
    return () => {
      alive = false;
      clearTimeout(h);
    };
  }, [app, kind, uri]);

  const pageNum = Number.parseInt(asciiDigits(page.trim()), 10);
  const pageOk = Number.isInteger(pageNum) && pageNum >= 1 && pageNum <= pageCount;
  const uriOk = !!check && check.verdict !== 'reject' && (check.verdict !== 'warn' || typed.trim().toLowerCase() === check.host);
  const ok = kind === 'page' ? pageOk : uriOk;
  const submit = () => {
    if (!ok) return;
    if (kind === 'page') onSubmit({ targetPage: pageNum - 1 });
    else onSubmit({ uri: check!.url, confirmHost: check!.verdict === 'warn' ? typed.trim().toLowerCase() : undefined });
  };
  return (
    <Sheet
      title={draft.mode === 'add' ? t('link.add.title') : t('link.edit.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!ok} data-testid="link-save">
            {t('link.save')}
          </button>
        </>
      }
    >
      <div className="link-sheet" data-testid="link-edit">
        <div className="segmented" role="radiogroup" aria-label={t('link.target')}>
          <button type="button" role="radio" aria-checked={kind === 'uri'} className={kind === 'uri' ? 'on' : ''} onClick={() => setKind('uri')} data-kind="uri">
            {t('link.kind.web')}
          </button>
          <button type="button" role="radio" aria-checked={kind === 'page'} className={kind === 'page' ? 'on' : ''} onClick={() => setKind('page')} data-kind="page">
            {t('link.kind.page')}
          </button>
        </div>
        {kind === 'uri' ? (
          <>
            <label htmlFor={uriId}>{t('link.address')}</label>
            <input id={uriId} className="text-input" dir="ltr" value={uri} onChange={(e) => setUri(e.target.value)} data-testid="link-uri" autoFocus autoComplete="off" />
            {check && (
              <>
                <HostLine check={check} />
                {check.verdict === 'reject' && <p className="field-error">{t('link.refused')}</p>}
                <Problems check={check} />
                {check.verdict === 'warn' && (
                  <div className="link-typing">
                    <label htmlFor={hostId}>{t('link.typeHost')}</label>
                    <input id={hostId} className="text-input" dir="ltr" value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="link-type-host" autoComplete="off" />
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <label htmlFor={pageId}>{t('link.pageNumber', { total: pageCount })}</label>
            <input
              id={pageId}
              className="text-input"
              inputMode="numeric"
              dir="auto"
              value={page}
              onChange={(e) => setPage(e.target.value)}
              data-testid="link-page"
              placeholder={new Intl.NumberFormat(state.locale === 'ar' ? 'ar-u-nu-arab' : 'en').format(1)}
            />
          </>
        )}
      </div>
    </Sheet>
  );
}
