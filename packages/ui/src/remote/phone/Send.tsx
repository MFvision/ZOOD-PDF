import { useCallback, useEffect, useRef, useState } from 'react';
import { buzz } from './buzz';
import { ArrowUp, ArrowUpFromLine, Check, ClipboardCopy, ClipboardPaste, Download, File as FileIcon, FileText, ImagePlus, X } from 'lucide-react';
import { MAX_STREAM_BYTES } from '../protocol';
import type { RemoteLink } from './link';
import { inApp, pasteFromPhone } from './native';
import type { PcClip, Received } from './session';
import type { Progress, SendResult } from './streams';
import { ps } from './strings';
import '../light.css';

type Send = RemoteLink['send'];
type SendFile = (file: File, onProgress: (progress: Progress) => void) => Promise<SendResult>;

/** How far up, in pixels, a card must be flicked to go. */
const FLICK_DISTANCE = 90;
/** Or how fast, in pixels a millisecond, over a shorter way. */
const FLICK_SPEED = 0.6;
const FLICK_MIN = 30;

type Status = 'ready' | 'sending' | 'landed' | 'failed' | 'tooBig';

interface Item {
  id: string;
  file: File;
  /** A picture's own preview, made on the phone. */
  preview: string | null;
  status: Status;
  /** How much has gone, 0–1, while sending. */
  done: number;
}

/**
 * The phone's Send tab: files flicked up land on the computer's desktop, in
 * parts and with their progress (the host saves them, `remote/stream.rs`),
 * one clipboard for both, the files the computer sent here, and the open
 * document's own tools below (`Files.tsx`).
 */
