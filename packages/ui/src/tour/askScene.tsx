import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Check, FolderOpen, Keyboard, Mic, MousePointerClick, PenLine, Reply, Send, Settings, Share2, Sparkles, Square, Volume2 } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useReducedMotion } from '../components/useReducedMotion';
import { machineMemoryGiB } from '../ai/device/useDeviceModel';
import { invokeHost } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { BETWEEN_MS, freshTapper, ignoredWith, isHoldKeys, stepTap, tapKeyCode } from '../ask/keys';
import type { Tap } from '../ask/keys';
import { AskSetup } from '../ask/AskSetup';
import { GlowEdges } from '../ask/Glow';
import { askAvailable, askReadiness, onMac, readAskPreferences, tapKeyLabel, voiceAvailable } from '../ask/settings';
import type { AskReadiness } from '../ask/settings';
import type { SectionId } from '../settings/SettingsWindow';
import { isolate } from '../signatures/model';
import { takeStartPart } from './openAt';
import { Glow } from './scenes';

/**
 * Ask ZOOD's chapter: the one key and its moves, practised for real. The
 * page reads its own key events the way the host reads the keyboard
 * (`ask/keys.ts`), and the host is paused meanwhile — so tapping here never
 * opens the island, and the keys to hold reach the page. One tap makes a
 * pretend screen glow and the island listen until the next tap (nothing is
 * recorded); a pretend reply box fills with a draft on a double tap. When
 * one tap types instead, a typing box opens on it, and holding the keys
 * shows the island listening. Show me, Explain this and Do it for me are
 * played on a pretend ZOOD window: the pointer flies to each step. Until
 * Ask ZOOD is set up, its one-button setup is here too.
 */

type Part = 'speak' | 'twice' | 'once' | 'hold' | 'guide';

/** Shorter than this is not a question, as the host has it. */
const SHORTEST_HOLD_MS = 400;
const WRITING_MS = 1100;

const PART_LABEL: Record<Part, TKey> = { speak: 'tour.ask.tabSpeak', twice: 'tour.ask.tabTwice', once: 'tour.ask.tabOnce', hold: 'tour.ask.tabHold', guide: 'tour.ask.tabGuide' };

