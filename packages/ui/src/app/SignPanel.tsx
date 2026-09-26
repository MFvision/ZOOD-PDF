/**
 * Digital signature panel: import a PKCS#12 and unlock it (the password stays in memory only
 * and is cleared after signing), check the certificate, place the signature (invisible, drawn
 * on the page, or an existing empty field), fill in the appearance, pick approval or
 * certification, field locks and the PAdES level (timestamps and long-term validation on the
 * desktop app only), then Sign: the engine appends an incremental update and the file is saved.
 */
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useApp } from '../services/AppContext';
import type { OpenDocument } from '../services/state';
import { EngineError } from '../services/engine';
import { rebaseOnOriginal } from '../services/save';
import { appearanceLines, DEFAULT_TSAS, formatDay, previewRectToPdf, type CertSummary, type PreviewRect } from '../services/signatures';
import { inspectP12, signPdf, signingTargets, type PageInfo, type SignatureField, type SignLevel, type SignStep } from '../services/signing';
import { formatNumber } from '../i18n';
import type { ViewerApi } from '../viewer/Viewer';
import { Icon } from './icons';
import { IconButton } from './primitives';

type Placement = 'draw' | 'field' | 'invisible';
type Picture = 'none' | 'draw' | 'type';
const PREVIEW_WIDTH = 300;
const TSA_KEY = 'zood.sign.tsa';

function readTsa(): string {
  try {
    return localStorage.getItem(TSA_KEY) || DEFAULT_TSAS[0]!;
  } catch {
    return DEFAULT_TSAS[0]!;
  }
}

function errorText(e: unknown): { code: string; message: string } {
  if (e instanceof EngineError) return { code: e.code, message: e.message };
  return { code: '', message: e instanceof Error ? e.message : String(e) };
}

