import { useEffect, useRef, useState } from 'react';
import { buzz } from './buzz';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft, Delete, Keyboard, MousePointer2, Play, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from 'lucide-react';
import type { PcControl } from '../protocol';
import { ps } from './strings';

type Send = (message: PcControl) => boolean;

/** How long a touch may last and how far it may move and still be a tap. */
const TAP_MS = 220;
const TAP_SLOP = 8;
/** Held this long without moving, a touch picks up for a drag. */
const HOLD_MS = 420;
/** Pixels of finger per scroll step. */
const SCROLL_STEP = 14;

/** Pointer speed: slow moves stay precise, fast ones cross the screen. */
function accelerate(d: number): number {
  const speed = Math.abs(d);
  return d * (1.6 + Math.min(2.4, speed / 10));
}

/**
 * The PC's trackpad and keyboard, on the phone, one switch between them: the
 * keyboard is the phone's own. The trackpad's surface is a field of
 * dots that light up around the finger. Gestures are the laptop's own: one
 * finger moves, a tap clicks, two fingers scroll, a two-finger tap is a
 * right-click, and a held touch drags.
 */
export function Trackpad({ send, enabled }: { send: Send; enabled: boolean }) {
  const surface = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [typing, setTyping] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  /** What the field held after the last input, to tell what the next one added or removed. */
  const typed = useRef('');

  // The dots: drawn once per size, the glow follows the fingers.
  const fingers = useRef(new Map<number, { x: number; y: number; startX: number; startY: number; at: number }>());
  const glow = useRef<{ x: number; y: number }[]>([]);
  const frame = useRef(0);

  useEffect(() => {
    const element = surface.current;
    const target = canvas.current;
    if (!element || !target) return;
    const draw = () => {
      frame.current = 0;
      const ratio = window.devicePixelRatio || 1;
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (target.width !== Math.round(width * ratio)) target.width = Math.round(width * ratio);
      if (target.height !== Math.round(height * ratio)) target.height = Math.round(height * ratio);
      const context = target.getContext('2d');
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const gap = 18;
      for (let y = gap / 2; y < height; y += gap) {
        for (let x = gap / 2; x < width; x += gap) {
          let near = 0;
          for (const g of glow.current) near = Math.max(near, 1 - Math.hypot(g.x - x, g.y - y) / 110);
          const lit = Math.max(0, near);
          context.fillStyle = lit > 0 ? `rgba(174, 139, 102, ${0.25 + lit * 0.75})` : 'rgba(245, 241, 237, 0.10)';
          context.beginPath();
          context.arc(x, y, 1.6 + lit * 2.4, 0, Math.PI * 2);
          context.fill();
        }
      }
    };
    const request = () => {
      if (!frame.current) frame.current = requestAnimationFrame(draw);
    };
    request();
    const observer = new ResizeObserver(request);
    observer.observe(element);
    (element as HTMLDivElement & { redraw?: () => void }).redraw = request;
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [enabled, typing]);

  const gesture = useRef({ moved: false, two: false, dragging: false, holdTimer: 0, scrollX: 0, scrollY: 0, lastX: 0, lastY: 0 });

  const redraw = () => {
    const element = surface.current as (HTMLDivElement & { redraw?: () => void }) | null;
    glow.current = [...fingers.current.values()].map((f) => ({ x: f.x, y: f.y }));
    element?.redraw?.();
  };

  const local = (event: React.PointerEvent) => {
    const box = surface.current!.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const down = (event: React.PointerEvent<HTMLDivElement>) => {
    surface.current?.setPointerCapture(event.pointerId);
    const { x, y } = local(event);
    fingers.current.set(event.pointerId, { x, y, startX: x, startY: y, at: Date.now() });
    const g = gesture.current;
    if (fingers.current.size === 1) {
      g.moved = false;
      g.two = false;
      g.lastX = x;
      g.lastY = y;
      window.clearTimeout(g.holdTimer);
      g.holdTimer = window.setTimeout(() => {
        if (!g.moved && fingers.current.size === 1) {
          g.dragging = true;
          buzz(20);
          send({ t: 'pc', k: 'press' });
        }
      }, HOLD_MS);
    } else if (fingers.current.size === 2) {
      g.two = true;
      window.clearTimeout(g.holdTimer);
      g.scrollX = 0;
      g.scrollY = 0;
    }
    redraw();
  };

  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const finger = fingers.current.get(event.pointerId);
    if (!finger) return;
    const { x, y } = local(event);
    const dx = x - finger.x;
    const dy = y - finger.y;
    finger.x = x;
    finger.y = y;
    const g = gesture.current;
    if (Math.hypot(x - finger.startX, y - finger.startY) > TAP_SLOP) {
      g.moved = true;
      window.clearTimeout(g.holdTimer);
    }
    if (fingers.current.size === 1 && !g.two) {
      const mx = accelerate(dx);
      const my = accelerate(dy);
      if (Math.abs(mx) >= 0.5 || Math.abs(my) >= 0.5) send({ t: 'pc', k: 'move', dx: Math.round(mx), dy: Math.round(my) });
    } else if (fingers.current.size === 2) {
      // Both fingers move it; half each.
      g.scrollX += dx / 2;
      g.scrollY += dy / 2;
      const stepsY = Math.trunc(g.scrollY / SCROLL_STEP);
      const stepsX = Math.trunc(g.scrollX / SCROLL_STEP);
      if (stepsY !== 0 || stepsX !== 0) {
        g.scrollY -= stepsY * SCROLL_STEP;
        g.scrollX -= stepsX * SCROLL_STEP;
        // Natural scrolling: the page follows the fingers.
        send({ t: 'pc', k: 'scroll', dx: -stepsX, dy: -stepsY });
      }
    }
    redraw();
  };

  const up = (event: React.PointerEvent<HTMLDivElement>) => {
    const finger = fingers.current.get(event.pointerId);
    fingers.current.delete(event.pointerId);
    const g = gesture.current;
    window.clearTimeout(g.holdTimer);
    if (finger && fingers.current.size === 0) {
      const quick = Date.now() - finger.at < TAP_MS;
      if (g.dragging) {
        send({ t: 'pc', k: 'release' });
        g.dragging = false;
      } else if (!g.moved && quick) {
        buzz(6);
        send({ t: 'pc', k: 'click', b: g.two ? 'right' : 'left' });
      }
      g.two = false;
    }
    redraw();
  };

  if (!enabled) return <p className="phone-empty">{ps('pcOff')}</p>;

  const key = (k: Extract<PcControl, { k: 'key' }>['key']) => () => {
    buzz(6);
    send({ t: 'pc', k: 'key', key: k });
  };

  const modes = (
    <div className="phone-modes" role="tablist">
      <button type="button" role="tab" aria-selected={!typing} className={`phone-mode${typing ? '' : ' phone-mode-on'}`} onClick={() => setTyping(false)}>
        <MousePointer2 />
        <span>{ps('modeTrackpad')}</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={typing}
        className={`phone-mode${typing ? ' phone-mode-on' : ''}`}
        onClick={() => {
          setTyping(true);
          // Inside the tap, so the phone opens its own keyboard.
          input.current?.focus();
        }}
      >
        <Keyboard />
        <span>{ps('modeKeyboard')}</span>
      </button>
    </div>
  );

  // The phone's own keyboard: a field kept focused, what changes in it typed on the PC.
  const field = (
    <input
      ref={input}
      className="phone-type"
      dir="auto"
      placeholder={ps('typeHere')}
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      enterKeyHint="send"
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          send({ t: 'pc', k: 'key', key: 'enter' });
          event.currentTarget.value = '';
          typed.current = '';
        } else if (event.key === 'Backspace' && event.currentTarget.value === '') {
          // Nothing left in the field to delete: the PC's character goes.
          send({ t: 'pc', k: 'key', key: 'backspace' });
        }
      }}
      onInput={(event) => {
        // What changed since the last input, sent as keystrokes: this
        // also catches Android's word-at-a-time keyboards and dictation.
        const now = event.currentTarget.value;
        const before = typed.current;
        let same = 0;
        while (same < now.length && same < before.length && now[same] === before[same]) same += 1;
        for (let i = 0; i < Math.min(50, before.length - same); i += 1) send({ t: 'pc', k: 'key', key: 'backspace' });
        const added = now.slice(same);
        if (added) send({ t: 'pc', k: 'text', s: added });
        typed.current = now;
        if (now.length > 200) {
          event.currentTarget.value = '';
          typed.current = '';
        }
      }}
    />
  );

  return (
    <div className="phone-pc">
      {modes}
      {/* One field in one place for both modes, so the tap that switches to the keyboard keeps it focused. */}
      <div className={typing ? 'phone-typing' : 'phone-type-hidden'}>
        {field}
        {typing && (
          <>
            <p className="phone-muted">{ps('typeHint')}</p>
            <div className="phone-type-keys">
              <button type="button" className="phone-icon-btn phone-key-label" onClick={key('tab')}>Tab</button>
              <button type="button" className="phone-icon-btn phone-key-label" onClick={key('escape')}>Esc</button>
              <button type="button" className="phone-icon-btn" aria-label="⌫" onClick={key('backspace')}><Delete /></button>
              <button type="button" className="phone-icon-btn" aria-label="←" onClick={key('left')}><ArrowLeft /></button>
              <button type="button" className="phone-icon-btn" aria-label="↑" onClick={key('up')}><ArrowUp /></button>
              <button type="button" className="phone-icon-btn" aria-label="↓" onClick={key('down')}><ArrowDown /></button>
              <button type="button" className="phone-icon-btn" aria-label="→" onClick={key('right')}><ArrowRight /></button>
              <button type="button" className="phone-icon-btn" aria-label="↵" onClick={key('enter')}><CornerDownLeft /></button>
            </div>
          </>
        )}
      </div>
      {!typing && (
        <>
          <div className="phone-pad" ref={surface} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
            <canvas ref={canvas} aria-hidden="true" />
            <p className="phone-pad-hint">{ps('trackpadHint')}</p>
          </div>
          <div className="phone-clicks">
            <button type="button" className="phone-click" onClick={() => send({ t: 'pc', k: 'click', b: 'left' })}>
              {ps('left')}
            </button>
            <button type="button" className="phone-click" onClick={() => send({ t: 'pc', k: 'click', b: 'right' })}>
              {ps('right')}
            </button>
          </div>
          <div className="phone-keys">
            <button type="button" className="phone-icon-btn" aria-label="←" onClick={key('left')}><ArrowLeft /></button>
            <button type="button" className="phone-icon-btn" aria-label="↑" onClick={key('up')}><ArrowUp /></button>
            <button type="button" className="phone-icon-btn" aria-label="↓" onClick={key('down')}><ArrowDown /></button>
            <button type="button" className="phone-icon-btn" aria-label="→" onClick={key('right')}><ArrowRight /></button>
          </div>
          <div className="phone-media">
            <button type="button" className="phone-icon-btn" aria-label={ps('volDown')} onClick={key('voldown')}><Volume1 /></button>
            <button type="button" className="phone-icon-btn" aria-label={ps('mute')} onClick={key('mute')}><VolumeX /></button>
            <button type="button" className="phone-icon-btn" aria-label={ps('volUp')} onClick={key('volup')}><Volume2 /></button>
            <button type="button" className="phone-icon-btn" aria-label={ps('previous')} onClick={key('prev')}><SkipBack /></button>
            <button type="button" className="phone-icon-btn" aria-label={ps('play')} onClick={key('play')}><Play /></button>
            <button type="button" className="phone-icon-btn" aria-label={ps('next')} onClick={key('next')}><SkipForward /></button>
          </div>
        </>
      )}
    </div>
  );
}
