import { useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  Check,
  ClipboardPaste,
  Copy,
  FileText,
  FolderInput,
  Keyboard,
  Loader,
  Mic,
  MousePointerClick,
  PenLine,
  Play,
  RotateCcw,
  Search,
  Send,
  SkipForward,
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
import { translate } from '../i18n/messages';
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
import {
  ending,
  explainPrompt,
  MAX_STEPS,
  near,
  nextStepPrompt,
  partsGrammar,
  readingTime,
  readNextStep,
  readParts,
  risky,
  stepGrammar,
} from './guide';
import type { GuideMode, Step } from './guide';
import { decisionGrammar, languageOf, readDecision, systemPrompt } from './plan';
import type { AskTool, Decision, Moment } from './plan';
import { pushLevel, quietEnough, watchQuiet } from './listen';
import {
  CERTAIN,
  QUICK_OPTIONS,
  QUICK_QUESTION,
  decide,
  isQuick,
  optionLabel,
  quickDecision,
  quickReady,
  readQuick,
  tidyChoice,
  tidyNames,
  warmQuick,
} from './quick';
import type { QuickKey, TidyPreview } from './quick';
import type { QuietWatch } from './listen';
import { readWindow, warmUp } from './read';
import { chosenBrain, earModels, onMac, readAskPreferences, tapKeyLabel } from './settings';
import { isolate } from '../signatures/model';
import { readStyle } from './style';
import { shouldTalk, stopSpeaking, talk } from './voice';

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
  /** ZOOD PDF itself was in front. */
  ours: boolean;
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
    ours: value.ours === true,
  };
}

/**
 * Where a guide is: waiting for the person's click (Show me), looking at
 * the screen again, clicking (Do it for me), asking before a step that
 * sends, deletes, pays or signs, stopped because the mouse moved, or
 * saying a part (Explain this).
 */