export function SignPanel({ doc, api, onClose }: { doc: OpenDocument; api: ViewerApi | null; onClose: () => void }) {
  const app = useApp();
  const { t, state } = app;
  const locale = state.locale;
  const network = app.host.signing?.network;
  const ids = { pw: useId(), name: useId(), reason: useId(), location: useId(), page: useId(), tsa: useId(), typed: useId() };

  const [p12, setP12] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [password, setPassword] = useState('');
  const [cert, setCert] = useState<CertSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targets, setTargets] = useState<{ fields: SignatureField[]; pages: PageInfo[] } | null>(null);
  const [placement, setPlacement] = useState<Placement>('draw');
  const [page, setPage] = useState(1);
  const [rect, setRect] = useState<PreviewRect | null>(null);
  const [field, setField] = useState('');
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [location, setLocation] = useState('');
  const [showDate, setShowDate] = useState(true);
  const [picture, setPicture] = useState<Picture>('none');
  const [typed, setTyped] = useState('');
  const [kind, setKind] = useState<'approval' | 'certify'>('approval');
  const [certP, setCertP] = useState<1 | 2 | 3>(2);
  const [lock, setLock] = useState<'none' | 'all'>('none');
  const [level, setLevel] = useState<SignLevel>('B-B');
  const [tsa, setTsa] = useState(readTsa);
  const [busy, setBusy] = useState<SignStep | 'unlock' | null>(null);
  const pad = useRef<HTMLCanvasElement | null>(null);

  // Fields and page geometry of the current bytes.
  useEffect(() => {
    let alive = true;
    signingTargets(app.engine(), doc.bytes)
      .then((r) => alive && setTargets(r))
      .catch(() => alive && setTargets({ fields: [], pages: [] }));
    return () => {
      alive = false;
    };
  }, [app, doc.bytes]);

  // Forget the key file and password when the panel goes away.
  useEffect(
    () => () => {
      setPassword('');
      setP12(null);
    },
    [],
  );

  const emptyFields = useMemo(() => (targets?.fields ?? []).filter((f) => !f.signed && f.kind !== 'DocTimeStamp'), [targets]);
  const alreadySigned = (targets?.fields ?? []).some((f) => f.signed);
  const total = doc.pageCount || api?.pageCount() || 1;

  const chooseP12 = async () => {
    try {
      const [f] = await app.host.openFiles({ multiple: false, accept: ['.p12', '.pfx', 'application/x-pkcs12'] });
      if (!f) return;
      setP12({ name: f.name, bytes: f.bytes });
      setCert(null);
      setError(null);
    } catch (e) {
      setError(errorText(e).message);
    }
  };

  const unlock = async () => {
    if (!p12) return;
    setBusy('unlock');
    setError(null);
    try {
      const summary = await inspectP12(app.engine(), p12.bytes, password);
      setCert(summary);
      setName((n) => n || summary.signer.name);
    } catch (e) {
      const { code, message } = errorText(e);
      setCert(null);
      setError(code === 'wrong_certificate_password' ? t('sign.error.password') : t('sign.error.p12', { reason: message }));
    } finally {
      setBusy(null);
    }
  };

  const pictureRgba = (): { width: number; height: number; rgba: Uint8Array } | undefined => {
    if (placement === 'invisible' || picture === 'none') return undefined;
    const c = pad.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return undefined;
    if (picture === 'type') {
      ctx.clearRect(0, 0, c.width, c.height);
      if (!typed.trim()) return undefined;
      ctx.fillStyle = '#12306b';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.direction = /[؀-ۿ]/.test(typed) ? 'rtl' : 'ltr';
      ctx.font = `italic 44px ${getComputedStyle(document.documentElement).getPropertyValue('--font-ui') || 'serif'}`;
      ctx.fillText(typed.trim(), c.width / 2, c.height / 2, c.width - 16);
    }
    const img = ctx.getImageData(0, 0, c.width, c.height);
    if (!img.data.some((v, i) => i % 4 === 3 && v > 0)) return undefined;
    return { width: img.width, height: img.height, rgba: new Uint8Array(img.data.buffer.slice(0)) };
  };

  const pageInfo = targets?.pages[page - 1];
  const tsaOk = /^https?:\/\/[^\s/@]+/i.test(tsa.trim());
  const ready =
    !!cert?.canSign &&
    !!p12 &&
    (placement === 'invisible' || (placement === 'draw' && !!rect && !!pageInfo) || (placement === 'field' && !!field)) &&
    (level === 'B-B' || (!!network && tsaOk));

  const sign = async () => {
    if (!ready || !p12 || busy) return;
    setBusy('signing');
    setError(null);
    try {
      const engine = app.engine();
      // Unsaved viewer edits are appended first (as a save would), so the signature covers them.
      let base = doc.bytes;
      if (doc.edited && !doc.warraqOwnsDocument) {
        const v = app.viewer(doc.id);
        if (v) base = (await rebaseOnOriginal(engine, doc.originalBytes, await v.exportBytes())).bytes;
      }
      const visible = placement !== 'invisible';
      const now = new Date();
      const lines = visible ? appearanceLines(t, locale, { name: name || cert!.signer.name, reason, location, date: now, showDate }) : undefined;
      const result = await signPdf(
        engine,
        base,
        {
          p12: p12.bytes,
          password,
          page: placement === 'draw' ? page - 1 : 0,
          rect: placement === 'draw' && rect && pageInfo ? previewRectToPdf(rect, pageInfo, pageInfo.rotation) : undefined,
          field: placement === 'field' ? field : undefined,
          name,
          reason,
          location,
          lines,
          image: visible ? pictureRgba() : undefined,
          level,
          certify: kind === 'certify' ? certP : undefined,
          lock: lock === 'all' ? { action: 'All', fields: [] } : undefined,
          time: Math.floor(now.getTime() / 1000),
        },
        { network, tsaUrl: tsa.trim(), onStep: (s) => setBusy(s) },
      );
      // The key file and its password are not kept after use.
      setPassword('');
      setP12(null);
      setCert(null);
      if (level !== 'B-B') {
        try {
          localStorage.setItem(TSA_KEY, tsa.trim());
        } catch {
          /* private mode */
        }
      }
      if (result.revocationFailures.length > 0) app.toast(t('sign.ltvPartial', { names: result.revocationFailures.join('، ') }), 'error');
      app.toast(t('sign.done', { name: result.signer }), 'success');
      onClose();
      const saved = await app.saveDocument(doc.id, { bytes: result.bytes });
      if (!saved) app.dispatch({ type: 'CORE_REPLACED_BYTES', id: doc.id, bytes: result.bytes });
    } catch (e) {
      const { code, message } = errorText(e);
      setError(code === 'wrong_certificate_password' ? t('sign.error.password') : t('sign.error.failed', { reason: message }));
    } finally {
      setBusy(null);
    }
  };

  const stepLabel = busy && busy !== 'unlock' ? t(`sign.step.${busy}`) : null;

  return (
    <aside className="compare-panel sign-panel glass" aria-label={t('sign.title')} data-testid="sign-panel">
      <header className="compare-head">
        <h2 className="panel-title">{t('sign.title')}</h2>
        <IconButton icon="close" label={t('common.close')} onClick={onClose} size={16} />
      </header>
      <div className="compare-scroll">
        {/* 1. Certificate */}
        <section className="sign-section">
          <h3 className="compare-sub">{t('sign.cert.title')}</h3>
          <button type="button" className={`btn${p12 ? '' : ' btn-primary'}`} onClick={() => void chooseP12()} data-testid="sign-choose-p12">
            <Icon name="certificate" size={16} />
            {p12 ? t('sign.cert.another') : t('sign.cert.choose')}
          </button>
          {p12 && (
            <p className="fineprint">
              <bdi data-testid="sign-p12-name">{p12.name}</bdi>
            </p>
          )}
          {p12 && !cert && (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void unlock();
              }}
            >
              <label htmlFor={ids.pw} className="visually-hidden">
                {t('sign.cert.password')}
              </label>
              <input
                id={ids.pw}
                type="password"
                className="text-input"
                autoComplete="off"
                placeholder={t('sign.cert.password')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="sign-password"
              />
              <button type="submit" className="btn" disabled={busy === 'unlock'} data-testid="sign-unlock">
                {busy === 'unlock' && <span className="spinner spinner-sm" aria-hidden="true" />}
                {t('sign.cert.unlock')}
              </button>
            </form>
          )}
          {p12 && !cert && <p className="fineprint">{t('sign.cert.passwordNote')}</p>}
          {error && (
            <p className="field-error" role="alert" data-testid="sign-error">
              {error}
            </p>
          )}
          {cert && <CertCard cert={cert} />}
        </section>

        {cert && (
          <>
            {/* 2. Placement */}
            <section className="sign-section">
              <h3 className="compare-sub">{t('sign.place.title')}</h3>
              <div className="segmented" role="radiogroup" aria-label={t('sign.place.title')}>
                {(['draw', ...(emptyFields.length > 0 ? ['field'] : []), 'invisible'] as Placement[]).map((p) => (
                  <button key={p} type="button" role="radio" aria-checked={placement === p} className={placement === p ? 'on' : ''} onClick={() => setPlacement(p)} data-placement={p}>
                    {t(`sign.place.${p}`)}
                  </button>
                ))}
              </div>
              {placement === 'draw' && (
                <>
                  <label className="sign-row" htmlFor={ids.page}>
                    <span>{t('sign.place.page')}</span>
                    <select
                      id={ids.page}
                      className="text-input"
                      value={page}
                      onChange={(e) => {
                        setPage(Number(e.target.value));
                        setRect(null);
                      }}
                    >
                      {Array.from({ length: total }, (_, i) => (
                        <option key={i} value={i + 1}>
                          {formatNumber(i + 1, locale)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="fineprint">{t('sign.place.drawHint')}</p>
                  <DrawOnPage api={api} page={page - 1} rect={rect} onRect={setRect} />
                </>
              )}
              {placement === 'field' && (
                <select className="text-input" value={field} onChange={(e) => setField(e.target.value)} aria-label={t('sign.place.field')} data-testid="sign-field">
                  <option value="">{t('sign.place.pickField')}</option>
                  {emptyFields.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.name}
                      {f.page != null ? ` · ${t('compare.pageShort', { page: f.page + 1 })}` : ''}
                    </option>
                  ))}
                </select>
              )}
              {placement === 'invisible' && <p className="fineprint">{t('sign.place.invisibleNote')}</p>}
            </section>

            {/* 3. Appearance */}
            {placement !== 'invisible' && (
              <section className="sign-section">
                <h3 className="compare-sub">{t('sign.ap.title')}</h3>
                <label className="sign-field" htmlFor={ids.name}>
                  <span>{t('sign.ap.name')}</span>
                  <input id={ids.name} className="text-input" dir="auto" value={name} onChange={(e) => setName(e.target.value)} data-testid="sign-name" />
                </label>
                <label className="check">
                  <input type="checkbox" checked={showDate} onChange={(e) => setShowDate(e.target.checked)} />
                  <span>{t('sign.ap.showDate')}</span>
                </label>
                <div className="segmented" role="radiogroup" aria-label={t('sign.ap.picture')}>
                  {(['none', 'draw', 'type'] as Picture[]).map((p) => (
                    <button key={p} type="button" role="radio" aria-checked={picture === p} className={picture === p ? 'on' : ''} onClick={() => setPicture(p)} data-picture={p}>
                      {t(`sign.ap.picture.${p}`)}
                    </button>
                  ))}
                </div>
                {picture === 'type' && (
                  <input id={ids.typed} className="text-input" dir="auto" aria-label={t('sign.ap.typed')} placeholder={t('sign.ap.typed')} value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="sign-typed" />
                )}
                {picture !== 'none' && <SignaturePad key={picture} canvasRef={pad} drawable={picture === 'draw'} />}
              </section>
            )}
            <section className="sign-section">
              <label className="sign-field" htmlFor={ids.reason}>
                <span>{t('sign.ap.reasonLabel')}</span>
                <input id={ids.reason} className="text-input" dir="auto" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="sign-reason" />
              </label>
              <label className="sign-field" htmlFor={ids.location}>
                <span>{t('sign.ap.locationLabel')}</span>
                <input id={ids.location} className="text-input" dir="auto" value={location} onChange={(e) => setLocation(e.target.value)} data-testid="sign-location" />
              </label>
            </section>

            {/* 4. Type, locks, level */}
            <section className="sign-section">
              <h3 className="compare-sub">{t('sign.kind.title')}</h3>
              <div className="segmented" role="radiogroup" aria-label={t('sign.kind.title')}>
                {(['approval', ...(alreadySigned ? [] : ['certify'])] as ('approval' | 'certify')[]).map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)} data-kind={k}>
                    {t(`sign.kind.${k}`)}
                  </button>
                ))}
              </div>
              {kind === 'certify' && (
                <fieldset className="field">
                  <legend className="visually-hidden">{t('sign.kind.allowed')}</legend>
                  {([1, 2, 3] as const).map((p) => (
                    <label key={p} className="check">
                      <input type="radio" name={`${ids.name}-p`} checked={certP === p} onChange={() => setCertP(p)} data-certify={p} />
                      <span>{t(`sign.kind.p${p}`)}</span>
                    </label>
                  ))}
                </fieldset>
              )}
              <label className="check">
                <input type="checkbox" checked={lock === 'all'} onChange={(e) => setLock(e.target.checked ? 'all' : 'none')} data-testid="sign-lock" />
                <span>{t('sign.lock.all')}</span>
              </label>
            </section>

            <section className="sign-section">
              <h3 className="compare-sub">{t('sign.level.title')}</h3>
              <div className="segmented" role="radiogroup" aria-label={t('sign.level.title')}>
                {(['B-B', ...(network ? ['B-T', 'B-LT', 'B-LTA'] : [])] as SignLevel[]).map((l) => (
                  <button key={l} type="button" role="radio" aria-checked={level === l} className={level === l ? 'on' : ''} onClick={() => setLevel(l)} data-level={l}>
                    {l}
                  </button>
                ))}
              </div>
              <p className="fineprint">{t(`sign.level.${level}`)}</p>
              {!network && <p className="fineprint">{t('sign.level.desktopOnly')}</p>}
              {network && level !== 'B-B' && (
                <>
                  <label className="sign-field" htmlFor={ids.tsa}>
                    <span>{t('sign.tsa.label')}</span>
                    <input id={ids.tsa} className="text-input" dir="ltr" list={`${ids.tsa}-list`} value={tsa} onChange={(e) => setTsa(e.target.value)} />
                    <datalist id={`${ids.tsa}-list`}>
                      {DEFAULT_TSAS.map((u) => (
                        <option key={u} value={u} />
                      ))}
                    </datalist>
                  </label>
                  {!tsaOk && <p className="field-error">{t('sign.tsa.invalid')}</p>}
                  <p className="fineprint">{t(level === 'B-T' ? 'sign.tsa.note' : 'sign.tsa.noteLtv')}</p>
                </>
              )}
            </section>

            {!cert.canSign && <p className="field-error">{t('sign.cert.cannotSign')}</p>}
            <button type="button" className="btn btn-primary" disabled={!ready || !!busy} onClick={() => void sign()} data-testid="sign-run">
              {busy && busy !== 'unlock' && <span className="spinner spinner-sm" aria-hidden="true" />}
              <Icon name="sign" size={16} />
              {stepLabel ?? t('sign.run')}
            </button>
            <p className="fineprint">{t('sign.incremental')}</p>
          </>
        )}
      </div>
    </aside>
  );
}

