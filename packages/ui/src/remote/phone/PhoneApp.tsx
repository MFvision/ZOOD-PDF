import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { buzz } from './buzz';
import {
  ChevronLeft,
  ChevronRight,
  Eraser,
  Highlighter,
  Monitor,
  MousePointer2,
  Pause,
  PenLine,
  Play,
  Presentation,
  RotateCcw,
  Save,
  Send,
  Square,
  Zap,
} from 'lucide-react';
import type { InkTool, PagePoint, PcMessage, PhoneMessage, RemoteDocumentState } from '../protocol';
import { Catch } from './Catch';
import { Files } from './Files';
import { Logo } from './Logo';
import { SendTab } from './Send';
import type { RemoteLink } from './link';
import { PhoneSession } from './session';
import { phoneLang, ps } from './strings';
import { Trackpad } from './Trackpad';
import './phone.css';

type Tab = 'present' | 'pc' | 'send';

/** Still connecting after this long: the phone says why it may not reach the PC. */
const UNREACHABLE_AFTER = 10_000;
type Mode = 'laser' | InkTool;

export interface PhoneContext {
  send: (message: Parameters<RemoteLink['send']>[0]) => boolean;
  doc: RemoteDocumentState | null;
  page: number;
  picture: (page: number, width: number) => string | undefined;
  onFile: (handle: ((message: Extract<PcMessage, { t: 'file' }>) => void) | null) => void;
  onDone: (handle: ((message: Extract<PcMessage, { t: 'done' }>) => void) | null) => void;
}

/** Picture widths asked for: one for the stage, one for the strip. */
const STAGE_WIDTH = 900;
const THUMB_WIDTH = 180;

/**
 * The phone remote, as the phone's browser shows it (served by the PC itself,
 * `remote.html`). Three tabs: Present (the page, laser, pen, notes, timer,
 * next and previous), Control (the PC's trackpad, keyboard, shortcuts and
 * media keys, when the PC allows it) and Send (files flicked onto the PC's
 * desktop, the shared clipboard, files from the PC, and this document's own
 * tools: the PDF to and from the phone, a scan, a signature).
 *
 * Once connected, a dropped link does not take the page away: a quiet line
 * at the top says it is reconnecting, and only after a while that the phone
 * may not be on the computer's Wi-Fi.
 */
export function PhoneApp() {
  const [session] = useState(() => new PhoneSession());
  const { link: linkState, pcName, pcControl, pcOs, state, clip, received, catching, coming, joined, changes } = useSyncExternalStore(session.subscribe, session.read, session.read);
  const [tab, setTab] = useState<Tab>('present');
  const { send, picture } = session;
  // Still connecting a while after this wait began: say why it may be.
  const [stuckAt, setStuckAt] = useState(-1);
  useEffect(() => {
    if (linkState !== 'connecting') return;
    const timer = window.setTimeout(() => setStuckAt(changes), UNREACHABLE_AFTER);
    return () => window.clearTimeout(timer);
  }, [linkState, changes]);
  const stuck = linkState === 'connecting' && stuckAt === changes;


  useEffect(() => {
    document.documentElement.lang = phoneLang;
    document.documentElement.dir = phoneLang === 'ar' ? 'rtl' : 'ltr';
    session.link.start();
    return () => session.link.stop();
  }, [session]);

  const unreachable = ps('unreachable', { name: pcName || ps('unreachablePc') });
  if (linkState !== 'open' && !(joined && linkState === 'connecting')) {
    return (
      <main className="phone phone-center">
        <Logo className="phone-brand" />
        {(linkState === 'connecting' || linkState === 'waiting') && <div className="phone-spinner" aria-hidden="true" />}
        <p className="phone-message">{ps(linkState)}</p>
        {linkState === 'connecting' && stuck && (
          <p className="phone-message phone-unreachable" role="status">
            {unreachable}
          </p>
        )}
        {(linkState === 'closed' || linkState === 'refused' || linkState === 'denied') && (
          <button type="button" className="phone-btn" onClick={() => location.reload()}>
            {ps('tryAgain')}
          </button>
        )}
      </main>
    );
  }

  const context: PhoneContext = {
    send,
    doc: state?.doc ?? null,
    page: state?.page ?? 1,
    picture,
    onFile: session.onFile,
    onDone: session.onDone,
  };

  return (
    <main className="phone">
      <header className="phone-top">
        <Logo className="phone-top-logo" />
        <span className={`phone-status${linkState === 'open' ? '' : ' phone-status-away'}`} role="status">
          <span className="phone-live" aria-hidden="true" />
          {linkState !== 'open' ? ps('reconnecting') : pcName ? ps('pcName', { name: pcName }) : ps('connected')}
        </span>
      </header>
      {linkState !== 'open' && stuck && (
        <p className="phone-banner" role="status">
          {unreachable}
        </p>
      )}
      <section className="phone-body">
        {tab === 'present' && <PresentTab context={context} state={state} />}
        {tab === 'pc' && <Trackpad send={send} enabled={pcControl} mac={pcOs === 'macos'} />}
        {tab === 'send' && (
          <SendTab send={send} sendFile={session.sendFile} clip={clip} received={received} coming={coming} pcName={pcName}>
            <Files context={context} />
          </SendTab>
        )}
      </section>
      <nav className="phone-tabs" aria-label="ZOOD">
        <TabButton active={tab === 'present'} icon={<Presentation />} label={ps('tabPresent')} onClick={() => setTab('present')} />
        <TabButton active={tab === 'pc'} icon={<MousePointer2 />} label={ps('tabPc')} onClick={() => setTab('pc')} />
        <TabButton active={tab === 'send'} icon={<Send />} label={ps('tabSend')} onClick={() => setTab('send')} />
      </nav>
      {catching && <Catch file={catching.file} count={catching.count} pcName={pcName} onDone={session.putAway} />}
    </main>
  );
}

function TabButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" className={`phone-tab${active ? ' phone-tab-on' : ''}`} aria-pressed={active} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

/** Where a pointer is on an element, 0–1 from its top-left. */
function pointIn(element: HTMLElement, event: { clientX: number; clientY: number }): PagePoint {
  const box = element.getBoundingClientRect();
  return [Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), Math.min(1, Math.max(0, (event.clientY - box.top) / box.height))];
}

function PresentTab({ context, state }: { context: PhoneContext; state: Extract<PcMessage, { t: 'state' }> | null }) {
  const { send, doc, page, picture } = context;
  const [mode, setMode] = useState<Mode>('laser');
  // The page ink was last drawn on: turning the page on the PC takes the ink with it.
  const [inkPage, setInkPage] = useState<number | null>(null);
  const hasInk = inkPage === page;
  const stage = useRef<HTMLDivElement | null>(null);
  const stroke = useRef<{ id: string; points: PagePoint[] } | null>(null);
  const frame = useRef(0);
  const pending = useRef<PhoneMessage | null>(null);

  // At most one laser or ink message a frame: a finger moves faster than Wi-Fi needs.
  const sendSoon = useCallback(
    (message: PhoneMessage) => {
      pending.current = message;
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        if (pending.current) send(pending.current);
        pending.current = null;
      });
    },
    [send],
  );

  if (!doc || !state) {
    return <p className="phone-empty">{ps('noDocument')}</p>;
  }

  const shape = doc.shapes[page - 1] ?? 0.75;
  const url = picture(page, STAGE_WIDTH);
  const rtl = state.rtl;
  const go = (delta: number) => {
    buzz();
    send({ t: delta > 0 ? 'next' : 'prev' });
  };

  const down = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!stage.current) return;
    stage.current.setPointerCapture(event.pointerId);
    const at = pointIn(stage.current, event);
    if (mode === 'laser') sendSoon({ t: 'laser', at });
    else {
      stroke.current = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, points: [at] };
      setInkPage(page);
      sendSoon({ t: 'ink', id: stroke.current.id, tool: mode, points: stroke.current.points });
    }
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!stage.current || !stage.current.hasPointerCapture(event.pointerId)) return;
    const at = pointIn(stage.current, event);
    if (mode === 'laser') sendSoon({ t: 'laser', at });
    else if (stroke.current && stroke.current.points.length < 4000) {
      stroke.current.points.push(at);
      sendSoon({ t: 'ink', id: stroke.current.id, tool: mode, points: [...stroke.current.points] });
    }
  };
  const up = () => {
    if (mode === 'laser') {
      pending.current = null;
      send({ t: 'laser', at: null });
    } else if (stroke.current) {
      send({ t: 'ink', id: stroke.current.id, tool: mode, points: stroke.current.points });
      stroke.current = null;
    }
  };

  const Next = rtl ? ChevronLeft : ChevronRight;
  const Prev = rtl ? ChevronRight : ChevronLeft;

  return (
    <div className="phone-present">
      <div className="phone-doc">
        <span className="phone-doc-name" dir="auto">
          {doc.name}
        </span>
        <span className="phone-doc-page">{ps('pageOf', { page, total: doc.pages })}</span>
      </div>
      <div
        className={`phone-stage phone-stage-${mode}`}
        ref={stage}
        style={{ aspectRatio: String(shape) }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        {url ? <img src={url} alt="" draggable={false} /> : <div className="phone-stage-wait" />}
      </div>

      <div className="phone-tools" role="toolbar">
        <ToolButton on={mode === 'laser'} icon={<Zap />} label={ps('laser')} onClick={() => setMode('laser')} />
        <ToolButton on={mode === 'pen'} icon={<PenLine />} label={ps('pen')} onClick={() => setMode('pen')} />
        <ToolButton on={mode === 'marker'} icon={<Highlighter />} label={ps('marker')} onClick={() => setMode('marker')} />
        <ToolButton
          icon={<Eraser />}
          label={ps('clear')}
          disabled={!hasInk}
          onClick={() => {
            send({ t: 'inkClear' });
            setInkPage(null);
          }}
        />
        <ToolButton
          icon={<Save />}
          label={ps('keep')}
          disabled={!hasInk}
          onClick={() => {
            send({ t: 'inkKeep' });
            setInkPage(null);
          }}
        />
        <ToolButton on={state.black} icon={<Square />} label={ps('black')} onClick={() => send({ t: 'black', on: !state.black })} />
      </div>

      <div className="phone-nav">
        <button type="button" className="phone-turn" aria-label={ps('previous')} disabled={page <= 1} onClick={() => go(-1)}>
          <Prev />
        </button>
        <button
          type="button"
          className={`phone-present-toggle${state.presenting ? ' phone-present-on' : ''}`}
          onClick={() => {
            buzz(15);
            send({ t: 'present', on: !state.presenting });
          }}
        >
          <Monitor />
          <span>{state.presenting ? ps('presentOff') : ps('presentOn')}</span>
        </button>
        <button type="button" className="phone-turn phone-turn-next" aria-label={ps('next')} disabled={page >= doc.pages} onClick={() => go(1)}>
          <Next />
        </button>
      </div>

      <PageStrip pages={doc.pages} page={page} picture={picture} onGo={(p) => send({ t: 'go', page: p })} />

      <div className="phone-cards">
        <Timer />
        <section className="phone-card">
          <h2>{ps('notes')}</h2>
          {state.notes.length === 0 ? (
            <p className="phone-muted">{ps('noNotes')}</p>
          ) : (
            state.notes.map((note, i) => (
              <p key={i} className="phone-note" dir="auto">
                {note.text}
                {note.author && <span className="phone-muted"> — {note.author}</span>}
              </p>
            ))
          )}
        </section>
      </div>
    </div>
  );
}

