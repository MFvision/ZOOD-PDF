/**
 * Protect panel (engine-backed, replaces EmbedPDF's protection modal): open password with AES-256,
 * owner password, eight permissions, change or remove the protection. Every change is a whole rewrite;
 * later incremental saves keep the protection (the engine re-encrypts appended objects with the key).
 *
 * Also the password prompt shown BEFORE a protected file reaches EmbedPDF: the engine checks the
 * password, then both the engine (for saves) and the viewer get it.
 */
import { useEffect, useId, useState } from 'react';
import { useApp } from '../services/AppContext';
import type { OpenDocument } from '../services/state';
import type { MessageKey } from '../i18n';
import {
  ALL_PERMISSIONS,
  docInfo,
  passwordOpens,
  removeProtection,
  setProtection,
  type DocInfo,
  type Permissions,
} from '../services/redact';
import { IconButton, Sheet } from './primitives';
import { workingBytes } from './RedactPanel';

const PERMS: (keyof Permissions)[] = ['print', 'printHighQuality', 'copy', 'modify', 'annotate', 'fillForms', 'accessibility', 'assemble'];

function reasonOf(e: unknown): string {
  return e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
}

export function ProtectPanel({ doc, onClose }: { doc: OpenDocument; onClose: () => void }) {
  const app = useApp();
  const { t } = app;
  const [info, setInfo] = useState<DocInfo | null>(null);
  const [requireOpen, setRequireOpen] = useState(true);
  const [openPw, setOpenPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [ownerPw, setOwnerPw] = useState('');
  const [currentOwner, setCurrentOwner] = useState('');
  const [perms, setPerms] = useState<Permissions>(ALL_PERMISSIONS);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = useId();

  useEffect(() => {
    let alive = true;
    docInfo(app.engine(), doc.bytes, doc.password)
      .then((i) => {
        if (!alive) return;
        setInfo(i);
        if (i.encrypted) setPerms(i.permissions);
      })
      .catch(() => alive && setInfo(null));
    return () => {
      alive = false;
    };
  }, [app, doc.bytes, doc.password]);

  const encrypted = !!info?.encrypted;
  const needsOwner = encrypted && info?.passwordMatched === 'user';

  /** Bytes and the password to open them with owner rights. */
  const source = async (): Promise<{ bytes: Uint8Array; password: string | undefined } | null> => {
    const bytes = await workingBytes(app, doc, doc.edited && !doc.warraqOwnsDocument);
    if (!needsOwner) return { bytes, password: doc.password };
    if (!(await passwordOpens(app.engine(), bytes, currentOwner))) {
      setError(t('protect.error.owner'));
      return null;
    }
    const again = await docInfo(app.engine(), bytes, currentOwner);
    if (again.passwordMatched !== 'owner') {
      setError(t('protect.error.owner'));
      return null;
    }
    return { bytes, password: currentOwner };
  };

  const protect = async () => {
    setError(null);
    const user = requireOpen ? openPw : '';
    if (requireOpen && openPw !== confirmPw) return setError(t('protect.error.mismatch'));
    if (!user && !ownerPw) return setError(t('protect.error.empty'));
    setBusy(true);
    try {
      const src = await source();
      if (!src) return;
      const out = await setProtection(app.engine(), src.bytes, src.password, { userPassword: user, ownerPassword: ownerPw, permissions: perms });
      // The viewer and later saves open the file with owner rights.
      await app.replaceWithCoreBytes(doc.id, out, { password: ownerPw || user });
      setOpenPw('');
      setConfirmPw('');
      setOwnerPw('');
      setCurrentOwner('');
      app.toast(t('protect.toast.set'), 'success');
    } catch (e) {
      app.toast(t('protect.toast.failed', { reason: reasonOf(e) }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setError(null);
    setBusy(true);
    try {
      const src = await source();
      if (!src) return;
      const out = await removeProtection(app.engine(), src.bytes, src.password);
      await app.replaceWithCoreBytes(doc.id, out, { password: null });
      app.toast(t('protect.toast.removed'), 'success');
    } catch (e) {
      app.toast(t('protect.toast.failed', { reason: reasonOf(e) }), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="tool-panel glass" aria-label={t('protect.title')} data-testid="protect-panel">
      <header className="tool-panel-head">
        <h2 className="panel-title">{t('protect.title')}</h2>
        <IconButton icon="close" label={t('common.close')} onClick={onClose} />
      </header>
      <div className="tool-panel-body">
        <p className="status-line" data-testid="protect-status">
          {encrypted ? t('protect.status.on', { method: info?.encryption?.method ?? '' }) : t('protect.status.off')}
        </p>
        {needsOwner && (
          <>
            <p className="fineprint">{t('protect.status.user')}</p>
            <label className="field-label">
              <span>{t('protect.currentOwner')}</span>
              <input className="text-input" type="password" value={currentOwner} onChange={(e) => setCurrentOwner(e.target.value)} autoComplete="off" data-testid="protect-current-owner" />
            </label>
          </>
        )}
        <form
          className="tool-form"
          onSubmit={(e) => {
            e.preventDefault();
            void protect();
          }}
        >
          <label className="check-row">
            <input type="checkbox" checked={requireOpen} onChange={() => setRequireOpen(!requireOpen)} data-testid="protect-require-open" />
            <span>{t('protect.requireOpen')}</span>
          </label>
          {requireOpen && (
            <>
              <label className="field-label" htmlFor={`${ids}-open`}>
                <span>{t('protect.openPassword')}</span>
              </label>
              <input id={`${ids}-open`} className="text-input" type="password" value={openPw} onChange={(e) => setOpenPw(e.target.value)} autoComplete="new-password" data-testid="protect-open-password" />
              <label className="field-label" htmlFor={`${ids}-confirm`}>
                <span>{t('protect.confirm')}</span>
              </label>
              <input id={`${ids}-confirm`} className="text-input" type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" data-testid="protect-open-confirm" />
            </>
          )}
          <label className="field-label" htmlFor={`${ids}-owner`}>
            <span>{t('protect.ownerPassword')}</span>
          </label>
          <input id={`${ids}-owner`} className="text-input" type="password" value={ownerPw} onChange={(e) => setOwnerPw(e.target.value)} autoComplete="new-password" data-testid="protect-owner-password" />
          <p className="fineprint">{t('protect.ownerHint')}</p>
          <fieldset className="field">
            <legend>{t('protect.permissions')}</legend>
            {PERMS.map((k) => (
              <label key={k} className="check-row">
                <input type="checkbox" checked={perms[k]} data-perm={k} onChange={() => setPerms({ ...perms, [k]: !perms[k] })} />
                <span>{t(`protect.perm.${k}` as MessageKey)}</span>
              </label>
            ))}
          </fieldset>
          <p className="fineprint">
            {t('protect.encryption')} · {t('protect.rewriteNote')}
          </p>
          {error && (
            <p className="form-error" role="alert" data-testid="protect-error">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn-primary" disabled={busy} data-testid="protect-apply">
            {busy ? t('protect.working') : encrypted ? t('protect.change') : t('protect.apply')}
          </button>
        </form>
        {encrypted && (
          <button type="button" className="btn btn-danger-quiet" disabled={busy} onClick={() => void remove()} data-testid="protect-remove">
            {t('protect.remove')}
          </button>
        )}
      </div>
    </aside>
  );
}

/** Our password prompt: nothing reaches EmbedPDF until the engine accepted the password. */
export function PasswordPrompt() {
  const req = useApp().passwordRequest;
  // Keyed by request: every prompt (including a retry after a wrong password) starts empty.
  return req ? <PasswordSheet key={req.id} name={req.name} wrong={req.wrong} /> : null;
}

function PasswordSheet({ name, wrong }: { name: string; wrong: boolean }) {
  const app = useApp();
  const [value, setValue] = useState('');
  const { t } = app;
  const submit = () => app.answerPassword(value);
  return (
    <Sheet
      title={t('password.title')}
      onClose={() => app.answerPassword(null)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => app.answerPassword(null)}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!value} data-testid="password-submit">
            {t('password.open')}
          </button>
        </>
      }
    >
      <form
        className="tool-form"
        data-testid="password-sheet"
        onSubmit={(e) => {
          e.preventDefault();
          if (value) submit();
        }}
      >
        <p>{t('password.body', { name })}</p>
        <input
          className="text-input"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={t('password.label')}
          autoComplete="off"
          data-testid="password-input"
        />
        {wrong && (
          <p className="form-error" role="alert" data-testid="password-error">
            {t('password.wrong')}
          </p>
        )}
      </form>
    </Sheet>
  );
}
