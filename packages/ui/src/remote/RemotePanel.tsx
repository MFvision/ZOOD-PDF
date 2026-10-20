import { useEffect, useRef, useState } from 'react';
import { Keyboard, Presentation, Send, Signature, Smartphone } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import { forgetPhone, giveToPhone, setClipboardSharing, setPcControl, startRemote, stopRemote } from './host';
import { MAX_FILE_BYTES, toBase64 } from './protocol';
import type { RemoteStatus } from './host';
import { updateRemote, useRemoteView } from './store';

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

/**
 * The phone remote's panel: turn it on, show the QR code a phone scans, see
 * who is connected, switch PC control, forget a phone. The QR code is drawn
 * by the desktop host (an SVG it made itself from its own address).
 */
export function RemotePanel() {
  const { t } = useI18n();
  const { status } = useRemoteView();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const run = async (action: () => Promise<RemoteStatus>) => {
    setBusy(true);
    setFailed(false);
    try {
      updateRemote({ status: await action() });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  // The code's countdown, and a new code when it runs out while the panel is open.
  const until = status?.codeUntil ?? null;
  useEffect(() => {
    if (!status?.running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [status?.running]);
  useEffect(() => {
    if (status?.running && until !== null && now > until) void startRemote().then((s) => updateRemote({ status: s }), () => undefined);
  }, [status?.running, until, now]);

  if (!status?.running) {
    return (
      <div className="remote-panel">
        <header className="remote-head">
          <span className="remote-head-icon">
            <Icon of={Smartphone} size={20} />
          </span>
          <div>
            <h2 className="remote-title">{t('remote.title')}</h2>
            <p className="remote-sub">{t('remote.subtitle')}</p>
          </div>
        </header>
        <ul className="remote-features">
          <li>
            <Icon of={Presentation} />
            <span>
              <strong>{t('remote.feature.present')}</strong>
              {t('remote.feature.presentBody')}
            </span>
          </li>
          <li>
            <Icon of={Keyboard} />
            <span>
              <strong>{t('remote.feature.pc')}</strong>
              {t('remote.feature.pcBody')}
            </span>
          </li>
          <li>
            <Icon of={Signature} />
            <span>
              <strong>{t('remote.feature.files')}</strong>
              {t('remote.feature.filesBody')}
            </span>
          </li>
          <li>
            <Icon of={Send} />
            <span>
              <strong>{t('remote.feature.flick')}</strong>
              {t('remote.feature.flickBody')}
            </span>
          </li>
        </ul>
        <p className="remote-privacy">{t('remote.privacy')}</p>
        {failed && <p className="remote-error">{t('remote.failed')}</p>}
        <button type="button" className="icon-btn icon-btn-labeled icon-btn-primary remote-wide" disabled={busy} onClick={() => void run(startRemote)}>
          {t('remote.turnOn')}
        </button>
      </div>
    );
  }

  const left = until === null ? 0 : Math.max(0, Math.round((until - now) / 1000));
  const minutes = Math.floor(left / 60);
  const seconds = String(left % 60).padStart(2, '0');

  return (
    <div className="remote-panel">
      <header className="remote-head">
        <span className="remote-head-icon remote-on">
          <Icon of={Smartphone} size={20} />
        </span>
        <div>
          <h2 className="remote-title">{t('remote.title')}</h2>
          <p className="remote-sub">{status.phones.length > 0 ? t('remote.connected', { name: status.phones.map((p) => p.name).join('، ') }) : t('remote.waiting')}</p>
        </div>
      </header>

      {status.address === null ? (
        <p className="remote-error">{t('remote.noNetwork')}</p>
      ) : status.qr ? (
        <div className="remote-code">
          {/* The host's own SVG of its own address: no outside markup. */}
          <div className="remote-qr" role="img" aria-label={t('remote.qrLabel')} dangerouslySetInnerHTML={{ __html: status.qr }} />
          <p className="remote-scan">{t('remote.scan')}</p>
          <p className="remote-timer">
            {t('remote.codeFor', { time: `${minutes}:${seconds}` })}{' '}
            <button type="button" className="link-btn" disabled={busy} onClick={() => void run(startRemote)}>
              {t('remote.newCode')}
            </button>
          </p>
        </div>
      ) : (
        <div className="remote-code">
          <p className="remote-scan">{t('remote.codeUsed')}</p>
          <button type="button" className="icon-btn icon-btn-labeled" disabled={busy} onClick={() => void run(startRemote)}>
            {t('remote.newCode')}
          </button>
        </div>
      )}
      {status.address && status.remembered.length > 0 && (
        <p className="remote-hint">
          {t('remote.pairedBefore')} <code dir="ltr">{status.address}</code>
        </p>
      )}

      {status.pcControlAvailable && (
        <label className="remote-switch">
          <input type="checkbox" role="switch" checked={status.pcControl} disabled={busy} onChange={(e) => void run(() => setPcControl(e.target.checked))} />
          <span>
            <strong>{t('remote.pcControl')}</strong>
            <span className="remote-switch-body">{isMac ? t('remote.pcControlMac') : t('remote.pcControlBody')}</span>
          </span>
        </label>
      )}

      {status.clipboardAvailable && (
        <label className="remote-switch">
          <input type="checkbox" role="switch" checked={status.clipboard} disabled={busy} onChange={(e) => void run(() => setClipboardSharing(e.target.checked))} />
          <span>
            <strong>{t('remote.clipboard')}</strong>
            <span className="remote-switch-body">{t('remote.clipboardBody')}</span>
          </span>
        </label>
      )}

      {status.phones.length > 0 && <GiveFiles />}

      {status.remembered.length > 0 && (
        <div className="remote-phones">
          <h3>{t('remote.remembered')}</h3>
          <ul>
            {status.remembered.map((phone) => (
              <li key={phone.id}>
                <span dir="auto">{phone.name}</span>
                {status.phones.some((p) => p.device === phone.id) && <span className="remote-dot" aria-label={t('remote.online')} />}
                <button type="button" className="link-btn" disabled={busy} onClick={() => void run(() => forgetPhone(phone.id))}>
                  {t('remote.forget')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {failed && <p className="remote-error">{t('remote.failed')}</p>}
      <button type="button" className="icon-btn icon-btn-labeled remote-wide" disabled={busy} onClick={() => void run(stopRemote)}>
        {t('remote.turnOff')}
      </button>
    </div>
  );
}

/** Files from this computer to the connected phones, picked here. */
function GiveFiles() {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const give = async (files: File[]) => {
    for (const file of files) {
      const sent = file.size <= MAX_FILE_BYTES && (await giveToPhone(file.name, file.type || 'application/octet-stream', toBase64(new Uint8Array(await file.arrayBuffer()))).catch(() => false));
      setNote(t(sent ? 'remote.giveSent' : 'remote.giveFailed', { name: file.name }));
    }
  };

  return (
    <div className="remote-give">
      <button type="button" className="icon-btn icon-btn-labeled remote-wide" onClick={() => input.current?.click()}>
        <Icon of={Send} />
        <span>{t('remote.give')}</span>
      </button>
      <p className="remote-switch-body">{t('remote.giveBody')}</p>
      {note && (
        <p className="remote-hint" role="status" dir="auto">
          {note}
        </p>
      )}
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          void give(files);
        }}
      />
    </div>
  );
}