function CertCard({ cert }: { cert: CertSummary }) {
  const { t, state } = useApp();
  const s = cert.signer;
  return (
    <dl className="props cert-card" data-testid="sign-cert">
      <dt>{t('sign.cert.subject')}</dt>
      <dd>
        <bdi data-testid="sign-cert-name">{s.name}</bdi>
        {s.email && (
          <>
            {' · '}
            <bdi>{s.email}</bdi>
          </>
        )}
      </dd>
      <dt>{t('sign.cert.issuer')}</dt>
      <dd>
        <bdi>{cert.chain[0] ?? s.issuer}</bdi>
      </dd>
      <dt>{t('sign.cert.validity')}</dt>
      <dd>{t('sign.cert.validRange', { from: formatDay(s.notBefore, state.locale), to: formatDay(s.notAfter, state.locale) })}</dd>
      <dt>{t('sign.cert.key')}</dt>
      <dd dir="ltr">{s.keyAlgorithm}</dd>
      {!cert.validNow && (
        <dd className="field-error cert-warn" data-testid="sign-cert-expired">
          {t('sign.cert.expired')}
        </dd>
      )}
      {!cert.eku.accepted && (
        <dd className="field-error cert-warn" data-testid="sign-cert-eku">
          {t('sign.cert.eku')} <bdi dir="ltr">({cert.eku.detail})</bdi>
        </dd>
      )}
    </dl>
  );
}