export function AskScene({ onPractised, onSettings }: { onPractised: () => void; onSettings: (section: SectionId) => void }) {
  const { t, lang } = useI18n();
  const [prefs] = useState(readAskPreferences);
  const mac = onMac();
  // Key names stay whole inside an Arabic sentence.
  const tap = isolate(tapKeyLabel(prefs.tapKey, mac, lang === 'ar' ? 'ar' : 'en'));
  const voice = voiceAvailable();
  // One tap listens when it can hear; else, unless switched off, it types.
  const speaks = prefs.taps && voice && prefs.oneTap === 'speak';
  const types = prefs.taps && !speaks && prefs.oneTap !== 'off';
  const parts: Part[] = [...(speaks ? (['speak'] as const) : []), ...(prefs.taps ? (['twice'] as const) : []), ...(types ? (['once'] as const) : []), ...(voice && !speaks ? (['hold'] as const) : []), 'guide'];
  const [part, setPart] = useState<Part>(() => {
    const asked = takeStartPart();
    return parts.find((one) => one === asked) ?? parts[0] ?? 'twice';
  });
  const [down, setDown] = useState<ReadonlySet<string>>(new Set());
  // Each try starts its part again: a counter, so the same move twice replays.
  const [tries, setTries] = useState<Record<Part, number>>({ speak: 0, twice: 0, once: 0, hold: 0, guide: 0 });
  /** The pretend listening after one tap: it ends at the next tap. */
  const [speaking, setSpeaking] = useState<'idle' | 'listening' | 'done'>('idle');
  const listening = useRef(false);
  const [holding, setHolding] = useState(false);
  const [held, setHeld] = useState<'short' | 'long' | null>(null);
  const [ready, setReady] = useState<AskReadiness | null>(null);
  const practised = useRef(onPractised);
  useEffect(() => {
    practised.current = onPractised;
  });

  // A move made, by its keys or by "Show me": its part plays again.
  const tried = (which: Part) => {
    setPart(which);
    setTries((before) => ({ ...before, [which]: before[which] + 1 }));
    practised.current();
  };

  // While the chapter is on screen the keys are the tour's.
  useEffect(() => {
    if (!askAvailable()) return;
    void invokeHost('ask_pause', { paused: true }).catch(() => undefined);
    return () => void invokeHost('ask_pause', { paused: false }).catch(() => undefined);
  }, []);

  useEffect(() => {
    let live = true;
    void machineMemoryGiB()
      .then((memory) => askReadiness(prefs, memory))
      .then((now) => live && setReady(now));
    return () => {
      live = false;
    };
  }, [prefs]);

  useEffect(() => {
    const code = tapKeyCode(prefs.tapKey, mac);
    const ignored = ignoredWith(prefs.tapKey, mac);
    const pressed = new Set<string>();
    const tapper = freshTapper();
    let timer = 0;
    let holdStart: number | null = null;
    const tried = (which: Part) => {
      setPart(which);
      setTries((before) => ({ ...before, [which]: before[which] + 1 }));
      practised.current();
    };
    const show = () => setDown(new Set(pressed));
    const listen = (on: boolean) => {
      listening.current = on;
      setPart('speak');
      setSpeaking(on ? 'listening' : 'done');
      if (!on) practised.current();
    };
    const read = () => {
      const other = [...pressed].some((one) => one !== code && !ignored.includes(one));
      const result: Tap | null = prefs.taps ? stepTap(tapper, performance.now(), pressed.has(code), other) : null;
      // While it listens, any tap is the one that ends it.
      if (result && listening.current) listen(false);
      else if (result === 'twice') tried('twice');
      else if (result === 'once' && speaks) listen(true);
      else if (result === 'once' && types) tried('once');
    };
    const endHold = () => {
      if (holdStart === null) return;
      const long = performance.now() - holdStart >= SHORTEST_HOLD_MS;
      holdStart = null;
      setHolding(false);
      setHeld(long ? 'long' : 'short');
      if (long) tried('hold');
      else setPart('hold');
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (voiceAvailable() && isHoldKeys(event, prefs.shortcut, mac)) {
        // Space would press the button that has the focus.
        event.preventDefault();
        if (holdStart === null) {
          holdStart = performance.now();
          setHolding(true);
          setHeld(null);
          setPart('hold');
        }
      }
      if (event.repeat) return;
      pressed.add(event.code);
      show();
      read();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (holdStart !== null) {
        event.preventDefault();
        endHold();
      }
      pressed.delete(event.code);
      // With ⌘ down a Mac sends no key-up for the other keys.
      if (mac && event.key === 'Meta') pressed.clear();
      show();
      read();
      window.clearTimeout(timer);
      timer = window.setTimeout(read, BETWEEN_MS + 40);
    };
    const onPointerDown = () => {
      pressed.add('pointer');
      read();
    };
    const onPointerUp = () => {
      pressed.delete('pointer');
      read();
    };
    const onBlur = () => {
      pressed.clear();
      Object.assign(tapper, freshTapper());
      endHold();
      show();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [prefs, mac, speaks, types]);

  const tapDown = down.has(tapKeyCode(prefs.tapKey, mac));

  return (
    <div className="tour-scene">
      <div className="ask-where">
        <BottomRow mac={mac} tapKey={prefs.tapKey} lit={tapDown} />
        <p className="tour-note">{t('tour.ask.where', { tap })}</p>
      </div>
      {parts.length > 1 && (
        <div className="tour-choice" role="tablist" aria-label={t('tour.ch.ask')}>
          {parts.map((one) => (
            <button key={one} type="button" role="tab" aria-selected={part === one} className="tour-choice-item" onClick={() => setPart(one)}>
              {t(PART_LABEL[one])}
            </button>
          ))}
        </div>
      )}
      <div key={part} className="tour-part">
        {part === 'speak' && (
          <SpeakPractice
            tap={tap}
            lit={tapDown}
            state={speaking}
            onShow={() => {
              const on = speaking !== 'listening';
              listening.current = on;
              setSpeaking(on ? 'listening' : 'done');
              if (!on) practised.current();
            }}
          />
        )}
        {part === 'twice' && <TwicePractice tap={tap} lit={tapDown} run={tries.twice} onShow={() => tried('twice')} />}
        {part === 'once' && <OncePractice tap={tap} lit={tapDown} run={tries.once} onShow={() => tried('once')} />}
        {part === 'guide' && <GuidePractice onTried={() => practised.current()} />}
        {part === 'hold' && <HoldPractice shortcut={prefs.shortcut} mac={mac} down={down} holding={holding} held={held} onShow={() => tried('hold')} />}
      </div>
      {ready && (ready.taps || ready.voice) && (
        <p className="ask-ready is-on" role="status">
          <Icon of={Check} size={14} />
          <span>{t('tour.ask.ready')}</span>
          <button type="button" className="link-btn" onClick={() => onSettings('ai')}>
            {t('tour.ask.openSettings')}
          </button>
        </p>
      )}
      {ready && !(ready.taps || ready.voice) && askAvailable() && prefs.enabled && <AskSetup compact />}
    </div>
  );
}

/** The keyboard's bottom row, with the tap key lit where it is. */
function BottomRow({ mac, tapKey, lit }: { mac: boolean; tapKey: string; lit: boolean }) {
  const { t } = useI18n();
  // Left to right as on the keyboard, whatever the reading direction.
  const keys = mac ? ['fn', '⌃', '⌥', '⌘', 'space', '⌘', '⌥'] : ['Ctrl', '⊞', 'Alt', 'space', 'Alt', '▤', 'Ctrl'];
  const target = tapKey === 'right-alt' ? (mac ? 6 : 4) : tapKey === 'right-shift' ? -1 : mac ? 5 : 6;
  return (
    <div className="kb-row" dir="ltr" aria-hidden="true">
      {tapKey === 'right-shift' && <span className={lit ? 'kb-key kb-shift is-target is-down' : 'kb-key kb-shift is-target'}>⇧ Shift</span>}
      {keys.map((key, index) => (
        <span key={index} className={['kb-key', key === 'space' ? 'kb-space' : '', index === target ? 'is-target' : '', index === target && lit ? 'is-down' : ''].filter(Boolean).join(' ')}>
          {key === 'space' ? '' : key}
          {index === target && <span className="kb-badge">{t('tour.ask.yourKey')}</span>}
        </span>
      ))}
    </div>
  );
}

/** The voice the pretend glow and line move with: a few overlapping waves, still with Reduce Motion. */
function usePretendVoice(on: boolean): number {
  const reduced = useReducedMotion();
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!on || reduced) return;
    const start = performance.now();
    const timer = window.setInterval(() => {
      const at = (performance.now() - start) / 1000;
      const wave = 0.5 + 0.3 * Math.sin(at * 5.1) + 0.2 * Math.sin(at * 11.7 + 1);
      setLevel(Math.max(0, Math.min(1, wave * (0.6 + 0.4 * Math.sin(at * 1.3) ** 2))));
    }, 70);
    return () => window.clearInterval(timer);
  }, [on, reduced]);
  return !on ? 0 : reduced ? 0.5 : level;
}

