import { useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  Check,
  ClipboardPaste,
  Copy,
  FileText,
  Keyboard,
  Loader,
  Mic,
  MousePointerClick,
  PenLine,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import '../styles/tokens.css';
import '../styles/looks.css';
import '../styles/appearance.css';
import '../styles/fonts.css';
import './ask.css';
import { searchLibrary } from '../ai/chat/library';
import { machineMemoryGiB } from '../ai/device/useDeviceModel';
import type { DeviceModel } from '../ai/device/models';
import { loadWallet } from '../ai/profile/walletState';
import { targetWords, valueOf } from '../ai/profile/wallet';
import type { Target, WalletProfile } from '../ai/profile/wallet';
import { getSharedCoreClient } from '../core/client';
import { invokeHost, isTauriHost, onHostEvent } from '../core/host-tauri';
import { I18nProvider } from '../i18n/I18nProvider';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { prefersReducedMotion } from '../components/useReducedMotion';
import { applyAppearance } from '../settings/SettingsEffects';
import { useSettings } from '../state/settings';
import { defaultLook, readPreferences } from '../state/preferences';
import {
  draftGrammar,
  draftSystemPrompt,
  draftUserMessage,
  lookupWords,
  readDraft,
  todayWords,
} from './draft';
import type { Draft, DocumentLine } from './draft';
import { recall } from './memory';
import { decisionGrammar, languageOf, readDecision, systemPrompt } from './plan';
import type { AskTool, Decision, Moment } from './plan';
import { pushLevel, quietEnough, watchQuiet } from './listen';
import type { QuietWatch } from './listen';
import { readWindow, warmUp } from './read';
import { chosenBrain, earModels, onMac, readAskPreferences, tapKeyLabel } from './settings';
import { isolate } from '../signatures/model';
import { readStyle } from './style';
import { speak, stopSpeaking } from './voice';

/** True in Ask ZOOD's island window. */
export function isAskWindow(): boolean {
  if (!isTauriHost()) return false;
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').has('ask');
  } catch {
    return false;
  }
}

/** The quick tools' names, as the island says them. */
const TOOL_NAME: Record<AskTool, TKey> = {
  compress: 'quick.tool.compress',
  word: 'quick.tool.word',
  excel: 'quick.tool.excel',
  powerpoint: 'quick.tool.powerpoint',
  text: 'quick.tool.text',
  images: 'quick.tool.images',
  ocr: 'quick.tool.ocr',
  combine: 'quick.tool.combine',
  protect: 'quick.tool.protect',
  unlock: 'quick.tool.unlock',
  rotate: 'quick.tool.rotate',
  extract: 'quick.tool.extract',
  split: 'quick.tool.split',
  resize: 'quick.tool.resize',
  numbers: 'quick.tool.numbers',
  watermark: 'quick.tool.watermark',
  sign: 'quick.tool.sign',
  topdf: 'quick.tool.topdf',
};

interface Hit {
  key: string;
  name: string;
  page: number;
  text: string;
}

/** What the host knows of the moment of asking. */
interface HostMoment {
  files: string[];
  screen: boolean;
  app: string;
  title: string;
  readable: boolean;
}

/** The host's moment, with what an older host or a voice question leaves out filled in. */
function momentOf(raw: unknown): HostMoment {
  const value = (raw ?? {}) as Partial<HostMoment>;
  return {
    files: Array.isArray(value.files) ? value.files : [],
    screen: value.screen === true,
    app: typeof value.app === 'string' ? value.app : '',
    title: typeof value.title === 'string' ? value.title : '',
    readable: value.readable === true,
  };
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'listening'; screen: boolean; tapped: boolean }
  | { kind: 'short'; tapped: boolean }
  | { kind: 'hearing' }
  | { kind: 'typing' }
  | { kind: 'reading' }
  | { kind: 'drafting'; app: string }
  | { kind: 'thinking'; words: string; screen: boolean }
  | {
      kind: 'confirm';
      words: string;
      decision: Decision;
      profile: WalletProfile | null;
      files: number;
    }
  | { kind: 'found'; words: string; decision: Decision; hits: Hit[] }
  | { kind: 'said'; words: string; decision: Decision }
  | { kind: 'placed'; words: string; say: string; text: string; app: string }
  | { kind: 'ideas'; draft: Draft }
  | { kind: 'problem'; message: TKey; detail?: string };

