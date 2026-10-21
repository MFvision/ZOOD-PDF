import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ClipboardCopy, Download, File as FileIcon, FileText, ImagePlus, X } from 'lucide-react';
import { MAX_FILE_BYTES } from '../protocol';
import type { HostMessage } from '../protocol';
import type { RemoteLink } from './link';
import { bytesToBase64 } from './seal';
import type { PcClip, Received } from './session';
import { ps } from './strings';
import '../light.css';

type Send = RemoteLink['send'];
type Landed = Extract<HostMessage, { t: 'landed' }>;

/** How far up, in pixels, a card must be flicked to go. */
const FLICK_DISTANCE = 90;
/** Or how fast, in pixels a millisecond, over a shorter way. */
const FLICK_SPEED = 0.6;
const FLICK_MIN = 30;

type Status = 'ready' | 'sending' | 'landed' | 'failed';

interface Item {
  id: string;
  file: File;
  /** A picture's own preview, made on the phone. */
  preview: string | null;
  status: Status;
}

/**
 * The phone's Send tab: files flicked up land on the computer's desktop
 * (the host saves them, `remote/transfer.rs`), one clipboard for both, and
 * the files the computer sent here.
 */
export function SendTab({
  send,
  clip,
  received,
  pcName,
  onLanded,
}: {
  send: Send;
  clip: PcClip | null;
  received: readonly Received[];
  pcName: string;
  onLanded: (handle: ((message: Landed) => void) | null) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  // The full-screen stage the chosen files are swiped up from, one by one.
  const [staging, setStaging] = useState(false);
  const closeStage = useCallback(() => setStaging(false), []);
  const picker = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    onLanded((message) => {
      setItems((list) => list.map((item) => (item.id === message.id ? { ...item, status: message.ok ? 'landed' : 'failed' } : item)));
    });
    return () => onLanded(null);
  }, [onLanded]);

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
    }));
    setItems((list) => [...fresh, ...list].slice(0, 30));
    if (fresh.length > 0) setStaging(true);
  };

  const go = async (item: Item) => {
    if (item.file.size > MAX_FILE_BYTES) {
      setItems((list) => list.map((i) => (i.id === item.id ? { ...i, status: 'failed' } : i)));
      return;
    }
    setItems((list) => list.map((i) => (i.id === item.id ? { ...i, status: 'sending' } : i)));
    navigator.vibrate?.(12);
    const data = bytesToBase64(new Uint8Array(await item.file.arrayBuffer()));
    const ok = send({ t: 'drop', id: item.id, name: item.file.name, mime: item.file.type || 'application/octet-stream', data });
    if (!ok) setItems((list) => list.map((i) => (i.id === item.id ? { ...i, status: 'failed' } : i)));
  };

  const removeItem = (item: Item) => {
    if (item.preview) URL.revokeObjectURL(item.preview);
    setItems((list) => list.filter((i) => i.id !== item.id));
  };

  const waiting = items.filter((i) => i.status === 'ready' || i.status === 'failed');
  // In the order they were chosen.
  const queue = items.filter((i) => i.status === 'ready').reverse();

  return (
    <div className="phone-send">
      {staging && <LaunchStage queue={queue} pcName={pcName} onFlick={(item) => void go(item)} onClose={closeStage} />}
      <section className="phone-card">
        <h2>{ps('flickTitle')}</h2>
        <p className="phone-muted">{ps('flickBody')}</p>
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
        {received.length === 0 ? (
          <p className="phone-muted">{ps('receivedNone')}</p>
        ) : (
          <ul className="phone-received">
            {received.map((file) => (
              <li key={file.id}>
                {file.mime.startsWith('image/') ? <img src={file.url} alt="" /> : <span className="phone-received-icon">{file.mime === 'application/pdf' ? <FileText /> : <FileIcon />}</span>}
                <span className="phone-received-name" dir="auto">
                  {file.name}
                </span>
                <a className="phone-icon-btn" href={file.url} download={file.name} aria-label={ps('save')}>
                  <Download />
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
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
        ) : item.status === 'sending' ? (
          ps('sending')
        ) : (
          <>
            <ArrowUp /> {ps('flickHint')}
          </>
        )}
      </span>
      {!flown && (
        <button type="button" className="phone-flick-remove" aria-label={ps('remove')} onClick={onRemove} onPointerDown={(e) => e.stopPropagation()}>
          <X />
        </button>
      )}
    </div>
  );
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
  const [sent, setSent] = useState(false);

  return (
    <section className="phone-card">
      <h2>{ps('clipTitle')}</h2>
      <h3 className="phone-sub">{ps('clipFromPc')}</h3>
      {clip === null ? (
        <p className="phone-muted">{ps('clipNone')}</p>
      ) : 'text' in clip ? (
        <div className="phone-clip">
          <p className="phone-clip-text" dir="auto">
            {clip.text.length > 600 ? `${clip.text.slice(0, 600)}…` : clip.text}
          </p>
          <button type="button" className="phone-btn" onClick={() => setCopiedClip(copyText(clip.text) ? clip : null)}>
            {copied ? <Check /> : <ClipboardCopy />}
            <span>{copied ? ps('copied') : ps('copy')}</span>
          </button>
        </div>
      ) : (
        <div className="phone-clip">
          <img className="phone-clip-picture" src={clip.picture} alt="" />
          <p className="phone-muted">{ps('clipHold')}</p>
        </div>
      )}
      <h3 className="phone-sub">{ps('clipToPc')}</h3>
      <textarea
        className="phone-clip-field"
        dir="auto"
        rows={3}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setSent(false);
        }}
      />
      <button
        type="button"
        className="phone-btn"
        disabled={!draft.trim()}
        onClick={() => {
          if (send({ t: 'clip', text: draft })) {
            setSent(true);
            setDraft('');
          }
        }}
      >
        <span>{ps('clipSend')}</span>
      </button>
      {sent && (
        <p className="phone-note-line phone-note-ok" role="status">
          {ps('clipSent')}
        </p>
      )}
    </section>
  );
}