/** One tap: a pretend screen glows round its edges and the island listens, until the next tap. */
function SpeakPractice({ tap, lit, state, onShow }: { tap: string; lit: boolean; state: 'idle' | 'listening' | 'done'; onShow: () => void }) {
  const { t } = useI18n();
  const on = state === 'listening';
  const level = usePretendVoice(on);
  return (
    <div className="tour-split">
      <div>
        <p className="tour-note">{t('tour.ask.speakHow', { tap })}</p>
        <TryLine text={t(on ? 'tour.ask.speakStop' : 'tour.ask.speakTry', { tap })} keys={[tap]} lit={lit} done={state === 'done'} />
        {state === 'done' ? (
          <p className="ask-done" role="status">
            <Icon of={Check} size={14} />
            {t('tour.ask.speakDone')}
          </p>
        ) : (
          <button type="button" className="link-btn tour-link" onClick={onShow}>
            {t(on ? 'tour.ask.speakStopMe' : 'tour.ask.showMe')}
          </button>
        )}
        <p className="tour-note ask-more">
          <Icon of={Keyboard} size={13} /> {t('tour.ask.speakTypeInstead')}
        </p>
      </div>
      <div className="tour-stage ask-stage ask-glow-stage">
        <GlowEdges level={level} on={on} />
        {on ? (
          <span className="ask-island-mock is-listening ask-listen-mock" role="status">
            <Icon of={Mic} size={13} />
            <span>{t('tour.ask.listening')}</span>
            <span className="ask-wave-mock" aria-hidden="true">
              {[0.6, 1, 0.75, 0.9, 0.5].map((weight, index) => (
                <i key={index} style={{ '--h': (level * weight).toFixed(3) } as CSSProperties} />
              ))}
            </span>
            <Icon of={Square} size={11} />
          </span>
        ) : (
          <span className="ask-waiting" aria-hidden="true">
            <kbd className={lit ? 'keycap is-down' : 'keycap'}>{tap}</kbd>
          </span>
        )}
      </div>
    </div>
  );
}