function ToolButton({ on, icon, label, disabled, onClick }: { on?: boolean; icon: React.ReactNode; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`phone-tool${on ? ' phone-tool-on' : ''}`} aria-pressed={on} disabled={disabled} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function PageStrip({ pages, page, picture, onGo }: { pages: number; page: number; picture: PhoneContext['picture']; onGo: (page: number) => void }) {
  const strip = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(() => new Set<number>([page - 1, page, page + 1]));

  useEffect(() => {
    const current = strip.current?.querySelector<HTMLElement>(`[data-page="${page}"]`);
    current?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [page]);

  useEffect(() => {
    const root = strip.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((current) => {
          const next = new Set(current);
          for (const entry of entries) if (entry.isIntersecting) next.add(Number((entry.target as HTMLElement).dataset.page));
          return next;
        });
      },
      { root, rootMargin: '0px 200px' },
    );
    root.querySelectorAll('[data-page]').forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [pages]);

  return (
    <div className="phone-strip" ref={strip} aria-label={ps('pages')}>
      {Array.from({ length: Math.min(pages, 2000) }, (_, i) => i + 1).map((p) => {
        const url = visible.has(p) ? picture(p, THUMB_WIDTH) : undefined;
        return (
          <button key={p} type="button" data-page={p} className={`phone-thumb${p === page ? ' phone-thumb-on' : ''}`} onClick={() => onGo(p)}>
            {url ? <img src={url} alt="" /> : <span className="phone-thumb-wait" />}
            <span className="phone-thumb-n">{p}</span>
          </button>
        );
      })}
    </div>
  );
}

function Timer() {
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const started = useRef(0);
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClock(new Date());
      if (running) setElapsed(Date.now() - started.current);
    }, 500);
    return () => window.clearInterval(timer);
  }, [running]);

  const seconds = Math.floor(elapsed / 1000);
  const shown = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <section className="phone-card phone-timer">
      <h2>{ps('timer')}</h2>
      <div className="phone-timer-row">
        <span className="phone-time">{shown}</span>
        <span className="phone-muted phone-clock">{clock.toLocaleTimeString(phoneLang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
        <button
          type="button"
          className="phone-icon-btn"
          aria-label={running ? ps('pause') : ps('start')}
          onClick={() => {
            if (running) setRunning(false);
            else {
              started.current = Date.now() - elapsed;
              setRunning(true);
            }
          }}
        >
          {running ? <Pause /> : <Play />}
        </button>
        <button
          type="button"
          className="phone-icon-btn"
          aria-label={ps('reset')}
          onClick={() => {
            setRunning(false);
            setElapsed(0);
          }}
        >
          <RotateCcw />
        </button>
      </div>
    </section>
  );
}
