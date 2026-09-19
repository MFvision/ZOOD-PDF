import { useState } from 'react';
import { FileDown, KeyRound, ListChecks, Loader, PenLine, Trash2, Usb } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { isTauriHost, pkcs11Certificates, pkcs11Sign } from '../core/host-tauri';
import type { TokenCertificate } from '../core/host-tauri';
import { loadEditFont } from '../edit/editFont';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { AuthorityPicker } from './AuthorityPicker';
import { TIMESTAMP_AUTHORITIES, appearanceLines } from './model';
import { RectPicker, defaultRect } from './RectPicker';
import type { ShownRect } from './RectPicker';
import { useSignatures } from './SignaturesContext';
import { canReachAuthorities, decodeSignatureImage, withTimestamp } from './sign';
import type { SignReply, SignatureImage } from './sign';

/** What a certificate file holds, as `signatures.identity` describes it. */
interface Identity {
  name: string;
  issuer: string;
  notAfter: string;
  validNow: boolean;
  key: string;
  rsa: boolean;
  canSign: boolean;
}

type Source = 'file' | 'token';

/** An error from the core or the host, as the person should read it. */
function errorKey(error: unknown): TKey {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('E_P12_PASSWORD')) return 'signatures.error.password';
  if (message.includes('E_P12')) return 'signatures.error.p12';
  if (message.includes('E_SIGN_CERTIFY_FIRST')) return 'signatures.error.certifyFirst';
  if (message.includes('E_SIGN_CERTIFIED')) return 'signatures.error.certified';
  if (message.includes('E_PKCS11_PIN')) return 'signatures.error.pin';
  if (message.includes('E_PKCS11')) return 'signatures.error.token';
  if (message.includes('E_NET') || message.includes('E_TSA')) return 'signatures.error.timestamp';
  return 'signatures.error.failed';
}