/** A reply box in a pretend mail window: a double tap writes the draft into it, word by word. */
function TwicePractice({ tap, lit, run, onShow }: { tap: string; lit: boolean; run: number; onShow: () => void }) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  // The try whose draft is written: until then the island says it is writing.
  const [written, setWritten] = useState(0);
  const stage = run === 0 ? 'wait' : reduced || written === run ? 'done' : 'writing';
  useEffect(() => {
    if (run === 0 || reduced) return;
    const timer = window.setTimeout(() => setWritten(run), WRITING_MS);
    return () => window.clearTimeout(timer);
  }, [run, reduced]);
  const words = t('tour.ask.reply').split(' ');
  return (
    <div className="tour-split">
      <div>
        <p className="tour-note">{t('tour.ask.twiceHow', { tap })}</p>
        <TryLine text={t('tour.ask.twiceTry', { tap })} keys={[tap, tap]} lit={lit} done={stage === 'done'} />
        {stage === 'done' ? (
          <p className="ask-done" role="status">
            <Icon of={Check} size={14} />
            {t('tour.ask.twiceDone')}
          </p>
        ) : (
          <button type="button" className="link-btn tour-link" onClick={onShow}>
            {t('tour.ask.showMe')}
          </button>
        )}
      </div>
      <div className="tour-stage ask-stage">
        <Glow />
        <div className="mail-mock" data-stage={stage}>
          <div className="mail-in">
            <span className="mail-avatar">{t('tour.ask.from').slice(0, 1)}</span>
            <span>
              <b>{t('tour.ask.from')}</b>
              <span>{t('tour.ask.message')}</span>
            </span>
          </div>
          <div className="mail-reply">
            <span className="mail-reply-head">
              <Icon of={Reply} size={13} />
              {t('tour.ask.from')}
            </span>
            <span key={run} className="mail-reply-text" dir="auto">
              {stage === 'done' ? (
                words.map((word, index) => (
                  <span key={index} style={{ '--w': index } as CSSProperties}>
                    {word}{' '}
                  </span>
                ))
              ) : (
                <span className="mail-caret" />
              )}
            </span>
            <span className="mail-send">
              <Icon of={Send} size={12} mirror />
              {t('tour.ask.send')}
            </span>
          </div>
          {stage === 'writing' && <Island text={t('tour.ask.writing')} busy />}
        </div>
      </div>
    </div>
  );
}