type GuideWait = 'click' | 'looking' | 'busy' | 'confirm' | 'paused' | 'telling';

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** How long Show me waits for one click before it stops. */
const CLICK_WAITS_MS = 5 * 60_000;

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
  | { kind: 'choose'; words: string; keys: [QuickKey, QuickKey]; spoken: boolean }
  | { kind: 'tidy'; words: string; preview: TidyPreview; working: boolean }
  | { kind: 'tidied'; words: string; say: string; undo: boolean }
  | { kind: 'placed'; words: string; say: string; text: string; app: string }
  | { kind: 'ideas'; draft: Draft }
  | {
      kind: 'guide';
      mode: GuideMode;
      words: string;
      say: string;
      /** The step, from 1; for an explanation, the part and how many there are. */
      step: number;
      of: number;
      wait: GuideWait;
      /** Do it for me was asked outside ZOOD PDF: it only points there. */
      onlyPoints: boolean;
    }
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
  /** Moved to the bottom of the screen, out of the way of the step the pointer shows. */
  const [aside, setAside] = useState(false);
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
  /** Counts the guides begun: a guide whose turn has passed stops. */
  const guideTurn = useRef(0);
  /** What the guide waits for: the person's Next, Go on or Stop, or their click. */
  const waiter = useRef<((choice: 'next' | 'stop') => void) | null>(null);
  /** The step on the screen, 0..1, that a click near counts as done. */
  const target = useRef<{ x: number; y: number } | null>(null);

  const waitFor = (atMost = 0) =>
    new Promise<'next' | 'stop'>((resolve) => {
      waiter.current = resolve;
      if (atMost) window.setTimeout(() => resolve('stop'), atMost);
    });
  const answer = (choice: 'next' | 'stop') => {
    const resolve = waiter.current;
    waiter.current = null;
    resolve?.(choice);
  };
  /** Ends a guide, if one is running: the pointer goes and clicks are no longer watched. */
  const endGuide = () => {
    const running = target.current !== null || waiter.current !== null;
    guideTurn.current += 1;
    target.current = null;
    answer('stop');
    if (running) {
      void invokeHost('ask_guide_end').catch(() => undefined);
      void invokeHost('ask_island_aside', { aside: false }).catch(() => undefined);
      setAside(false);
    }
  };

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
    endGuide();
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
  const endGuideNow = useEffectEvent(endGuide);
  /** A click while Show me waits: near the step, it counts as done. */
  const onClicked = useEffectEvent((clicked: { x: number; y: number }) => {
    const step = target.current;
    const aspect = globalThis.screen ? screen.width / screen.height : 16 / 9;
    if (step && near(clicked, step, aspect)) answer('next');
  });

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
                  phase.kind === 'choose' ||
                  phase.kind === 'tidy' ||
                  phase.kind === 'tidied' ||
                  phase.kind === 'problem' ||
                  phase.kind === 'ideas'
                ? WAITS_MS
                : 0;
    if (!stays || (phase.kind === 'typing' && typed)) return;
    if (phase.kind === 'said' && phase.decision.text) return; // Something to read: it stays.
    if (phase.kind === 'tidy' && phase.working) return;
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
      if (result.kind === 'reply') {
        if (shouldTalk(prefs.talkBack, false)) void talk(result.say);
        return await place('', result.say, result.text, moment.app);
      }
      setPhase({ kind: 'ideas', draft: result });
    } catch (error) {
      request.current = null;
      setPhase({ kind: 'problem', ...errorKey(error) });
    }
  };

  /** Said aloud as Settings › Talk back has it. */
  const aloud = (say: string, spoken: boolean) => {
    if (shouldTalk(readAskPreferences().talkBack, spoken)) void talk(say);
  };

  /** A short fixed reply, shown and said. */
  const sayOnly = (words: string, say: string, spoken: boolean) => {
    aloud(say, spoken);
    setPhase({
      kind: 'said',
      words,
      decision: {
        say,
        act: 'answer',
        tool: null,
        query: '',
        fields: [],
        profile: '',
        x: -1,
        y: -1,
        text: '',
      },
    });
  };

  /** The Library's files for a "find", at most five, each once. */
  const showFound = async (words: string, decision: Decision) => {
    const hits = await searchLibrary(getSharedCoreClient(), decision.query).catch(() => []);
    const seen = new Set<string>();
    const files = hits.filter((hit) => !seen.has(hit.key) && seen.add(hit.key)).slice(0, 5);
    setPhase({ kind: 'found', words, decision, hits: files });
  };

  const toolName = (tool: AskTool, language: 'ar' | 'en') => translate(language, TOOL_NAME[tool]);

  /**
   * The quick lane: the small decider picks the action, and a quick one is
   * done here with a short fixed reply. False when the larger model is to
   * answer instead (no decider downloaded, or words to write, or the screen).
   */
  const quickLane = async (
    words: string,
    spoken: boolean,
    moment: HostMoment,
    chosen?: QuickKey,
  ): Promise<boolean> => {
    const model = await quickReady();
    if (!model) return false;
    const language = languageOf(words);
    let key: QuickKey;
    let sure = 1;
    if (chosen) key = chosen;
    else {
      const ranked = await decide(model, words, QUICK_QUESTION, QUICK_OPTIONS).catch(() => null);
      if (!ranked) return false;
      const outcome = readQuick(ranked);
      if (outcome.kind === 'model') return false;
      if (outcome.kind === 'choose') {
        aloud(translate(language, 'ask.quick.choose'), spoken);
        setPhase({ kind: 'choose', words, keys: outcome.keys, spoken });
        return true;
      }
      key = outcome.key;
      sure = outcome.p;
    }
    if (!isQuick(key)) return false;
    if (key === 'organize') {
      const { place, how } = await tidyChoice(model, words, moment.files.length);
      const preview = (await invokeHost('ask_tidy_plan', {
        request: { place, how, names: tidyNames(language) },
      })) as TidyPreview;
      if (preview.count === 0) {
        sayOnly(
          words,
          translate(language, 'ask.tidy.nothing', { folder: preview.folderName }),
          spoken,
        );
        return true;
      }
      aloud(
        translate(language, `ask.tidy.plan.${preview.how}` as TKey, {
          count: preview.count,
          folder: preview.folderName,
        }),
        spoken,
      );
      setPhase({ kind: 'tidy', words, preview, working: false });
      return true;
    }
    if (key === 'undo') {
      const last = await invokeHost('ask_tidy_last');
      if (!last) {
        sayOnly(words, translate(language, 'ask.tidy.nothingToUndo'), spoken);
        return true;
      }
      const back = (await invokeHost('ask_tidy_undo')) as number;
      sayOnly(words, translate(language, 'ask.tidy.undone', { count: back }), spoken);
      return true;
    }
    const decision = quickDecision(key, words, moment.files.length, toolName);
    if (decision.act === 'tool' && decision.tool && sure >= CERTAIN) {
      // Sure enough: it runs at once, the one-line reply staying on the island.
      await invokeHost('ask_run_tool', { tool: decision.tool });
      sayOnly(words, decision.say, spoken);
      return true;
    }
    aloud(decision.say, spoken);
    if (decision.act === 'tool' && decision.tool) {
      // A little less sure: Do it first.
      setPhase({ kind: 'confirm', words, decision, profile: null, files: moment.files.length });
      return true;
    }
    if (decision.act === 'find') {
      await showFound(words, decision);
      return true;
    }
    setPhase({ kind: 'said', words, decision });
    return true;
  };

  /** A request, spoken or typed: decide, then do or show. */
  const respond = async (words: string, spoken: boolean, chosen?: QuickKey) => {
    const prefs = readAskPreferences();
    const brain = chosenBrain(prefs, await machineMemoryGiB());
    asked += 1;
    const id = `ask-${Date.now()}-${asked}`;
    try {
      const moment = momentOf(await invokeHost('ask_moment'));
      const screen = moment.screen && Boolean(brain.sees);
      setPhase({ kind: 'thinking', words, screen });
      if (await quickLane(words, spoken, moment, chosen)) return;
      const wallet = await loadWallet(t('wallet.me')).catch(() => null);
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
      if (decision.act === 'show' || decision.act === 'do' || decision.act === 'explain')
        return await guide(decision.act, words, decision, moment.ours, spoken, brain.id);
      if (shouldTalk(prefs.talkBack, spoken)) void talk(decision.say);
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
      if (decision.act === 'find') return await showFound(words, decision);
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

  /** One more question to the model about the screen as it is now. */
  const askScreen = async (model: string, system: string, user: string, grammar: string) => {
    asked += 1;
    const id = `ask-${Date.now()}-${asked}-guide`;
    request.current = id;
    const done = (await invokeHost('ask_think', {
      request: {
        id,
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        grammar,
        maxTokens: 600,
        contextTokens: 8192,
        screen: true,
      },
    })) as { text: string };
    request.current = null;
    return done.text;
  };

  /**
   * Show me, Do it for me and Explain this (`guide.ts`): ZOOD's pointer goes
   * to each step, says it, and waits for the person's click (Show me) or
   * clicks itself — inside ZOOD PDF only, asking first before a step that
   * sends, deletes, pays or signs, and stopping when the person moves the
   * mouse — then looks again for the next step. Explain this walks the
   * parts of the screen in one look. Stop, a tap of the key or closing the
   * island ends it at once.
   */
  const guide = async (
    mode: GuideMode,
    words: string,
    first: Decision,
    ours: boolean,
    spoken: boolean,
    model: string,
  ) => {
    endGuide();
    const turn = (guideTurn.current += 1);
    const live = () => guideTurn.current === turn;
    const prefs = readAskPreferences();
    const talks = shouldTalk(prefs.talkBack, spoken);
    const language = languageOf(words);
    const acting = mode === 'do' && ours && prefs.doForMe;
    const onlyPoints = mode === 'do' && !acting;
    const show = (say: string, step: number, of: number, wait: GuideWait) =>
      live() && setPhase({ kind: 'guide', mode, words, say, step, of, wait, onlyPoints });
    const finish = (say: string) => {
      if (!live()) return;
      endGuide();
      if (talks) void talk(say);
      setPhase({
        kind: 'said',
        words,
        decision: { ...first, act: 'answer', say, text: '', x: -1, y: -1 },
      });
    };
    const point = async (step: Step) => {
      const placed = (await invokeHost('ask_point', {
        x: step.x,
        y: step.y,
        label: step.say,
        guide: true,
      })) as { x: number; y: number };
      target.current = placed;
      // A step under the island: the island moves to the bottom, out of its way.
      const box = card.current?.getBoundingClientRect();
      const width = globalThis.screen?.width ?? 0;
      const height = globalThis.screen?.height ?? 0;
      if (box && width && height) {
        const under =
          Math.abs(placed.x - 0.5) * width < box.width / 2 + 40 &&
          placed.y * height < box.height + 60;
        setAside(under);
        await invokeHost('ask_island_aside', { aside: under }).catch(() => undefined);
      }
    };
    try {
      if (mode === 'explain') {
        show(first.say, 0, 0, 'looking');
        const read = readParts(
          await askScreen(model, explainPrompt(words, language), words, partsGrammar()),
        );
        if (!live()) return;
        if (!read || read.parts.length === 0)
          return finish(read?.say || first.say || ending('lost', language));
        const intro = read.say || first.say;
        for (const [index, part] of read.parts.entries()) {
          await point(part);
          if (!live()) return;
          show(
            index === 0 && intro ? `${intro} ${part.say}` : part.say,
            index + 1,
            read.parts.length,
            'telling',
          );
          const heard = Promise.all([
            talks
              ? talk(index === 0 && intro ? `${intro} ${part.say}` : part.say)
              : sleep(readingTime(part.say)),
            sleep(1400),
          ]).then(() => 'next' as const);
          const choice = await Promise.race([heard, waitFor()]);
          if (choice === 'stop' || !live()) return;
          stopSpeaking();
        }
        return finish(intro || ending('explained', language));
      }

      // A goal that itself sends, deletes, pays or signs is asked about once, first.
      if (acting && risky(words)) {
        show(first.say, 1, 0, 'confirm');
        if ((await waitFor()) === 'stop' || !live()) return;
      }
      const taken: string[] = [];
      let step: Step | null = { say: first.say, x: first.x, y: first.y };
      for (let index = 1; step && index <= MAX_STEPS; index += 1) {
        await point(step);
        if (!live()) return;
        if (acting) {
          if (risky(step.say)) {
            show(step.say, index, 0, 'confirm');
            if ((await waitFor()) === 'stop' || !live()) return;
          }
          show(step.say, index, 0, 'busy');
          // The pointer lands and the step is said before the click.
          await Promise.all([
            talks ? Promise.race([talk(step.say), sleep(2600)]) : undefined,
            sleep(1100),
          ]);
          let resume = false;
          for (;;) {
            if (!live()) return;
            try {
              await invokeHost('ask_click', { x: step.x, y: step.y, resume });
              break;
            } catch (error) {
              if (!String(error).includes('E_MOVED')) throw error;
              show(step.say, index, 0, 'paused');
              if ((await waitFor()) === 'stop' || !live()) return;
              resume = true;
              show(step.say, index, 0, 'busy');
            }
          }
          await sleep(900);
        } else {
          show(step.say, index, 0, 'click');
          if (talks) void talk(step.say);
          void invokeHost('ask_watch_clicks', { on: true }).catch(() => undefined);
          const choice = await waitFor(CLICK_WAITS_MS);
          void invokeHost('ask_watch_clicks', { on: false }).catch(() => undefined);
          if (choice === 'stop' || !live())
            return choice === 'stop' && live() ? close() : undefined;
          // What the click opened has time to show.
          await sleep(700);
        }
        taken.push(step.say);
        show(step.say, index, 0, 'looking');
        await invokeHost('ask_look_again');
        if (!live()) return;
        const next = readNextStep(
          await askScreen(
            model,
            nextStepPrompt(words, taken, acting ? 'do' : 'show', language),
            'What is the next step?',
            stepGrammar(),
          ),
        );
        if (!live()) return;
        if (!next) return finish(ending('lost', language));
        if (next.done) return finish(next.say || ending('done', language));
        step = next.step;
      }
      finish(ending('tooMany', language));
    } catch (error) {
      if (!live()) return;
      endGuide();
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
      endGuideNow();
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
        warmQuick();
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
      onHostEvent<{ x: number; y: number }>('ask://clicked', onClicked),
      onHostEvent<{ kind: 'draft' | 'type'; screen: boolean }>('ask://tap', (tap) => {
        restart();
        if (tap.kind === 'type') {
          setTyped('');
          setPhase({ kind: 'typing' });
          warmQuick();
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

  const tidyNow = (words: string, preview: TidyPreview) => {
    stopSpeaking();
    setPhase({ kind: 'tidy', words, preview, working: true });
    const language = languageOf(words);
    void invokeHost('ask_tidy_apply').then(
      (count) =>
        setPhase({
          kind: 'tidied',
          words,
          say: translate(language, 'ask.tidy.done', {
            count: count as number,
            folder: preview.folderName,
          }),
          undo: (count as number) > 0,
        }),
      fail,
    );
  };

  const untidy = (words: string) => {
    const language = languageOf(words);
    void invokeHost('ask_tidy_undo').then(
      (count) =>
        setPhase({
          kind: 'tidied',
          words,
          say: translate(language, 'ask.tidy.undone', { count: count as number }),
          undo: false,
        }),
      fail,
    );
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
    phase.kind === 'choose' ||
    phase.kind === 'tidy' ||
    phase.kind === 'tidied' ||
    phase.kind === 'thinking' ||
    phase.kind === 'placed'
      ? phase.words
      : '';
  const lang = words ? languageOf(words) : null;
  const busy =
    phase.kind === 'hearing' ||
    phase.kind === 'thinking' ||
    (phase.kind === 'tidy' && phase.working) ||
    phase.kind === 'reading' ||
    phase.kind === 'drafting';
  const guideTitle = (guiding: Extract<Phase, { kind: 'guide' }>) => {
    const name = t(
      guiding.mode === 'explain'
        ? 'ask.guide.explainTitle'
        : guiding.mode === 'do' && !guiding.onlyPoints
          ? 'ask.guide.doTitle'
          : 'ask.guide.showTitle',
    );
    if (guiding.mode === 'explain')
      return guiding.of
        ? `${name} · ${t('ask.guide.partOf', { n: guiding.step, of: guiding.of })}`
        : name;
    return guiding.step ? `${name} · ${t('ask.guide.stepN', { n: guiding.step })}` : name;
  };
  const mac = onMac();
  const tapKey = isolate(
    tapKeyLabel(readAskPreferences().tapKey, mac, uiLang === 'ar' ? 'ar' : 'en'),
  );

  return (
    <div
      className={[
        'ask-island',
        `ask-${phase.kind}`,
        notch && !aside ? 'has-notch' : '',
        aside ? 'is-aside' : '',
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
          ) : phase.kind === 'guide' ? (
            phase.wait === 'looking' ? (
              <Loader className="spin" />
            ) : (
              <MousePointerClick />
            )
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
                          : phase.kind === 'guide'
                            ? guideTitle(phase)
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
      {phase.kind === 'guide' && (
        <div className="ask-plan ask-guide-card">
          <p className="ask-words" dir="auto">
            {languageOf(phase.words) === 'ar' ? `«${phase.words}»` : `“${phase.words}”`}
          </p>
          {phase.say && (
            <p className="ask-say" dir="auto">
              {phase.say}
            </p>
          )}
          <p className="ask-detail">
            {phase.wait === 'click'
              ? t(phase.onlyPoints ? 'ask.guide.onlyPoints' : 'ask.guide.clickThere')
              : phase.wait === 'looking'
                ? t('ask.guide.looking')
                : phase.wait === 'busy'
                  ? t('ask.guide.clicking')
                  : phase.wait === 'confirm'
                    ? t('ask.guide.confirm')
                    : phase.wait === 'paused'
                      ? t('ask.guide.paused')
                      : t('ask.guide.telling')}
          </p>
          <div className="ask-actions">
            {phase.wait === 'confirm' && (
              <button type="button" className="ask-do" onClick={() => answer('next')}>
                <Check /> {t('ask.guide.doStep')}
              </button>
            )}
            {phase.wait === 'paused' && (
              <button type="button" className="ask-do" onClick={() => answer('next')}>
                <Play /> {t('ask.guide.goOn')}
              </button>
            )}
            {(phase.wait === 'click' || phase.wait === 'telling') && (
              <button type="button" className="ask-do" onClick={() => answer('next')}>
                <SkipForward className="ask-flip" />{' '}
                {t(phase.wait === 'click' ? 'ask.guide.didIt' : 'ask.guide.next')}
              </button>
            )}
            <button type="button" className="ask-cancel" onClick={() => close()}>
              <Square /> {t('ask.guide.stop')}
            </button>
          </div>
        </div>
      )}
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
      {phase.kind === 'choose' && (
        <div className="ask-plan">
          <p dir={lang === 'ar' ? 'rtl' : 'ltr'}>{translate(lang ?? 'en', 'ask.quick.choose')}</p>
          <div className="ask-actions">
            {phase.keys.map((key) => (
              <button
                key={key}
                type="button"
                className="ask-do"
                onClick={() => void respond(phase.words, phase.spoken, key)}
              >
                {optionLabel(key, lang ?? 'en', toolName)}
              </button>
            ))}
          </div>
        </div>
      )}
      {phase.kind === 'tidy' && (
        <div className="ask-plan">
          <p dir={lang === 'ar' ? 'rtl' : 'ltr'}>
            <FolderInput className="ask-inline-icon" />{' '}
            {translate(lang ?? 'en', `ask.tidy.plan.${phase.preview.how}` as TKey, {
              count: phase.preview.count,
              folder: phase.preview.folderName,
            })}
          </p>
          <ul className="ask-tidy-moves">
            {phase.preview.moves.slice(0, 5).map(([from, to]) => (
              <li key={from}>
                <bdi dir="auto">{from}</bdi>
                <span aria-hidden="true">{lang === 'ar' ? '←' : '→'}</span>
                <bdi dir="auto">{to}</bdi>
              </li>
            ))}
            {phase.preview.count > 5 && (
              <li className="ask-tidy-more">
                {translate(lang ?? 'en', 'ask.tidy.more', { count: phase.preview.count - 5 })}
              </li>
            )}
          </ul>
          <p className="ask-detail">{translate(lang ?? 'en', 'ask.tidy.note')}</p>
          <div className="ask-actions">
            <button
              type="button"
              className="ask-do"
              disabled={phase.working}
              onClick={() => tidyNow(phase.words, phase.preview)}
            >
              {phase.working ? <Loader className="spin" /> : <Check />}{' '}
              {translate(lang ?? 'en', phase.working ? 'ask.tidy.working' : 'ask.tidy.go')}
            </button>
            <button
              type="button"
              className="ask-cancel"
              disabled={phase.working}
              onClick={() => close()}
            >
              {t('ask.cancel')}
            </button>
          </div>
        </div>
      )}
      {phase.kind === 'tidied' && (
        <div className="ask-plan">
          <p className="ask-say" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
            {phase.say}
          </p>
          {phase.undo && (
            <div className="ask-actions">
              <button type="button" className="ask-cancel" onClick={() => untidy(phase.words)}>
                <RotateCcw /> {translate(lang ?? 'en', 'ask.tidy.undo')}
              </button>
            </div>
          )}
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