export function SignForm({ onSigned }: { onSigned: () => void }) {
  const { t, lang, dir } = useI18n();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const { report, refresh } = useSignatures();
  const desktop = isTauriHost();
  const pageCount = state.document?.pageCount ?? 1;

  const [source, setSource] = useState<Source>('file');
  const [p12, setP12] = useState<{ name: string; bytes: ArrayBuffer } | null>(null);
  const [p12Password, setP12Password] = useState('');
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [module, setModule] = useState('');
  const [pin, setPin] = useState('');
  const [tokenCerts, setTokenCerts] = useState<TokenCertificate[]>([]);
  const [tokenCert, setTokenCert] = useState<number>(0);

  const [field, setField] = useState<string>('');
  const [visible, setVisible] = useState(true);
  const [page, setPage] = useState(Math.max(0, state.currentPage - 1));
  const [rect, setRect] = useState<ShownRect>(() => defaultRect(state.document?.pageSizes[page] ?? [595, 842], dir === 'rtl'));
  const [image, setImage] = useState<SignatureImage | null>(null);
  const [reason, setReason] = useState('');
  const [location, setLocation] = useState('');
  const [contact, setContact] = useState('');
  const [kind, setKind] = useState<'approval' | '1' | '2' | '3'>('approval');
  const [lock, setLock] = useState(false);
  const [pss, setPss] = useState(false);
  const [timestamp, setTimestamp] = useState(false);
  const [authority, setAuthority] = useState<string>(TIMESTAMP_AUTHORITIES[0].url);

  const [busy, setBusy] = useState<'open' | 'sign' | null>(null);
  const [error, setError] = useState<TKey | null>(null);
  const [signed, setSigned] = useState(false);

  const alreadySigned = (report?.signatures.length ?? 0) > 0;
  const certified = report?.certified ?? null;
  const signer = source === 'file' ? identity?.name : tokenCerts[tokenCert]?.name;
  const ready =
    busy === null &&
    state.switching === null &&
    (source === 'file' ? identity !== null && p12 !== null : tokenCerts.length > 0) &&
    certified !== 1 &&
    (!timestamp || authority !== '');

  const openIdentity = async () => {
    if (!p12) return;
    setBusy('open');
    setError(null);
    setIdentity(null);
    try {
      const { result } = await services.client.callStatic<Identity>(
        'signatures.identity',
        { p12Password, now: Math.floor(Date.now() / 1000) },
        [p12.bytes.slice(0)],
      );
      setIdentity(result);
      setPss(false);
    } catch (e) {
      setError(errorKey(e));
    } finally {
      setBusy(null);
    }
  };

  const listToken = async () => {
    setBusy('open');
    setError(null);
    try {
      setTokenCerts(await pkcs11Certificates(module.trim(), pin));
      setTokenCert(0);
    } catch (e) {
      setError(errorKey(e));
      setTokenCerts([]);
    } finally {
      setBusy(null);
    }
  };

  const sign = async () => {
    setBusy('sign');
    setError(null);
    setSigned(false);
    try {
      // Signing is the last thing written: the file as it stands, with
      // everything done to it so far kept as updates of its own bytes.
      const bytes = await services.fileBytesForChange();
      if (!bytes) throw new Error('E_NOT_FOUND: no open file');
      const now = new Date();
      const font = await loadEditFont('amiri');
      const args = {
        password: services.documentPassword ?? null,
        p12Password,
        field: field || null,
        page,
        rect: visible && !field ? rect : null,
        lines: appearanceLines(t, signer ?? '', now, reason, location),
        image: visible && image ? { width: image.width, height: image.height } : null,
        reason: reason.trim() || null,
        location: location.trim() || null,
        contact: contact.trim() || null,
        time: Math.floor(now.getTime() / 1000),
        offsetMinutes: -now.getTimezoneOffset(),
        certify: kind === 'approval' ? null : Number(kind),
        lockFields: lock,
        pss,
        timestamp: timestamp && canReachAuthorities(),
      };
      const extra = [font.slice().buffer, ...(visible && image ? [image.rgba.slice(0)] : [])];
      let reply: SignReply;
      if (source === 'file' && p12) {
        const r = await services.client.callStatic<{ done: boolean }>('signatures.sign', args, [bytes, p12.bytes.slice(0), ...extra]);
        reply = { json: r.result, blobs: r.blobs };
      } else {
        const certificate = tokenCerts[tokenCert];
        if (!certificate) throw new Error('E_PKCS11: no certificate');
        const r = await pkcs11Sign(module.trim(), pin, certificate, args, [bytes, ...extra]);
        reply = { json: JSON.parse(r.json) as { done: boolean }, blobs: r.blobs };
      }
      const result = reply.json.done ? reply.blobs[0] : await withTimestamp(services.client, reply, authority);
      if (!result) throw new Error('E_SIGN: no file');
      await services.replaceFile(result);
      refresh();
      setSigned(true);
      dispatch({ type: 'TOAST', key: 'signatures.saveToKeep' });
    } catch (e) {
      setError(errorKey(e));
    } finally {
      setBusy(null);
    }
  };

  const chooseImage = async (file: File | undefined) => {
    if (!file) return;
    try {
      setImage(await decodeSignatureImage(file));
    } catch {
      setError('signatures.error.image');
    }
  };

  return (
    <div className="sign-form">
      {certified === 1 && (
        <p className="field-error" role="alert">
          {t('signatures.error.certified')}
        </p>
      )}
      {desktop && (
        <fieldset>
          <legend>{t('signatures.sign.source')}</legend>
          <label>
            <input type="radio" name="sign-source" checked={source === 'file'} onChange={() => setSource('file')} />
            <span>{t('signatures.sign.fromFile')}</span>
          </label>
          <label>
            <input type="radio" name="sign-source" checked={source === 'token'} onChange={() => setSource('token')} />
            <span>{t('signatures.sign.fromToken')}</span>
          </label>
        </fieldset>
      )}

      {source === 'file' ? (
        <fieldset>
          <legend>{t('signatures.sign.certificate')}</legend>
          <label className="field">
            <span>{t('signatures.sign.p12')}</span>
            <input
              type="file"
              accept=".p12,.pfx,application/x-pkcs12"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                setIdentity(null);
                if (file) setP12({ name: file.name, bytes: await file.arrayBuffer() });
              }}
            />
          </label>
          {p12 && (
            <p className="tool-panel-note" dir="auto">
              {p12.name}
            </p>
          )}
          <label className="field">
            <span>{t('signatures.sign.p12Password')}</span>
            <input
              className="text-input"
              type="password"
              autoComplete="off"
              value={p12Password}
              onChange={(event) => {
                setP12Password(event.target.value);
                setIdentity(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void openIdentity();
              }}
            />
          </label>
          <div className="tool-actions">
            <IconButton
              label={busy === 'open' ? t('signatures.working') : t('signatures.sign.open')}
              icon={<Icon of={busy === 'open' ? Loader : KeyRound} />}
              showLabel
              disabled={!p12 || busy !== null}
              onClick={() => void openIdentity()}
            />
          </div>
          {identity && (
            <div className="signature-identity" role="status">
              <strong>{identity.name}</strong>
              <span className="tool-panel-note">{t('signatures.detail.issuedBy', { issuer: identity.issuer })}</span>
              <span className="tool-panel-note">
                {identity.key} · {t('signatures.detail.validUntil', { date: new Date(identity.notAfter).toLocaleDateString(lang === 'ar' ? 'ar' : 'en-GB') })}
              </span>
              {!identity.validNow && <span className="field-error">{t('signatures.sign.notValidNow')}</span>}
              {!identity.canSign && <span className="field-error">{t('signatures.problem.keyUsage')}</span>}
            </div>
          )}
        </fieldset>
      ) : (
        <fieldset>
          <legend>{t('signatures.sign.fromToken')}</legend>
          <label className="field">
            <span>{t('signatures.token.module')}</span>
            <input className="text-input" dir="ltr" spellCheck={false} placeholder="/usr/local/lib/opensc-pkcs11.so" value={module} onChange={(event) => setModule(event.target.value)} />
          </label>
          <label className="field">
            <span>{t('signatures.token.pin')}</span>
            <input className="text-input" type="password" autoComplete="off" value={pin} onChange={(event) => setPin(event.target.value)} />
          </label>
          <div className="tool-actions">
            <IconButton
              label={busy === 'open' ? t('signatures.working') : t('signatures.token.list')}
              icon={<Icon of={busy === 'open' ? Loader : Usb} />}
              showLabel
              disabled={module.trim() === '' || busy !== null}
              onClick={() => void listToken()}
            />
          </div>
          {tokenCerts.length > 0 && (
            <label className="field">
              <span>{t('signatures.token.certificate')}</span>
              <select className="select" value={tokenCert} onChange={(event) => setTokenCert(Number(event.target.value))}>
                {tokenCerts.map((c, i) => (
                  <option key={`${c.slot}-${c.id}`} value={i}>
                    {c.name} — {c.issuer}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="tool-panel-note">{t('signatures.token.note')}</p>
        </fieldset>
      )}

      <fieldset>
        <legend>{t('signatures.sign.placement')}</legend>
        {report && report.emptyFields.length > 0 && (
          <label className="field">
            <span>{t('signatures.sign.field')}</span>
            <select className="select" value={field} onChange={(event) => setField(event.target.value)}>
              <option value="">{t('signatures.sign.newField')}</option>
              {report.emptyFields.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        {!field && (
          <label>
            <input type="checkbox" checked={visible} onChange={(event) => setVisible(event.target.checked)} />
            <span>{t('signatures.sign.visible')}</span>
          </label>
        )}
        {visible && !field && (
          <>
            <label className="field">
              <span>{t('signatures.sign.page')}</span>
              <select
                className="select"
                value={page}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setPage(next);
                  setRect(defaultRect(state.document?.pageSizes[next] ?? [595, 842], dir === 'rtl'));
                }}
              >
                {Array.from({ length: pageCount }, (_, i) => (
                  <option key={i} value={i}>
                    {i + 1}
                  </option>
                ))}
              </select>
            </label>
            <RectPicker page={page} rect={rect} onRect={setRect} />
            <label className="field">
              <span>{t('signatures.sign.image')}</span>
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void chooseImage(event.target.files?.[0])} />
            </label>
            {image && (
              <div className="tool-actions">
                <IconButton label={t('signatures.sign.removeImage')} icon={<Icon of={Trash2} />} showLabel onClick={() => setImage(null)} />
              </div>
            )}
          </>
        )}
      </fieldset>

      <fieldset>
        <legend>{t('signatures.sign.about')}</legend>
        <label className="field">
          <span>{t('signatures.sign.reason')}</span>
          <input className="text-input" dir="auto" value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <label className="field">
          <span>{t('signatures.sign.location')}</span>
          <input className="text-input" dir="auto" value={location} onChange={(event) => setLocation(event.target.value)} />
        </label>
        <label className="field">
          <span>{t('signatures.sign.contact')}</span>
          <input className="text-input" dir="auto" value={contact} onChange={(event) => setContact(event.target.value)} />
        </label>
      </fieldset>

      <fieldset>
        <legend>{t('signatures.sign.options')}</legend>
        <label className="field">
          <span>{t('signatures.sign.kind')}</span>
          <select className="select" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="approval">{t('signatures.kind.approval')}</option>
            <option value="2" disabled={alreadySigned}>
              {t('signatures.kind.certification2')}
            </option>
            <option value="3" disabled={alreadySigned}>
              {t('signatures.kind.certification3')}
            </option>
            <option value="1" disabled={alreadySigned}>
              {t('signatures.kind.certification1')}
            </option>
          </select>
        </label>
        {alreadySigned && <p className="tool-panel-note">{t('signatures.sign.certifyFirstNote')}</p>}
        <label>
          <input type="checkbox" checked={lock} onChange={(event) => setLock(event.target.checked)} />
          <span>{t('signatures.sign.lock')}</span>
        </label>
        {identity?.rsa && source === 'file' && (
          <label>
            <input type="checkbox" checked={pss} onChange={(event) => setPss(event.target.checked)} />
            <span>{t('signatures.sign.pss')}</span>
          </label>
        )}
      </fieldset>

      <fieldset>
        <legend>{t('signatures.sign.time')}</legend>
        {canReachAuthorities() ? (
          <>
            <label>
              <input type="checkbox" checked={timestamp} onChange={(event) => setTimestamp(event.target.checked)} />
              <span>{t('signatures.sign.timestamp')}</span>
            </label>
            {timestamp && <AuthorityPicker value={authority} onChange={setAuthority} />}
          </>
        ) : (
          <p className="tool-panel-note">{t('signatures.sign.timestampWeb')}</p>
        )}
      </fieldset>

      <div className="tool-actions">
        <IconButton
          label={busy === 'sign' ? t('signatures.working') : signer ? t('signatures.sign.goAs', { name: signer }) : t('signatures.sign.go')}
          icon={<Icon of={busy === 'sign' ? Loader : PenLine} />}
          showLabel
          variant="primary"
          disabled={!ready}
          onClick={() => void sign()}
        />
      </div>
      {error && (
        <p className="field-error" role="alert">
          {t(error)}
        </p>
      )}
      {signed && (
        <div className="signature-outcome" role="status">
          <p>{t('signatures.sign.done')}</p>
          <div className="tool-actions">
            <IconButton label={t('signatures.sign.save')} icon={<Icon of={FileDown} />} showLabel onClick={() => void services.saveDocument()} />
            <IconButton label={t('signatures.sign.showList')} icon={<Icon of={ListChecks} />} showLabel onClick={onSigned} />
          </div>
        </div>
      )}
      <p className="tool-panel-note">{t('signatures.sign.note')}</p>
    </div>
  );
}