export function SendTab({
  send,
  sendFile,
  clip,
  received,
  coming,
  pcName,
  children,
}: {
  send: Send;
  sendFile: SendFile;
  clip: PcClip | null;
  received: readonly Received[];
  coming: { name: string; done: number } | null;
  pcName: string;
  children?: React.ReactNode;
}) {
  const [items, setItems] = useState<Item[]>([]);
  // The full-screen stage the chosen files are swiped up from, one by one.
  const [staging, setStaging] = useState(false);
  const closeStage = useCallback(() => setStaging(false), []);
  const picker = useRef<HTMLInputElement | null>(null);

  // Previews made here are let go with the tab.
  const kept = useRef(items);
  useEffect(() => {
    kept.current = items;
  }, [items]);
  useEffect(
    () => () => {
      for (const item of kept.current) if (item.preview) URL.revokeObjectURL(item.preview);
    },
    [],
  );

  const add = (files: File[]) => {
    const fresh = files.map((file) => ({
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      file,
      preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      status: 'ready' as Status,
      done: 0,
    }));
    setItems((list) => [...fresh, ...list].slice(0, 30));
    if (fresh.length > 0) setStaging(true);
  };

  const change = (id: string, patch: Partial<Item>) => setItems((list) => list.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const go = async (item: Item) => {
    if (item.file.size > MAX_STREAM_BYTES) {
      change(item.id, { status: 'tooBig' });
      return;
    }
    change(item.id, { status: 'sending', done: 0 });
    buzz(12);
    const result = await sendFile(item.file, ({ done }) => change(item.id, { done }));
    change(item.id, { status: result.ok ? 'landed' : result.why === 'tooBig' ? 'tooBig' : 'failed', done: result.ok ? 1 : 0 });
    if (result.ok) buzz([8, 40, 8]);
  };

  const removeItem = (item: Item) => {
    if (item.preview) URL.revokeObjectURL(item.preview);
    setItems((list) => list.filter((i) => i.id !== item.id));
  };

  const waiting = items.filter((i) => i.status === 'ready' || i.status === 'failed');
  const target = pcName || ps('unreachablePc');
  // In the order they were chosen.
  const queue = items.filter((i) => i.status === 'ready').reverse();

  return (
    <div className="phone-send">
      {staging && <LaunchStage queue={queue} pcName={pcName} onFlick={(item) => void go(item)} onClose={closeStage} />}
      <section className="phone-hero">
        <button type="button" className="phone-hero-orb" aria-label={ps('choose')} onClick={() => picker.current?.click()}>
          <ArrowUpFromLine />
        </button>
        <h2>{pcName ? ps('sendTitle', { name: target }) : ps('sendTitlePc')}</h2>
        <p className="phone-muted">{ps('sendBody')}</p>
        <button type="button" className="phone-pick" onClick={() => picker.current?.click()}>
          <ImagePlus />
          <span>{ps('choose')}</span>
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            add(files);
          }}
        />
        {items.length > 0 && (
          <>
            <div className="phone-flick-tray">
              {items.map((item) => (
                <FlickCard key={item.id} item={item} onFlick={() => void go(item)} onRemove={() => removeItem(item)} />
              ))}
            </div>
            {waiting.length > 1 && (
              <button type="button" className="phone-btn" onClick={() => waiting.forEach((item) => void go(item))}>
                <ArrowUp />
                <span>{ps('sendAll')}</span>
              </button>
            )}
          </>
        )}
      </section>

      <ClipboardCard send={send} clip={clip} />

      <section className="phone-card">
        <h2>{ps('received')}</h2>
        {coming && (
          <div className="phone-coming" role="status">
            <span dir="auto">{ps('coming', { name: pcName || ps('unreachablePc') })}</span>
            <span className="phone-coming-name" dir="auto">
              {coming.name}
            </span>
            <span className="phone-bar" style={{ '--done': coming.done } as React.CSSProperties} aria-hidden="true" />
          </div>
        )}
        {received.length === 0 && !coming ? (
          <p className="phone-muted">{ps('receivedNone')}</p>
        ) : (
          <ul className="phone-received">
            {received.map((file) => (
              <li key={file.id}>
                {file.mime.startsWith('image/') ? <img src={file.url} alt="" /> : <span className="phone-received-icon">{file.mime === 'application/pdf' ? <FileText /> : <FileIcon />}</span>}
                <span className="phone-received-name" dir="auto">
                  {file.name}
                  <small className="phone-received-size">{sizeText(file.size)}</small>
                </span>
                <a className="phone-icon-btn" href={file.url} download={file.name} aria-label={ps('save')}>
                  <Download />
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {children && (
        <>
          <h2 className="phone-section-title">{ps('docTitle')}</h2>
          {children}
        </>
      )}
    </div>
  );
}

/**
 * The chosen files, one at a time on the dark full screen: light runs round
 * the screen's edges and waits at the top, toward the computer, and both
 * grow as the file is pulled up; let go and the file is drawn up into the
 * light, a wave goes out from the top as it passes, and the next one comes.
 */
function LaunchStage({ queue, pcName, onFlick, onClose }: { queue: Item[]; pcName: string; onFlick: (item: Item) => void; onClose: () => void }) {
  const item = queue[0];
  const [lift, setLift] = useState(0);
  const [gone, setGone] = useState<Item | null>(null);
  const start = useRef<{ y: number; at: number; id: number } | null>(null);

  useEffect(() => {
    if (!gone) return;
    const timer = window.setTimeout(() => setGone(null), 600);
    return () => window.clearTimeout(timer);
  }, [gone]);
  // All sent, and the last one has flown: the stage goes.
  useEffect(() => {
    if (!item && !gone) onClose();
  }, [item, gone, onClose]);

  const down = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { y: event.clientY, at: performance.now(), id: event.pointerId };
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current || start.current.id !== event.pointerId) return;
    setLift(Math.max(-500, Math.min(30, event.clientY - start.current.y)));
  };
  const up = (event: React.PointerEvent<HTMLDivElement>) => {
    const begun = start.current;
    start.current = null;
    if (!begun || !item) return;
    const dy = event.clientY - begun.y;
    const speed = dy / Math.max(1, performance.now() - begun.at);
    setLift(0);
    if (dy <= -FLICK_DISTANCE || (dy <= -FLICK_MIN && speed <= -FLICK_SPEED)) {
      setGone(item);
      onFlick(item);
    }
  };

  const face = (one: Item) =>
    one.preview ? <img src={one.preview} alt="" draggable={false} /> : <span className="phone-launch-icon">{one.file.type === 'application/pdf' ? <FileText /> : <FileIcon />}</span>;
  const pull = Math.min(1, Math.max(0, -lift / 220));
  return (
    <div className="phone-launch" role="dialog" aria-modal="true" aria-label={ps('flickTitle')} style={{ '--pull': pull } as React.CSSProperties}>
      <div className="flick-edge" style={{ '--edge-power': gone ? 1 : 0.2 + pull * 0.8 } as React.CSSProperties} aria-hidden="true" />
      <div key={gone?.id ?? 'glow'} className={`phone-launch-glow${gone ? ' phone-launch-glow-flash' : ''}`} aria-hidden="true" />
      {gone && <div key={`wave-${gone.id}`} className="flick-wave" style={{ '--wave-x': '50%', '--wave-y': '0px', '--wave-delay': '0.3s' } as React.CSSProperties} aria-hidden="true" />}
      <button type="button" className="phone-launch-close" aria-label={ps('back')} onClick={onClose}>
        <X />
      </button>
      {queue.length > 1 && <p className="phone-launch-count">{ps('launchLeft', { count: queue.length })}</p>}
      {gone && (
        <div key={`gone-${gone.id}`} className="phone-launch-card phone-launch-gone" aria-hidden="true">
          {face(gone)}
        </div>
      )}
      {item && (
        <>
          <div
            key={item.id}
            className="phone-launch-card"
            style={lift ? { transform: `translateY(${lift}px) scale(${1 - pull * 0.12})`, transition: 'none' } : undefined}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={() => {
              start.current = null;
              setLift(0);
            }}
          >
            {face(item)}
          </div>
          <p className="phone-launch-name" dir="auto">
            {item.file.name}
          </p>
          <p className="phone-launch-hint">
            <ArrowUp />
            <span>{pcName ? ps('launchHint', { name: pcName }) : ps('launchHintPc')}</span>
          </p>
        </>
      )}
    </div>
  );
}

/** One picked file: drag it up and let go, and it flies to the computer. */
function FlickCard({ item, onFlick, onRemove }: { item: Item; onFlick: () => void; onRemove: () => void }) {
  const [lift, setLift] = useState(0);
  const start = useRef<{ y: number; at: number; id: number } | null>(null);
  const flown = item.status === 'sending' || item.status === 'landed';
  const pct = Math.round(item.done * 100);

  const down = (event: React.PointerEvent<HTMLDivElement>) => {
    if (flown) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { y: event.clientY, at: performance.now(), id: event.pointerId };
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current || start.current.id !== event.pointerId) return;
    // Up freely, a little down for give.
    setLift(Math.max(-400, Math.min(24, event.clientY - start.current.y)));
  };
  const up = (event: React.PointerEvent<HTMLDivElement>) => {
    const begun = start.current;
    start.current = null;
    if (!begun) return;
    const dy = event.clientY - begun.y;
    const speed = dy / Math.max(1, performance.now() - begun.at);
    if (dy <= -FLICK_DISTANCE || (dy <= -FLICK_MIN && speed <= -FLICK_SPEED)) onFlick();
    setLift(0);
  };

  const icon = item.file.type === 'application/pdf' ? <FileText /> : <FileIcon />;
  return (
    <div
      className={`phone-flick phone-flick-${item.status}`}
      style={lift ? { transform: `translateY(${lift}px) scale(${1 + Math.min(0.08, -lift / 2000)})`, transition: 'none' } : undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        start.current = null;
        setLift(0);
      }}
    >
      <div className="phone-flick-face">{item.preview ? <img src={item.preview} alt="" draggable={false} /> : <span className="phone-flick-icon">{icon}</span>}</div>
      <span className="phone-flick-name" dir="auto">
        {item.file.name}
      </span>
      <span className="phone-flick-state">
        {item.status === 'landed' ? (
          <>
            <Check /> {ps('onDesktop')}
          </>
        ) : item.status === 'failed' ? (
          ps('notLanded')
        ) : item.status === 'tooBig' ? (
          ps('tooBigStream')
        ) : item.status === 'sending' ? (
          item.file.size > 1_000_000 ? ps('percent', { pct }) : ps('sending')
        ) : (
          <>
            <ArrowUp /> {ps('flickHint')}
          </>
        )}
      </span>
      {item.status === 'sending' && <span className="phone-bar phone-flick-bar" style={{ '--done': item.done } as React.CSSProperties} aria-hidden="true" />}
      {!flown && (
        <button type="button" className="phone-flick-remove" aria-label={ps('remove')} onClick={onRemove} onPointerDown={(e) => e.stopPropagation()}>
          <X />
        </button>
      )}
    </div>
  );
}