/** The page as a picture; drag to draw the signature box (fractions of the picture). */
function DrawOnPage({ api, page, rect, onRect }: { api: ViewerApi | null; page: number; rect: PreviewRect | null; onRect: (r: PreviewRect | null) => void }) {
  const { t } = useApp();
  const [url, setUrl] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<PreviewRect | null>(null);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    let made: string | null = null;
    api
      .renderPage(page, PREVIEW_WIDTH * 2)
      .then((b) => {
        if (!alive) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [api, page]);
  const at = (e: ReactPointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const shown = draft ?? rect;
  return (
    // Page coordinates are physical (left-to-right) whatever the interface direction.
    <div
      ref={box}
      className="sign-page"
      dir="ltr"
      data-testid="sign-page-preview"
      aria-label={t('sign.place.drawHint')}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        start.current = at(e);
        setDraft(null);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const p = at(e);
        setDraft({ x0: start.current.x, y0: start.current.y, x1: p.x, y1: p.y });
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        const p = at(e);
        const r = { x0: start.current.x, y0: start.current.y, x1: p.x, y1: p.y };
        start.current = null;
        setDraft(null);
        onRect(Math.abs(r.x1 - r.x0) > 0.03 && Math.abs(r.y1 - r.y0) > 0.015 ? r : null);
      }}
    >
      {url ? <img src={url} alt="" draggable={false} /> : <span className="page-skeleton" />}
      {shown && (
        <span
          className="sign-rect"
          data-testid="sign-rect"
          style={{
            insetInlineStart: `${Math.min(shown.x0, shown.x1) * 100}%`,
            insetBlockStart: `${Math.min(shown.y0, shown.y1) * 100}%`,
            inlineSize: `${Math.abs(shown.x1 - shown.x0) * 100}%`,
            blockSize: `${Math.abs(shown.y1 - shown.y0) * 100}%`,
          }}
        />
      )}
    </div>
  );
}