/** One tap: the island takes the keyboard for a typed request. */
function OncePractice({ tap, lit, run, onShow }: { tap: string; lit: boolean; run: number; onShow: () => void }) {
  const { t } = useI18n();
  // The try whose request was sent; each new tap opens an empty box.
  const [sentRun, setSentRun] = useState(0);
  const sent = run > 0 && sentRun === run;
  return (
    <div className="tour-split">
      <div>
        <p className="tour-note">{t('tour.ask.onceHow', { tap })}</p>
        <TryLine text={t('tour.ask.onceTry', { tap })} keys={[tap]} lit={lit} done={run > 0} />
        {run === 0 && (
          <button type="button" className="link-btn tour-link" onClick={onShow}>
            {t('tour.ask.showMe')}
          </button>
        )}
        {sent && (
          <p className="ask-done" role="status">
            <Icon of={Check} size={14} />
            {t('tour.ask.typeDone')}
          </p>
        )}
      </div>
      <div className="tour-stage ask-stage">
        <Glow />
        {run > 0 ? (
          <TypeBox key={run} onSent={() => setSentRun(run)} />
        ) : (
          <span className="ask-waiting" aria-hidden="true">
            <kbd className={lit ? 'keycap is-down' : 'keycap'}>{tap}</kbd>
          </span>
        )}
      </div>
    </div>
  );
}

/** The island's typing box, as one tap opens it: empty, with the keyboard. */
function TypeBox({ onSent }: { onSent: () => void }) {
  const { t } = useI18n();
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  useEffect(() => field.current?.focus(), []);
  const examples: TKey[] = ['tour.ask.example1', 'tour.ask.example2', 'tour.ask.example3'];
  return (
    <form
      className="ask-type-mock"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim()) onSent();
      }}
    >
      <span className="ask-island-head">
        <Icon of={Sparkles} size={13} />
        ZOOD
      </span>
      <input ref={field} className="text-input" dir="auto" value={text} placeholder={t('tour.ask.typePlaceholder')} aria-label={t('tour.ask.typePlaceholder')} onChange={(event) => setText(event.target.value)} />
      <span className="ask-examples">
        {examples.map((example) => (
          <button
            key={example}
            type="button"
            className="ask-example"
            onClick={() => {
              setText(t(example));
              field.current?.focus();
            }}
          >
            {t(example)}
          </button>
        ))}
      </span>
    </form>
  );
}