/** How long an answer stays once said, and a list or a question waits. */
const SAID_STAYS_MS = 9000;
const WAITS_MS = 25000;
const SHORT_STAYS_MS = 2600;
/** How long the island takes to go back into the notch. */
const LEAVE_MS = 200;
/** A draft's note stays long enough to press Write it again. */
const PLACED_STAYS_MS = 14000;
/** How long typing waits for the first key before the box goes. */
const TYPING_WAITS_MS = 60000;

let asked = 0;

function errorKey(error: unknown): { message: TKey; detail: string } {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes('E_MODEL_MISSING')) return { message: 'ask.problem.models', detail: '' };
  if (text.includes('E_MIC')) return { message: 'ask.problem.mic', detail: '' };
  if (text.includes('E_CANCELLED')) return { message: 'ask.problem.stopped', detail: '' };
  if (text.includes('E_SCREEN')) return { message: 'ask.problem.screen', detail: '' };
  return { message: 'ask.problem.failed', detail: text.replace(/^E_[A-Z_]+:\s*/, '') };
}

/**
 * Ask ZOOD's island: a small card at the top of the screen — while it
 * listens (from one tap until the next, or while the keys are held) and
 * after, after a double tap of the tap key, or with a box to type in.
 * Listening, it draws the voice as a moving line, stops by itself once the
 * person goes quiet after a tap, and offers Done and Type instead.
 * It shows what was heard or typed, the answer, and when there is something
 * to do, what it will be with Do it and Cancel. A double tap's reply is
 * pasted straight away (it is never sent) and the island says where, with
 * Write it again. The window is never focused but to type in (the host
 * makes it so), so the app the person was in keeps the keyboard and the
 * cursor where text is put.
 */