/** A file's size as people say it: 830 KB, 1.2 MB. */
export function sizeText(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/**
 * Copies `text` on the phone. The page is served over the local network, not
 * HTTPS, so the Clipboard API is not there; a selected field and the copy
 * command are, inside the tap.
 */
function copyText(text: string): boolean {
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  field.setSelectionRange(0, text.length);
  let ok: boolean;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  field.remove();
  return ok;
}

function ClipboardCard({ send, clip }: { send: Send; clip: PcClip | null }) {
  // The clip last copied here: a new one from the computer shows Copy again.
  const [copiedClip, setCopiedClip] = useState<PcClip | null>(null);
  const copied = copiedClip !== null && copiedClip === clip;
  const [draft, setDraft] = useState('');
  const [typing, setTyping] = useState(false);
  const [note, setNote] = useState<'sent' | 'empty' | null>(null);
  const app = inApp();

  const sent = (ok: boolean) => {
    if (!ok) return;
    buzz([8, 40, 8]);
    setNote('sent');
    setDraft('');
    setTyping(false);
  };

  // In the ZOOD app, one tap: the app reads the phone's clipboard. In a
  // browser, a box to paste into (a page on the local network may not read it).
  const paste = async () => {
    setNote(null);
    if (!app) {
      setTyping(true);
      return;
    }
    const pasted = await pasteFromPhone();
    if (!pasted) setNote('empty');
    else sent(send('text' in pasted ? { t: 'clip', text: pasted.text } : { t: 'clip', png: pasted.png }));
  };

  return (
    <section className="phone-card phone-clipboard">
      <h2>{ps('clipTitle')}</h2>
      <div className="phone-clip-halves">
        <div className="phone-clip-half">
          <h3 className="phone-sub">{ps('clipFromPc')}</h3>
          {clip === null ? (
            <p className="phone-muted">{ps('clipNone')}</p>
          ) : 'text' in clip ? (
            <>
              <p className="phone-clip-text" dir="auto">
                {clip.text.length > 600 ? `${clip.text.slice(0, 600)}…` : clip.text}
              </p>
              {clip.onPhone ? (
                <p className="phone-note-line phone-note-ok">{ps('clipAuto')}</p>
              ) : (
                <button type="button" className="phone-btn" onClick={() => setCopiedClip(copyText(clip.text) ? clip : null)}>
                  {copied ? <Check /> : <ClipboardCopy />}
                  <span>{copied ? ps('copied') : ps('copy')}</span>
                </button>
              )}
            </>
          ) : (
            <>
              <img className="phone-clip-picture" src={clip.picture} alt="" />
              <p className="phone-muted">{clip.onPhone ? ps('clipAuto') : ps('clipHold')}</p>
            </>
          )}
        </div>
        <div className="phone-clip-half">
          <h3 className="phone-sub">{ps('clipPaste')}</h3>
          {!typing && (
            <>
              <p className="phone-muted">{ps('clipPasteBody')}</p>
              <button type="button" className="phone-btn" onClick={() => void paste()}>
                <ClipboardPaste />
                <span>{ps('clipPaste')}</span>
              </button>
            </>
          )}
          {typing && (
            <>
              <textarea
                className="phone-clip-field"
                dir="auto"
                rows={3}
                autoFocus
                placeholder={ps('clipPasteField')}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setNote(null);
                }}
              />
              <button type="button" className="phone-btn" disabled={!draft.trim()} onClick={() => sent(send({ t: 'clip', text: draft }))}>
                <span>{ps('clipSend')}</span>
              </button>
            </>
          )}
        </div>
      </div>
      {note && (
        <p className={`phone-note-line ${note === 'sent' ? 'phone-note-ok' : ''}`} role="status">
          {note === 'sent' ? ps('clipSent') : ps('clipEmpty')}
        </p>
      )}
    </section>
  );
}