/** The keys to hold: they light as they go down, and the island listens while they are held. */
function HoldPractice({ shortcut, mac, down, holding, held, onShow }: { shortcut: string; mac: boolean; down: ReadonlySet<string>; holding: boolean; held: 'short' | 'long' | null; onShow: () => void }) {
  const { t } = useI18n();
  const caps = shortcut.split('+').filter(Boolean);
  const keysText = isolate(caps.map((cap) => capLabel(cap, mac)).join(' + '));
  return (
    <div className="tour-split">
      <div>
        <p className="tour-note">{t('tour.ask.holdHow', { keys: keysText })}</p>
        <TryLine text={t('tour.ask.holdTry', { keys: keysText })} done={held === 'long'} />
        {held === 'short' && !holding && (
          <p className="ask-nudge" role="status">
            {t('tour.ask.holdShort')}
          </p>
        )}
        {held === 'long' && !holding ? (
          <p className="ask-done" role="status">
            <Icon of={Check} size={14} />
            {t('tour.ask.holdDone')}
          </p>
        ) : (
          <button type="button" className="link-btn tour-link" onClick={onShow}>
            {t('tour.ask.showMe')}
          </button>
        )}
      </div>
      <div className="tour-stage ask-stage">
        <Glow />
        <div className="ask-hold-mock">
          {holding && <Island text={t('tour.ask.listening')} listening />}
          <span className="ask-caps" dir="ltr">
            {caps.map((cap, index) => (
              <kbd key={index} className={capDown(cap, mac, down) || holding ? 'keycap is-down' : 'keycap'}>
                {capLabel(cap, mac)}
              </kbd>
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}

function capLabel(cap: string, mac: boolean): string {
  if (!mac) return cap === 'Mod' ? 'Ctrl' : cap;
  return ({ Mod: '⌘ Command', Shift: '⇧ Shift', Alt: '⌥ Option', Ctrl: '⌃ Control' } as Record<string, string>)[cap] ?? cap;
}

function capDown(cap: string, mac: boolean, down: ReadonlySet<string>): boolean {
  const codes =
    cap === 'Mod' ? (mac ? ['MetaLeft', 'MetaRight'] : ['ControlLeft', 'ControlRight']) : cap === 'Ctrl' ? ['ControlLeft', 'ControlRight'] : cap === 'Shift' ? ['ShiftLeft', 'ShiftRight'] : cap === 'Alt' ? ['AltLeft', 'AltRight'] : [cap.length === 1 ? `Key${cap.toUpperCase()}` : cap];
  return codes.some((code) => down.has(code));
}

/** "Try it now", with the keys to press shown as caps that light as they go down. */
function TryLine({ text, keys, lit, done }: { text: string; keys?: string[]; lit?: boolean; done: boolean }) {
  return (
    <p className={done ? 'ask-try is-done' : 'ask-try'}>
      <span className="ask-try-mark" aria-hidden="true">
        {done ? <Icon of={Check} size={13} /> : null}
      </span>
      <span>{text}</span>
      {keys && (
        <span className="ask-try-keys" dir="ltr" aria-hidden="true">
          {keys.map((key, index) => (
            <kbd key={index} className={lit ? 'keycap keycap-small is-down' : 'keycap keycap-small'}>
              {key}
            </kbd>
          ))}
        </span>
      )}
    </p>
  );
}

/** The island at the top of the screen, as Ask ZOOD shows it. */
function Island({ text, busy, listening }: { text: string; busy?: boolean; listening?: boolean }) {
  return (
    <span className={['ask-island-mock', busy ? 'is-busy' : '', listening ? 'is-listening' : ''].filter(Boolean).join(' ')} role="status">
      <Icon of={listening ? Mic : Sparkles} size={13} />
      <span>{text}</span>
      {listening && (
        <span className="chat-bars" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
      )}
    </span>
  );
}

type GuideDemo = 'show' | 'explain' | 'do';

/** A step of the pretend guide: where on the pretend window, 0..100, and what is said. */
interface DemoStep {
  x: number;
  y: number;
  say: TKey;
  /** The pretend button the step is on, for Show me's click. */
  on?: 'sign' | 'page' | 'settings' | 'dark';
}

const DEMO: Record<GuideDemo, { ask: TKey; steps: DemoStep[] }> = {
  show: {
    ask: 'tour.ask.guide.showAsk',
    steps: [
      { x: 47, y: 12, say: 'tour.ask.guide.show1', on: 'sign' },
      { x: 52, y: 62, say: 'tour.ask.guide.show2', on: 'page' },
    ],
  },
  explain: {
    ask: 'tour.ask.guide.explainAsk',
    steps: [
      { x: 30, y: 12, say: 'tour.ask.guide.explain1' },
      { x: 52, y: 55, say: 'tour.ask.guide.explain2' },
      { x: 88, y: 12, say: 'tour.ask.guide.explain3' },
    ],
  },
  do: {
    ask: 'tour.ask.guide.doAsk',
    steps: [
      { x: 88, y: 12, say: 'tour.ask.guide.do1', on: 'settings' },
      { x: 80, y: 40, say: 'tour.ask.guide.do2', on: 'dark' },
    ],
  },
};

/** How long the pretend pointer stays on a step it says, or clicks itself. */
const DEMO_STEP_MS = 2200;

/**
 * Show me, Explain this and Do it for me, on a pretend ZOOD window: the
 * pointer flies out of the island to each step and says it. In Show me the
 * person clicks the step themselves; Explain this and Do it for me move on
 * by themselves, Do it for me pressing the pretend buttons.
 */
function GuidePractice({ onTried }: { onTried: () => void }) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const [demo, setDemo] = useState<GuideDemo>('show');
  const [step, setStep] = useState(-1);
  const [dark, setDark] = useState(false);
  const [signed, setSigned] = useState(false);
  const { ask, steps } = DEMO[demo];
  const done = step >= steps.length;
  const now = step >= 0 && !done ? steps[step] : null;

  // Explain this and Do it for me move on by themselves.
  useEffect(() => {
    if (!now || demo === 'show') return;
    const timer = window.setTimeout(() => {
      if (now.on === 'dark') setDark(true);
      setStep((before) => before + 1);
    }, reduced ? DEMO_STEP_MS / 2 : DEMO_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [now, demo, reduced]);

  // Once a demo has played through, the chapter counts as practised.
  const tried = useRef(onTried);
  useEffect(() => {
    tried.current = onTried;
  });
  useEffect(() => {
    if (done) tried.current();
  }, [done]);

  const start = (which: GuideDemo) => {
    setDemo(which);
    setDark(false);
    setSigned(false);
    setStep(0);
  };
  const press = (on: DemoStep['on']) => {
    if (demo !== 'show' || !now || now.on !== on) return;
    if (on === 'page') setSigned(true);
    setStep((before) => before + 1);
  };
  const at = now ?? { x: 50, y: -8 };
  return (
    <div className="tour-split">
      <div>
        <p className="tour-note">{t('tour.ask.guideHow')}</p>
        <div className="tour-choice" role="group" aria-label={t('tour.ask.tabGuide')}>
          {(['show', 'explain', 'do'] as const).map((one) => (
            <button key={one} type="button" className="tour-choice-item" aria-pressed={demo === one && step >= 0} onClick={() => start(one)}>
              {t(`tour.ask.guide.${one}`)}
            </button>
          ))}
        </div>
        {done ? (
          <p className="ask-done" role="status">
            <Icon of={Check} size={14} />
            {t(demo === 'show' ? 'tour.ask.guide.showDone' : demo === 'do' ? 'tour.ask.guide.doDone' : 'tour.ask.guide.explainDone')}
          </p>
        ) : (
          <p className="tour-note ask-more">
            <Icon of={demo === 'show' ? MousePointerClick : Volume2} size={13} /> {t(demo === 'show' && now ? 'tour.ask.guide.clickIt' : 'tour.ask.guide.talks')}
          </p>
        )}
        <p className="tour-note ask-more">{t('tour.ask.guide.safe')}</p>
      </div>
      <div className={['tour-stage', 'ask-stage', 'guide-stage', dark ? 'is-dark' : ''].filter(Boolean).join(' ')}>
        <div className="guide-mock" aria-hidden={demo !== 'show'}>
          <div className="guide-mock-bar">
            <span className="guide-mock-tool">
              <Icon of={FolderOpen} size={13} />
            </span>
            <button type="button" className={now?.on === 'sign' ? 'guide-mock-tool is-target' : 'guide-mock-tool'} tabIndex={demo === 'show' ? 0 : -1} onClick={() => press('sign')}>
              <Icon of={PenLine} size={13} />
              {t('tour.ask.guide.signButton')}
            </button>
            <span className="guide-mock-tool">
              <Icon of={Share2} size={13} />
            </span>
            <span className={now?.on === 'settings' ? 'guide-mock-tool is-pressed' : 'guide-mock-tool'}>
              <Icon of={Settings} size={13} />
            </span>
          </div>
          <button type="button" className="guide-mock-page" tabIndex={demo === 'show' && now?.on === 'page' ? 0 : -1} onClick={() => press('page')}>
            <i />
            <i />
            <i />
            {signed && <span className="guide-mock-signature">{t('tour.ask.guide.signature')}</span>}
          </button>
          {demo === 'do' && step >= 1 && (
            <span className="guide-mock-menu">
              <span>{t('tour.ask.guide.darkLabel')}</span>
              <span className={dark ? 'guide-mock-switch is-on' : 'guide-mock-switch'} />
            </span>
          )}
        </div>
        {step >= 0 && (
          <span className="ask-island-mock" role="status">
            <Icon of={Sparkles} size={13} />
            <span dir="auto">{t(ask)}</span>
          </span>
        )}
        {now && (
          <div className={reduced ? 'ask-pointer is-still' : 'ask-pointer'} style={{ left: `${at.x}%`, top: `${at.y}%` }} aria-hidden="true">
            <span key={step} className="ask-guide-ripple" />
            <svg className="ask-guide-arrow" viewBox="0 0 28 34" width="22" height="27">
              <path d="M2 2 L2 27 L8.6 21.2 L13 31.5 L18 29.3 L13.6 19.2 L22.5 19.2 Z" />
            </svg>
            <span key={`say-${step}`} className={`ask-guide-label ${at.x > 65 ? 'ask-guide-left' : 'ask-guide-right'} is-below`} dir="auto">
              {t(now.say)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