function Island() {
  const { t, lang: uiLang } = useI18n();
  const settings = useSettings();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [level, setLevel] = useState(0);
  const [bars, setBars] = useState<number[]>([]);
  /** After a tap: when the person has gone quiet. Null while the keys are held. */
  const quiet = useRef<QuietWatch | null>(null);
  /** The last listening began with a tap. */
  const lastTapped = useRef(false);
  /** The screen's notch, in points, for the island to grow out of; null where it draws its own. */
  const [notch, setNotch] = useState<{ width: number; height: number } | null>(null);
  /** Shrinking back into the notch before the window goes. */
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef(0);
  const [typed, setTyped] = useState('');
  const [copied, setCopied] = useState(false);
  const card = useRef<HTMLDivElement | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const request = useRef<string | null>(null);
  /** The tapped window's words, read once per moment. */
  const windowText = useRef<Promise<string> | null>(null);

  // The look the main window chose.
  useEffect(() => {
    const apply = () => {
      const root = document.documentElement;
      const { theme, look } = readPreferences();
      if (theme && theme !== 'system') root.dataset.theme = theme;
      else delete root.dataset.theme;
      const shown = look ?? defaultLook();
      if (shown !== 'glass') root.dataset.look = shown;
      else delete root.dataset.look;
      applyAppearance(root, settings);
    };
    apply();
    window.addEventListener('storage', apply);
    return () => window.removeEventListener('storage', apply);
  }, [settings]);

  // The window is as tall as the card, so the screen below stays clickable.
  useEffect(() => {
    document.documentElement.classList.add('ask-page');
    const node = card.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      void invokeHost('ask_resize', {
        height: Math.ceil(node.getBoundingClientRect().height) + 24,
      }).catch(() => undefined);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const close = () => {
    stopSpeaking();
    if (request.current)
      void invokeHost('ai_cancel', { id: request.current }).catch(() => undefined);
    request.current = null;
    windowText.current = null;
    setTyped('');
    // It goes back into the notch first, unless motion is reduced.
    window.clearTimeout(leaveTimer.current);
    setLeaving(true);
    leaveTimer.current = window.setTimeout(
      () => {
        setLeaving(false);
        setPhase({ kind: 'idle' });
        void invokeHost('ask_hide').catch(() => undefined);
      },
      prefersReducedMotion() ? 0 : LEAVE_MS,
    );
  };
  const closeLater = useEffectEvent(close);

  // An answer goes by itself after a while; a question waits longer.
  useEffect(() => {
    const stays =
      phase.kind === 'said'
        ? SAID_STAYS_MS
        : phase.kind === 'short'
          ? SHORT_STAYS_MS
          : phase.kind === 'placed'
            ? PLACED_STAYS_MS
            : phase.kind === 'typing'
              ? TYPING_WAITS_MS
              : phase.kind === 'confirm' ||
                  phase.kind === 'found' ||
                  phase.kind === 'problem' ||
                  phase.kind === 'ideas'
                ? WAITS_MS
                : 0;
    if (!stays || (phase.kind === 'typing' && typed)) return;
    if (phase.kind === 'said' && phase.decision.text) return; // Something to read: it stays.
    const timer = window.setTimeout(() => closeLater(), stays);
    return () => window.clearTimeout(timer);
  }, [phase, typed]);

  useEffect(() => {
    if (phase.kind === 'typing') field.current?.focus();
  }, [phase.kind]);

  /** The words of the window in front, for a model that does not see it. */
  const wordsOfWindow = (moment: HostMoment, brain: DeviceModel): Promise<string> => {
    // A model that sees is shown the picture itself, when the host took one for it.
    if ((brain.sees && moment.screen) || !moment.readable) return Promise.resolve('');
    windowText.current ??= readWindow().catch(() => '');
    return windowText.current;
  };

  /** Lines of the person's Library about this window and these words. */
  const lookUp = async (title: string, text: string): Promise<DocumentLine[]> =>
    recall(getSharedCoreClient(), lookupWords(title, text)).catch(() => []);

  /** Pastes `text` where the cursor was, and says so. */
  const place = async (words: string, say: string, text: string, app: string) => {
    await invokeHost('ask_paste', { text });
    setPhase({ kind: 'placed', words, say, text, app });
  };

  /** Double tap: read the window, then draft the reply or suggest. */
  const draft = async () => {
    const prefs = readAskPreferences();
    const brain = chosenBrain(prefs, await machineMemoryGiB());
    asked += 1;
    const id = `ask-${Date.now()}-${asked}`;
    try {
      const moment = momentOf(await invokeHost('ask_moment'));
      const sees = Boolean(brain.sees) && moment.screen;
      if (!sees && !moment.readable)
        return setPhase({ kind: 'problem', message: 'ask.problem.screen' });
      if (!sees) setPhase({ kind: 'reading' });
      const text = await wordsOfWindow(moment, brain);
      setPhase({ kind: 'drafting', app: moment.app });
      const documents = await lookUp(moment.title, text);
      const context = {
        app: moment.app,
        title: moment.title,
        text,
        sees,
        style: readStyle(),
        documents,
        today: todayWords(),
      };
      request.current = `${id}-draft`;
      const done = (await invokeHost('ask_think', {
        request: {
          id: `${id}-draft`,
          model: brain.id,
          messages: [
            { role: 'system', content: draftSystemPrompt(context) },
            { role: 'user', content: draftUserMessage(context) },
          ],
          grammar: draftGrammar(),
          maxTokens: 700,
          contextTokens: 8192,
          screen: sees,
        },
      })) as { text: string };
      request.current = null;
      const result = readDraft(done.text);
      if (!result) return setPhase({ kind: 'problem', message: 'ask.problem.noDraft' });
      if (result.kind === 'reply') return await place('', result.say, result.text, moment.app);
      setPhase({ kind: 'ideas', draft: result });
    } catch (error) {
      request.current = null;
      setPhase({ kind: 'problem', ...errorKey(error) });
    }
  };

  /** A request, spoken or typed: decide, then do or show. */
  const respond = async (words: string, spoken: boolean) => {
    const prefs = readAskPreferences();
    const brain = chosenBrain(prefs, await machineMemoryGiB());
    asked += 1;
    const id = `ask-${Date.now()}-${asked}`;
    try {
      const moment = momentOf(await invokeHost('ask_moment'));
      const wallet = await loadWallet(t('wallet.me')).catch(() => null);
      const screen = moment.screen && Boolean(brain.sees);
      setPhase({ kind: 'thinking', words, screen });
      const text = await wordsOfWindow(moment, brain);
      const tapped = moment.app !== '' || moment.title !== '' || text !== '';
      const documents = await lookUp(moment.title, `${text}\n${words}`);
      const context: Moment = {
        files: moment.files,
        screen,
        profiles: wallet?.profiles ?? [],
        window: tapped ? { app: moment.app, title: moment.title, text } : null,
        style: readStyle(),
        documents,
        language: languageOf(words),
      };
      request.current = `${id}-think`;
      const done = (await invokeHost('ask_think', {
        request: {
          id: `${id}-think`,
          model: brain.id,
          messages: [
            { role: 'system', content: systemPrompt(context) },
            { role: 'user', content: words },
          ],
          grammar: decisionGrammar(context),
          maxTokens: 700,
          contextTokens: 8192,
          screen: context.screen,
        },
      })) as { text: string };
      request.current = null;
      const decision = readDecision(done.text, context) ?? {
        say: t(languageOf(words) === 'ar' ? 'ask.notUnderstoodAr' : 'ask.notUnderstoodEn'),
        act: 'answer',
        tool: null,
        query: '',
        fields: [],
        profile: '',
        x: -1,
        y: -1,
        text: '',
      };
      if (spoken) speak(decision.say);
      if (decision.act === 'write')
        return await place(words, decision.say, decision.text, moment.app);
      if (decision.act === 'tool')
        return setPhase({
          kind: 'confirm',
          words,
          decision,
          profile: null,
          files: moment.files.length,
        });
      if (decision.act === 'fill') {
        const profile =
          context.profiles.find((one) => one.name === decision.profile) ??
          context.profiles[0] ??
          null;
        return setPhase({ kind: 'confirm', words, decision, profile, files: 0 });
      }
      if (decision.act === 'find') {
        const hits = await searchLibrary(getSharedCoreClient(), decision.query).catch(() => []);
        const seen = new Set<string>();
        const files = hits.filter((hit) => !seen.has(hit.key) && seen.add(hit.key)).slice(0, 5);
        return setPhase({ kind: 'found', words, decision, hits: files });
      }
      if (decision.act === 'point')
        await invokeHost('ask_point', { x: decision.x, y: decision.y, label: decision.say }).catch(
          () => undefined,
        );
      setPhase({ kind: 'said', words, decision });
    } catch (error) {
      request.current = null;
      setPhase({ kind: 'problem', ...errorKey(error) });
    }
  };

  /** The tap's draft, from the host's event. */
  const onDraft = useEffectEvent(() => void draft());

  /** Speaking: the recording as words, then the request. */
  const hear = useEffectEvent(async () => {
    const ear = earModels()[0];
    if (!ear) return setPhase({ kind: 'problem', message: 'ask.problem.models' });
    asked += 1;
    const id = `ask-${Date.now()}-${asked}-ear`;
    try {
      setPhase({ kind: 'hearing' });
      request.current = id;
      const words = ((await invokeHost('ask_transcribe', { id, model: ear.id })) as string).trim();
      request.current = null;
      if (!words) return setPhase({ kind: 'problem', message: 'ask.problem.notHeard' });
      await respond(words, true);
    } catch (error) {
      request.current = null;
      setPhase({ kind: 'problem', ...errorKey(error) });
    }
  });

  useEffect(() => {
    const restart = () => {
      window.clearTimeout(leaveTimer.current);
      setLeaving(false);
      void invokeHost('ask_notch').then(
        (found) => setNotch((found as { width: number; height: number } | null) ?? null),
        () => setNotch(null),
      );
      stopSpeaking();
      if (request.current)
        void invokeHost('ai_cancel', { id: request.current }).catch(() => undefined);
      request.current = null;
      windowText.current = null;
      setCopied(false);
    };
    const stops = [
      onHostEvent<{ screen: boolean; tapped?: boolean }>('ask://listen', (payload) => {
        restart();
        setLevel(0);
        setBars([]);
        const tapped = payload.tapped === true;
        quiet.current = tapped ? watchQuiet(performance.now()) : null;
        lastTapped.current = tapped;
        setPhase({ kind: 'listening', screen: payload.screen, tapped });
      }),
      onHostEvent<number>('ask://level', (value) => {
        setLevel((before) => before * 0.4 + value * 0.6);
        setBars((before) => pushLevel(before, value));
        if (quiet.current && quietEnough(quiet.current, performance.now(), value)) {
          quiet.current = null;
          void invokeHost('ask_stop').catch(() => undefined);
        }
      }),
      onHostEvent<{ seconds: number; short: boolean; problem?: string }>('ask://heard', (heard) => {
        const tapped = quiet.current !== null || lastTapped.current;
        quiet.current = null;
        if (heard.problem)
          return setPhase({
            kind: 'problem',
            message: 'ask.problem.mic',
            detail: heard.problem.replace(/^E_[A-Z_]+:\s*/, ''),
          });
        if (heard.short) return setPhase({ kind: 'short', tapped });
        void hear();
      }),
      onHostEvent<{ kind: 'draft' | 'type'; screen: boolean }>('ask://tap', (tap) => {
        restart();
        if (tap.kind === 'type') {
          setTyped('');
          setPhase({ kind: 'typing' });
          // The recogniser starts while the person types.
          if (tap.screen) warmUp();
          return;
        }
        onDraft();
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);

  const fail = (error: unknown) => setPhase({ kind: 'problem', ...errorKey(error) });

  /** While listening: the person would rather type. */
  const typeInstead = () => {
    quiet.current = null;
    setTyped('');
    setPhase({ kind: 'typing' });
    void invokeHost('ask_type_instead').catch(() => undefined);
  };

  const doIt = (decision: Decision, profile: WalletProfile | null) => {
    stopSpeaking();
    if (decision.act === 'tool' && decision.tool) {
      void invokeHost('ask_run_tool', { tool: decision.tool }).then(
        () => setPhase({ kind: 'idle' }),
        fail,
      );
    } else if (decision.act === 'fill' && profile) {
      const parts = decision.fields.map((field) => valueOf(profile, field));
      void invokeHost('ask_type', { parts }).then(() => setPhase({ kind: 'idle' }), fail);
    }
  };

  const copy = (text: string) => {
    void invokeHost('ask_copy', { text }).then(() => setCopied(true), fail);
  };

  const submit = () => {
    const words = typed.trim();
    if (!words) return;
    setTyped('');
    void respond(words, false);
  };

  const words =
    phase.kind === 'confirm' ||
    phase.kind === 'found' ||
    phase.kind === 'said' ||
    phase.kind === 'thinking' ||
    phase.kind === 'placed'
      ? phase.words
      : '';
  const lang = words ? languageOf(words) : null;
  const busy =
    phase.kind === 'hearing' ||
    phase.kind === 'thinking' ||
    phase.kind === 'reading' ||
    phase.kind === 'drafting';
  const mac = onMac();
  const tapKey = isolate(
    tapKeyLabel(readAskPreferences().tapKey, mac, uiLang === 'ar' ? 'ar' : 'en'),
  );

  return (
    <div
      className={[
        'ask-island',
        `ask-${phase.kind}`,
        notch ? 'has-notch' : '',
        leaving ? 'is-leaving' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={
        (notch
          ? { '--notch-w': `${notch.width}px`, '--notch-h': `${notch.height}px` }
          : undefined) as unknown as React.CSSProperties
      }
      ref={card}
      role="status"
      aria-live="polite"
      hidden={phase.kind === 'idle'}
    >
      <div className="ask-head">
        <span
          className="ask-orb"
          style={{ '--level': phase.kind === 'listening' ? level : 0 } as React.CSSProperties}
          aria-hidden="true"
        >
          {busy ? (
            <Loader className="spin" />
          ) : phase.kind === 'typing' ? (
            <Keyboard />
          ) : phase.kind === 'placed' ? (
            <PenLine />
          ) : phase.kind === 'ideas' ? (
            <Sparkles />
          ) : (
            <Mic />
          )}
        </span>
        <span className="ask-title">
          {phase.kind === 'listening'
            ? t(phase.screen ? 'ask.listeningScreen' : 'ask.listening')
            : phase.kind === 'short'
              ? phase.tapped
                ? t('ask.tapToTalk', { tap: tapKey })
                : t('ask.holdToTalk')
              : phase.kind === 'hearing'
                ? t('ask.hearing')
                : phase.kind === 'thinking'
                  ? t(phase.screen ? 'ask.lookingAndThinking' : 'ask.thinking')
                  : phase.kind === 'reading'
                    ? t('ask.reading')
                    : phase.kind === 'drafting'
                      ? phase.app
                        ? t('ask.draftingIn', { app: phase.app })
                        : t('ask.drafting')
                      : phase.kind === 'placed'
                        ? phase.app
                          ? t('ask.placedIn', { app: phase.app })
                          : t('ask.placed')
                        : phase.kind === 'typing'
                          ? t('ask.typeTitle')
                          : phase.kind === 'problem'
                            ? t(phase.message)
                            : t('ask.settings.title')}
        </span>
        <button
          type="button"
          className="ask-close"
          aria-label={t('ask.close')}
          onClick={() => close()}
        >
          <X />
        </button>
      </div>
      {phase.kind === 'listening' && (
        <div className="ask-listen">
          <span className="ask-wave" dir="ltr" aria-hidden="true">
            {Array.from({ length: 24 }, (_, index) => {
              const value = bars[bars.length - 24 + index] ?? 0;
              return <i key={index} style={{ '--h': value.toFixed(3) } as React.CSSProperties} />;
            })}
          </span>
          <p className="ask-detail">
            {phase.tapped ? t('ask.tapAgain', { tap: tapKey }) : t('ask.letGo')}
          </p>
          {phase.tapped && (
            <div className="ask-actions">
              <button
                type="button"
                className="ask-do"
                onClick={() => {
                  quiet.current = null;
                  void invokeHost('ask_stop').catch(() => undefined);
                }}
              >
                <Square /> {t('ask.done')}
              </button>
              <button type="button" className="ask-cancel" onClick={typeInstead}>
                <Keyboard /> {t('ask.typeInstead')}
              </button>
            </div>
          )}
        </div>
      )}
      {phase.kind === 'problem' && phase.detail && <p className="ask-detail">{phase.detail}</p>}
      {phase.kind === 'typing' && (
        <form
          className="ask-type"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <textarea
            ref={field}
            dir="auto"
            rows={2}
            value={typed}
            placeholder={t('ask.typePlaceholder')}
            aria-label={t('ask.typeTitle')}
            onChange={(event) => setTyped(event.target.value.slice(0, 2000))}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
              } else if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <button
            type="submit"
            className="ask-send"
            aria-label={t('ask.send')}
            disabled={!typed.trim()}
          >
            <Send />
          </button>
        </form>
      )}
      {words && (
        <p className="ask-words" dir="auto">
          {lang === 'ar' ? `«${words}»` : `“${words}”`}
        </p>
      )}
      {(phase.kind === 'confirm' || phase.kind === 'found' || phase.kind === 'said') &&
        phase.decision.say && (
          <p className="ask-say" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
            {phase.kind === 'said' && phase.decision.act === 'point' && (
              <MousePointerClick className="ask-inline-icon" />
            )}
            {phase.decision.say}
          </p>
        )}
      {phase.kind === 'said' && phase.decision.text && (
        <div className="ask-plan">
          <p className="ask-text" dir="auto">
            {phase.decision.text}
          </p>
          <div className="ask-actions">
            <button
              type="button"
              className="ask-do"
              onClick={() =>
                void place(phase.words, phase.decision.say, phase.decision.text, '').catch(fail)
              }
            >
              <ClipboardPaste /> {t('ask.putAtCursor')}
            </button>
            <button type="button" className="ask-cancel" onClick={() => copy(phase.decision.text)}>
              {copied ? <Check /> : <Copy />} {t(copied ? 'ask.copied' : 'ask.copy')}
            </button>
          </div>
        </div>
      )}
      {phase.kind === 'placed' && (
        <div className="ask-plan">
          {phase.say && (
            <p className="ask-say" dir="auto">
              {phase.say}
            </p>
          )}
          <p className="ask-detail">{t(mac ? 'ask.placedHintMac' : 'ask.placedHint')}</p>
          <div className="ask-actions">
            <button
              type="button"
              className="ask-cancel"
              onClick={() => {
                // The draft just pasted is undone first, in the app it went to.
                void invokeHost('ask_undo').then(
                  () => (phase.words ? respond(phase.words, false) : draft()),
                  fail,
                );
              }}
            >
              <RotateCcw /> {t('ask.again')}
            </button>
            <button type="button" className="ask-cancel" onClick={() => copy(phase.text)}>
              {copied ? <Check /> : <Copy />} {t(copied ? 'ask.copied' : 'ask.copy')}
            </button>
          </div>
        </div>
      )}
      {phase.kind === 'ideas' && (
        <div className="ask-plan">
          {phase.draft.say && (
            <p className="ask-say" dir="auto">
              {phase.draft.say}
            </p>
          )}
          {phase.draft.ideas.length > 0 && (
            <ul className="ask-idea-list">
              {phase.draft.ideas.map((idea) => (
                <li key={idea}>
                  <button type="button" dir="auto" onClick={() => void respond(idea, false)}>
                    <Sparkles /> {idea}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {phase.kind === 'confirm' && phase.decision.act === 'tool' && phase.decision.tool && (
        <div className="ask-plan">
          <p>
            {t('ask.planTool', { tool: t(TOOL_NAME[phase.decision.tool]), count: phase.files })}
          </p>
          <div className="ask-actions">
            <button type="button" className="ask-do" onClick={() => doIt(phase.decision, null)}>
              <Check /> {t('ask.doIt')}
            </button>
            <button type="button" className="ask-cancel" onClick={() => close()}>
              {t('ask.cancel')}
            </button>
          </div>
        </div>
      )}
      {phase.kind === 'confirm' && phase.decision.act === 'fill' && phase.profile && (
        <div className="ask-plan">
          <p>{t('ask.planFill')}</p>
          <ol className="ask-fields">
            {phase.decision.fields.map((field: Target) => (
              <li key={field}>
                <span>{targetWords(field, lang === 'ar' ? 'ar' : 'en')}</span>
                <bdi dir="auto">{valueOf(phase.profile!, field)}</bdi>
              </li>
            ))}
          </ol>
          <div className="ask-actions">
            <button
              type="button"
              className="ask-do"
              onClick={() => doIt(phase.decision, phase.profile)}
            >
              <Check /> {t('ask.typeIt')}
            </button>
            <button type="button" className="ask-cancel" onClick={() => close()}>
              {t('ask.cancel')}
            </button>
          </div>
        </div>
      )}
      {phase.kind === 'found' && (
        <div className="ask-plan">
          {phase.hits.length === 0 ? (
            <p>
              <Search className="ask-inline-icon" />{' '}
              {t('ask.foundNone', { query: phase.decision.query })}
            </p>
          ) : (
            <ul className="ask-hits">
              {phase.hits.map((hit) => (
                <li key={hit.key}>
                  <button
                    type="button"
                    onClick={() =>
                      void invokeHost('ask_open', { path: hit.key }).then(
                        () => setPhase({ kind: 'idle' }),
                        fail,
                      )
                    }
                  >
                    <FileText />
                    <span className="ask-hit-name" dir="auto">
                      {hit.name}
                    </span>
                    <span className="ask-hit-line" dir="auto">
                      {hit.text}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** The island's window; the desktop host mounts it instead of `App` there. */
export function AskApp() {
  return (
    <I18nProvider>
      <Island />
    </I18nProvider>
  );
}