/** Canvas for a hand-drawn signature (or where a typed one is rendered). */
function SignaturePad({ canvasRef, drawable }: { canvasRef: React.MutableRefObject<HTMLCanvasElement | null>; drawable: boolean }) {
  const { t } = useApp();
  const last = useRef<{ x: number; y: number } | null>(null);
  const pos = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };
  return (
    <div className="sign-pad-wrap">
      <canvas
        ref={canvasRef}
        className="sign-pad"
        width={480}
        height={160}
        dir="ltr"
        hidden={!drawable}
        aria-label={t('sign.ap.drawHere')}
        data-testid="sign-pad"
        onPointerDown={(e) => {
          if (!drawable) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          last.current = pos(e);
        }}
        onPointerMove={(e) => {
          const ctx = e.currentTarget.getContext('2d');
          if (!last.current || !ctx) return;
          const p = pos(e);
          ctx.strokeStyle = '#12306b';
          ctx.lineWidth = 4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(last.current.x, last.current.y);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          last.current = p;
        }}
        onPointerUp={() => {
          last.current = null;
        }}
      />
      {drawable && (
        <button
          type="button"
          className="btn btn-small"
          onClick={() => {
            const c = canvasRef.current;
            c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
          }}
        >
          {t('sign.ap.clear')}
        </button>
      )}
    </div>
  );
}
