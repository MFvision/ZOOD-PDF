import { useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  Check,
  ClipboardPaste,
  Copy,
  FileSpreadsheet,
  FileText,
  FileType,
  FolderInput,
  Globe,
  Keyboard,
  Loader,
  Mic,
  MousePointerClick,
  PenLine,
  Play,
  Presentation,
  RotateCcw,
  Search,
  Send,
  SkipForward,
  Sparkles,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import '../styles/tokens.css';
import '../styles/looks.css';
import '../styles/looks/premium.css';
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
import { announceReady, invokeHost, isTauriHost, onHostEvent, openExternalUrl, saveDeck, sortVoice, uiLog } from '../core/host-tauri';
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
import {
  asksFirst,
  bookEnding,
  bookOptions,
  controlNamed,
  controlNamedAlone,
  controlOptions,
  intentOf,
  partsOf,
  stepFor,
  stepOf,
  stepWords,
} from './book';
import type { BookEntry, BookStep, Control, Intent } from './book';
import { settingAsked, settingFirst, settingsPageAsked, settingWords, unknownSetting } from './settingsBook';
import type { SettingAsk } from './settingsBook';
import { answerFile, answerTitle } from './answerFile';
import { AnswerText } from './AnswerText';
import { PAGES_READ, cellText, markdownTable, researchAsked, researchMessages, researchQuery, sourceLines } from './research';
import type { WebHit, WebPage } from './research';
import { SAFE_CHARS_PER_TOKEN, contextTokensFor, materialTokensFor, replyTokensFor } from '../ai/device/context';
import type { AnswerFileKind } from './answerFile';
import { asksAGeneralQuestion, asksAboutWords, asksTheWorld, asksToReadOut } from './content';
import { ASKS_FIRST, keysOf, shortcutAsked } from './shortcuts';
import { namesIt, pickByWords, sayChoices } from './choices';
import { asksBack, historyMessages, isNo, isYes, offeredUrl, safeSite, siteAsked, siteName, stillFresh } from './followUp';
import { refusal, settingRefused } from './negation';
import type { LastTurn } from './followUp';
import { DECK_LOOKS, DECK_SIZES, canvasMeasure, deckAsked, deckFile, deckGrammar, deckPrompt, deckRequest, deckTopic, drawBackground, readDeck } from './deck';
import type { DeckLook } from './deck';
import type { Shortcut } from './shortcuts';
import { fuzzyOffers, fuzzyPick } from './fuzzy';
import type { Picked } from './fuzzy';
import { decisionGrammar, languageOf, readDecision, systemPrompt } from './plan';
import type { AskTool, Decision, Moment } from './plan';
import { pushLevel, quietEnough, watchQuiet } from './listen';
import {
  CERTAIN,
  SURE,
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
import { chosenBrain, onMac, readAskPreferences, readyEar, tapKeyLabel, writerFor } from './settings';
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

/** Terminals and consoles, by their app names: a line pasted there runs. */
/** How long a window may take to list its buttons before the picture is used instead. */
const CONTROLS_WAIT_MS = 2500;
/** Fewer buttons than this, and the window is asked once more: a browser lists its page late. */
const FEW_CONTROLS = 8;
/** At most this much of an answer is said aloud: the rest stays on the card to read. */
const SPOKEN_MOST = 2400;
const TERMINAL = /\b(?:terminal|iterm2?|powershell|pwsh|cmd|command prompt|conhost|windowsterminal|warp|alacritty|kitty|wezterm|ghostty|putty)\b/i;

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
  | { kind: 'researching'; words: string; step: 'search' | 'read' | 'write'; count: number }
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
  /** No command or setting clearly named: the few it could be, to choose from (`fuzzy.ts`). */
  | { kind: 'pick'; words: string; offers: Picked[]; spoken: boolean }
  | { kind: 'tidy'; words: string; preview: TidyPreview; working: boolean }
  | { kind: 'tidied'; words: string; say: string; undo: boolean }
  /** A draft pasted where the cursor was; `held`: not pasted yet, shown first (`heldWhy`: it quotes the Library, or the window is a terminal). */
  | { kind: 'placed'; words: string; say: string; text: string; app: string; held?: 'library' | 'terminal' }
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
  /** "Make me a presentation": its few questions, then the slides being written (`deck.ts`). */
  | {
      kind: 'deck';
      words: string;
      topic: string;
      notes: string;
      size: (typeof DECK_SIZES)[number];
      look: DeckLook;
      working: boolean;
      /** The answer the slides are made from, when an answer asked for them. */
      source?: string;
    }
  | { kind: 'decked'; words: string; say: string }
  | { kind: 'problem'; message: TKey; detail?: string };

/** How long an answer stays once said, and a list or a question waits. */
const SAID_STAYS_MS = 9000;
/** The site an answer that asks back is about: what its Yes button opens. */
function offeredSite(words: string, decision: Decision): string | null {
  if (decision.query.startsWith(SITE_OPENED)) return null;
  return offeredUrl(words, decision.say, decision.text);
}

/** Marks an answer that opened a site, so a "yes" after it does not open it again. */
const SITE_OPENED = 'site:';
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
  if (text.includes('E_TOO_BIG')) return { message: 'ask.problem.tooBig', detail: '' };
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
  /** An answer being kept as a file. */
  const [making, setMaking] = useState<AnswerFileKind | null>(null);
  /** An answer is being read out from its Read button. */
  const [readingOut, setReadingOut] = useState(false);
  const card = useRef<HTMLDivElement | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const request = useRef<string | null>(null);
  /** The last answer, so "yes" or "and in summer?" right after it answers it (`followUp.ts`). */
  const lastTurn = useRef<LastTurn | null>(null);
  /** The tapped window's words, read once per moment. */
  const windowText = useRef<Promise<string> | null>(null);
  /** The buttons of the window in front, as read for one request. */
  const controlsRead = useRef<{ asked: number; at: number; list: Control[] } | null>(null);
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
      void invokeHost('ask_command_stop').catch(() => undefined);
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
        ? asksBack(phase.decision.say)
          ? WAITS_MS
          : SAID_STAYS_MS
        : phase.kind === 'short'
          ? SHORT_STAYS_MS
          : phase.kind === 'placed'
            ? PLACED_STAYS_MS
            : phase.kind === 'typing'
              ? TYPING_WAITS_MS
              : phase.kind === 'confirm' ||
                  phase.kind === 'found' ||
                  phase.kind === 'choose' ||
                  phase.kind === 'pick' ||
                  phase.kind === 'tidy' ||
                  phase.kind === 'tidied' ||
                  phase.kind === 'decked' ||
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

  // Every answer is remembered for a few minutes: the next words may answer it back.
  useEffect(() => {
    if (phase.kind !== 'said' || phase.decision.act !== 'answer' || !phase.decision.say) return;
    const { say, text, query } = phase.decision;
    // A site just opened is not offered again by a "yes".
    const opened = query.startsWith(SITE_OPENED);
    lastTurn.current = {
      words: phase.words,
      say,
      text,
      url: opened ? null : offeredUrl(phase.words, say, text),
      at: Date.now(),
    };
  }, [phase]);

  // Esc closes it from anywhere in the island, not only the typing box: after a
  // typed question the box is gone but the island still has the keyboard.
  const open = phase.kind !== 'idle';
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      closeLater();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

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

  /**
   * Pastes `text` where the cursor was, and says so. A draft that quotes the
   * person's own documents is shown first and pasted only when they say so
   * (what the window said picked those lines, and the window may be someone
   * else's words); into a terminal, where a pasted line runs as a command,
   * it is never pasted, only shown to copy.
   */
  const place = async (words: string, say: string, text: string, app: string, quotes = false) => {
    if (TERMINAL.test(app)) return setPhase({ kind: 'placed', words, say, text, app, held: 'terminal' });
    if (quotes) return setPhase({ kind: 'placed', words, say, text, app, held: 'library' });
    await invokeHost('ask_paste', { text });
    setPhase({ kind: 'placed', words, say, text, app });
  };

  /** Double tap: read the window, then draft the reply or suggest. */
  const draft = async () => {
    const prefs = readAskPreferences();
    // A reply is read by someone: written by the best model there is.
    const brain = await writerFor(chosenBrain(prefs, await machineMemoryGiB()), await machineMemoryGiB());
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
        return await place('', result.say, result.text, moment.app, documents.length > 0);
      }
      // The ideas are said with the question, so someone listening can answer one.
      if (shouldTalk(prefs.talkBack, false)) {
        const language = languageOf(`${result.say} ${result.ideas.join(' ')}`);
        void talk(sayChoices(result.say || translate(language, 'ask.ideas.question'), result.ideas, language));
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

  /**
   * "Go to amazon dot sa", «افتح يوتيوب», or "yes" to an answer that named a
   * site: the browser opens it at once, with no model (`followUp.ts`).
   */
  const openSite = async (words: string, url: string, spoken: boolean) => {
    const language = languageOf(words);
    const site = siteName(url);
    // Only a named web site, never a file, a script, or this computer's network (`safeSite`).
    if (!safeSite(url)) {
      uiLog(`ask: not opening ${url}: not a web site`);
      return sayOnly(words, translate(language, 'ask.site.refused', { site }), spoken);
    }
    try {
      await openExternalUrl(url);
    } catch (error) {
      uiLog(`ask: opening ${url} failed: ${String(error)}`);
      return sayOnly(words, translate(language, 'ask.site.failed', { site }), spoken);
    }
    const say = translate(language, 'ask.site.opening', { site });
    aloud(say, spoken);
    setPhase({
      kind: 'said',
      words,
      decision: { say, act: 'answer', tool: null, query: `${SITE_OPENED}${url}`, fields: [], profile: '', x: -1, y: -1, text: '' },
    });
  };

  /**
   * "Search the internet for…" (`research.ts`): the host searches and
   * fetches the first pages as text (`ask/web.rs`), and the best model here
   * writes the answer from them — a table with links for things to compare
   * or buy, kept as an Excel sheet with one press.
   */
  const research = async (words: string, spoken: boolean) => {
    const language = languageOf(words);
    setPhase({ kind: 'researching', words, step: 'search', count: 0 });
    let hits: WebHit[];
    try {
      hits = ((await invokeHost('ask_web_search', { query: researchQuery(words) })) as WebHit[]).slice(0, 8);
    } catch (error) {
      uiLog(`ask: web search failed: ${String(error)}`);
      return sayOnly(words, translate(language, 'ask.web.offline'), spoken);
    }
    if (hits.length === 0) return sayOnly(words, translate(language, 'ask.web.nothing'), spoken);
    setPhase({ kind: 'researching', words, step: 'read', count: Math.min(PAGES_READ, hits.length) });
    const pages = await Promise.all(
      hits.map((hit, k) =>
        k < PAGES_READ ? (invokeHost('ask_web_read', { url: hit.url }) as Promise<WebPage>).catch(() => null) : Promise.resolve(null),
      ),
    );
    setPhase({ kind: 'researching', words, step: 'write', count: hits.length });
    const memory = await machineMemoryGiB();
    const model = await writerFor(chosenBrain(readAskPreferences(), memory), memory);
    const context = contextTokensFor(memory, false);
    const room = Math.floor(materialTokensFor(context) * SAFE_CHARS_PER_TOKEN);
    const today = new Date().toISOString().slice(0, 10);
    asked += 1;
    const id = `ask-${Date.now()}-${asked}-web`;
    request.current = id;
    const done = (await invokeHost('ask_think', {
      request: {
        id,
        model: model.id,
        messages: researchMessages(words, hits, pages, language, room, today),
        maxTokens: replyTokensFor(context),
        contextTokens: context,
        screen: false,
      },
    })) as { text: string };
    request.current = null;
    const answer = done.text.trim();
    if (!answer) return sayOnly(words, translate(language, 'ask.web.nothing'), spoken);
    const say = translate(language, 'ask.web.found', { count: hits.length });
    // A table is read as its choices, one by one; other answers whole.
    const table = markdownTable(answer);
    const items = table ? table.slice(1).map((row) => cellText(row[0] ?? '')).filter(Boolean) : [];
    const heard = table
      ? `${say} ${items.map((item, k) => `${k + 1}: ${item}.`).join(' ')}`
      : `${say}\n${answer}`;
    aloud(heard.slice(0, SPOKEN_MOST), spoken);
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
        text: `${answer}\n\n${translate(language, 'ask.web.sources')}\n${sourceLines(hits)}`,
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
        // The choices themselves are said, not only the question (`choices.ts`).
        aloud(sayChoices(translate(language, 'ask.quick.choose'), outcome.keys.map((one) => optionLabel(one, language, toolName)), language), spoken);
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
  const respond = async (words: string, spoken: boolean, chosen?: QuickKey, past = false): Promise<void> => {
    // The ideas a double tap offered were read out: "the second", «الأول» or an idea's words runs it.
    if (!chosen && !past && phase.kind === 'ideas') {
      const i = pickByWords(words, phase.draft.ideas);
      if (i !== null) return respond(phase.draft.ideas[i]!, spoken);
    }
    // Choices were just read out: "the second", «الأول» or a choice's name answers them.
    if (!chosen && !past && (phase.kind === 'choose' || phase.kind === 'pick')) {
      const language = languageOf(phase.words);
      if (phase.kind === 'choose') {
        const i = pickByWords(words, phase.keys.map((key) => optionLabel(key, language, toolName)));
        if (i !== null) return respond(phase.words, spoken, phase.keys[i]);
      } else {
        if (namesIt(words, translate(language, 'ask.pick.other'))) return respond(phase.words, spoken, undefined, true);
        const i = pickByWords(words, phase.offers.map((offer) => offerName(offer, language)));
        if (i !== null) return runPicked(phase.offers[i]!, phase.words, spoken);
      }
    }
    // A Sort window waiting for an answer (its Speak button, or it is in
    // front) takes the words: it says what it does itself (`sort/voice.ts`).
    if (!chosen && !past && (await sortVoice(words))) {
      return close();
    }
    // Words that answer the last answer back: "yes" opens the site it named, or
    // goes to the model with that answer in front of it; "no" is only heard.
    const last = lastTurn.current;
    const fresh = !chosen && !past && stillFresh(last, Date.now());
    let replying = false;
    if (fresh && last && isNo(words)) {
      lastTurn.current = null;
      return sayOnly(words, translate(languageOf(words), 'ask.followUp.no'), spoken);
    }
    if (fresh && last && isYes(words)) {
      if (last.url) {
        lastTurn.current = null;
        return await openSite(words, last.url, spoken);
      }
      replying = true;
    }
    // "Don't delete page 3", «لا تحذف الصفحة»: nothing is done. A "don't" beside
    // something to do ("save but don't print") is the model's to read whole,
    // never a lane's that would see only the command's name (`negation.ts`).
    const refused = !chosen && !past && !replying ? refusal(words) : null;
    if (refused === 'all') {
      // «لا ترد بالصوت», "no dark mode": a setting named with no verb is turned off.
      const off = settingRefused(words, true);
      if (off && (await settingsLane(words, spoken, false, off))) return;
      return sayOnly(words, translate(languageOf(words), 'ask.negated'), spoken);
    }
    // "Go to amazon dot sa", «افتح موقع نون»: opened in the browser, no model.
    const site = !chosen && !past && !replying && !refused ? siteAsked(words) : null;
    if (site) return await openSite(words, site, spoken);
    const prefs = readAskPreferences();
    const brain = chosenBrain(prefs, await machineMemoryGiB());
    asked += 1;
    const id = `ask-${Date.now()}-${asked}`;
    try {
      const moment = momentOf(await invokeHost('ask_moment'));
      // A question for a general assistant ("what is the weather like in winter?", «كيف أسوي مشروع؟»):
      // answered in words by the best model, without a picture of the screen or the window's text.
      const general = !chosen && (replying || refused !== null || asksAGeneralQuestion(words));
      setPhase({ kind: 'thinking', words, screen: moment.screen && Boolean(brain.sees) && !general });
      // Inside ZOOD PDF its own commands come first: no picture, no wait.
      // A setting named with its choice, or a page of Settings, before the menus: "keep 20 versions", "AI settings".
      const named = !chosen && !past && !general;
      // Words to write, sum up, read out or judge ("write a reply", "لخص الإيميل") are the model's, never a setting's.
      const readOut = !moment.ours && asksToReadOut(words);
      const about = readOut || asksAboutWords(words) || general;
      const setting = named && !about;
      // Another app's everyday command ("print", «اطبع», "new tab"): its own shortcut, no picture.
      const shortcut = named && !moment.ours ? shortcutAsked(words) : null;
      if (shortcut) return await shortcutLane(words, shortcut, spoken);
      // "Search the internet for…": looked up on the web, read and written here.
      if (!chosen && !past && !refused && prefs.web && researchAsked(words)) return await research(words, spoken);
      // "Make me a presentation": a few questions, then ZOOD writes the file itself.
      if (!chosen && !past && !refused && deckAsked(words)) return startDeck(words, spoken);
      // Another app's button by its name ("archive", "click Insert", «أرشف»), before ZOOD's own settings:
      // there, "new message" is the app's button, not ZOOD's greeting.
      if (named && !moment.ours && (await controlsLane(words, spoken, 'bare'))) return;
      if (named && !moment.ours && (await controlsLane(words, spoken, 'named'))) return;
      if (setting && settingFirst(words, true) && (await settingsLane(words, spoken))) return;
      if (named && moment.ours && (await bookLane(words, spoken))) return;
      // "How do I add a signature?" in ZOOD PDF is still shown on the screen, when a command is
      // named outright; a general "how do I …" is never guessed into one of ZOOD's commands.
      if (general && !refused && moment.ours && intentOf(words) === 'show' && (await bookLane(words, spoken, false))) return;
      // A setting, by its name, from anywhere: Settings opens at it.
      if (setting && (await settingsLane(words, spoken))) return;
      // Named by its words, not as a phrase: done when one is clearly meant, offered when a few could be.
      if (setting && (await fuzzyLane(words, spoken, moment.ours))) return;
      // "Change the …" that names no setting we know: Settings, said plainly, never a tool guessed instead.
      if (setting && unknownSetting(words)) {
        uiLog(`ask: no setting matched "${words}"`);
        await settingsLane(words, spoken, true);
        return;
      }
      // Not a tool either: "extract the dates from this" is not Extract pages.
      if ((chosen || !about) && (await quickLane(words, spoken, moment, chosen))) return;
      // Another app: its buttons by their names, before any picture is read.
      if (!chosen && !past && !general && !moment.ours && (await controlsLane(words, spoken))) return;
      // Words to be read or heard, and Show me or Do it for me, come from the best model there is (`writerFor`).
      const model = about || intentOf(words) || shouldTalk(prefs.talkBack, spoken) ? await writerFor(brain, await machineMemoryGiB()) : brain;
      const screen = moment.screen && Boolean(model.sees) && !general;
      const wallet = await loadWallet(t('wallet.me')).catch(() => null);
      const text = general ? '' : await wordsOfWindow(moment, model);
      const tapped = !general && (moment.app !== '' || moment.title !== '' || text !== '');
      const documents = await lookUp(general ? '' : moment.title, `${text}\n${words}`);
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
          model: model.id,
          messages: [
            { role: 'system', content: systemPrompt(context) },
            // A reply or another general question sees the answer before it.
            ...(replying || general ? historyMessages(fresh ? last : null, Date.now()) : []),
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
        return await guide(decision.act, words, decision, moment.ours, spoken, model.id);
      // A summary or an answer is said whole, not only its first line; "read this to me" always is.
      const whole = decision.act === 'answer' && decision.text ? `${decision.say}\n${decision.text}` : decision.say;
      if (readOut && decision.text) void talk(decision.text.slice(0, SPOKEN_MOST));
      else if (shouldTalk(prefs.talkBack, spoken)) void talk(whole.slice(0, SPOKEN_MOST));
      if (decision.act === 'write')
        return await place(words, decision.say, decision.text, moment.app, documents.length > 0);
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

  /** ZOOD's pointer to a step, staying there; the island moves aside when it is under it. */
  const pointAt = async (step: Step) => {
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

  /** The step a part names that no words matched, by the small decider, when it is sure. */
  const decided = async (
    part: string,
    question: string,
    options: Record<string, string>,
  ): Promise<string | null> => {
    const model = await quickReady();
    if (!model) return null;
    const ranked = await decide(model, part, question, options).catch(() => null);
    const top = ranked?.[0];
    return top && top.key !== 'none' && top.p >= SURE ? top.key : null;
  };

  /**
   * ZOOD's command book (`book.ts`): inside ZOOD PDF, what was asked is
   * matched to the app's own commands and run in the editor
   * (`shell/askBridge.ts`) — no picture, no model reading the screen. False
   * when a part of the request is not a command, for the models to answer.
   */
  const bookLane = async (words: string, spoken: boolean, guess = true): Promise<boolean> => {
    const said = intentOf(words);
    // A question about a command ("what does Print do?") is answered, not done.
    if (!said && /[?؟]|^(?:what|why|which|who|is|are|does|ما |ماذا|وش |ايش|ليش|لماذا|هل )/i.test(words.trim()))
      return false;
    const book = (await invokeHost('ask_book').catch(() => null)) as { entries?: BookEntry[] } | null;
    const entries = book?.entries ?? [];
    if (entries.length === 0) return false;
    const parts = partsOf(words);
    if (parts.length === 0) return false;
    const steps: BookStep[] = [];
    for (const part of parts) {
      let step = stepOf(part, entries);
      // Only an outright "do it" or "show me" is worth the decider's guess.
      if (!step && said && guess) {
        const id = await decided(part, 'Which ZOOD PDF command does the person want?', bookOptions(entries));
        const entry = id ? entries.find((one) => one.id === id) : undefined;
        if (entry) step = stepFor(entry, part);
      }
      if (!step) return false;
      steps.push(step);
    }
    await runBook(said ?? 'do', words, steps, spoken);
    return true;
  };

  /**
   * Settings by their names (`settingsBook.ts`): "turn on dark mode",
   * "غيّر اللغة للإنجليزي", "make the icons bigger", "change the settings".
   * ZOOD PDF's window comes forward with Settings open at the setting, its
   * row lit, and the change made — or, for Show me, left to the person.
   * False when no setting and no Settings page is named.
   */
  const settingsLane = async (words: string, spoken: boolean, unknown = false, forced?: SettingAsk): Promise<boolean> => {
    const said = intentOf(words);
    // "What does night reading do?" is answered, not done.
    if (!unknown && !forced && !said && /[?؟]/.test(words)) return false;
    const language = languageOf(words);
    const asked = forced ?? (unknown ? null : settingAsked(words, true));
    let step: BookStep;
    let named = { name: '', choice: '' };
    if (asked) {
      named = settingWords(asked.entry, asked.value, language);
      step = { id: 'setting', setting: asked.entry.id, value: asked.value, label: named.choice ? `${named.name}: ${named.choice}` : named.name };
    } else {
      const page = unknown ? null : settingsPageAsked(words);
      if (page === undefined) return false;
      step = { id: 'setting', setting: `page:${page ?? 'general'}`, value: null, label: translate(language, 'settings.title') };
    }
    endGuide();
    const turn = (guideTurn.current += 1);
    const live = () => guideTurn.current === turn;
    const mode: Intent = said === 'show' ? 'show' : 'do';
    const talks = shouldTalk(readAskPreferences().talkBack, spoken);
    setPhase({ kind: 'guide', mode, words, say: step.label, step: 1, of: 1, wait: mode === 'show' ? 'click' : 'busy', onlyPoints: false });
    if (talks && mode === 'show') void talk(step.label);
    try {
      // From the tray or another app, ZOOD PDF's window comes first.
      if (await invokeHost('ask_open_editor').catch(() => false)) await sleep(2500);
      if (!live()) return true;
      let done: { ran: boolean; reason?: string };
      if (mode === 'show') {
        const clicked = invokeHost('ask_command', { step, mode: 'show' }).then(
          (answer) => answer as { ran: boolean; reason?: string },
          () => ({ ran: false, reason: 'stopped' }),
        );
        done = await Promise.race([clicked, waitFor().then((choice) => ({ ran: choice === 'next', reason: 'said' }))]);
        void invokeHost('ask_command_stop').catch(() => undefined);
      } else {
        done = (await invokeHost('ask_command', { step, mode: 'do' })) as { ran: boolean; reason?: string };
      }
      if (!live()) return true;
      endGuide();
      if (done.reason === 'said' && !done.ran) return true;
      const vars = { name: named.name, choice: named.choice };
      const say = unknown
        ? translate(language, 'ask.setting.unknown')
        : !asked
          ? translate(language, 'ask.setting.page')
        : !done.ran
          ? translate(language, done.reason === 'hidden' ? 'ask.setting.hidden' : 'ask.setting.failed', vars)
          : mode === 'show' || asked.value === null
            ? translate(language, 'ask.setting.here', vars)
            : translate(language, done.reason === 'same' ? 'ask.setting.same' : 'ask.setting.done', vars);
      sayOnly(words, say, spoken);
    } catch (error) {
      if (!live()) return true;
      endGuide();
      setPhase({ kind: 'problem', ...errorKey(error) });
    }
    return true;
  };

  /** The book's entries now, inside ZOOD PDF; none from another app. */
  const bookNow = async (ours: boolean): Promise<BookEntry[]> =>
    ours ? (((await invokeHost('ask_book').catch(() => null)) as { entries?: BookEntry[] } | null)?.entries ?? []) : [];

  /** Runs what was picked, by its words or by the person's choice. */
  const runPicked = async (picked: Picked, words: string, spoken: boolean) => {
    if (picked.kind === 'book') await runBook(intentOf(words) ?? 'do', words, [picked.step], spoken);
    else await settingsLane(words, spoken, false, picked.ask);
  };

  /**
   * Commands and settings by their words one by one (`fuzzy.ts`): "lock it
   * with a password" is Protect. Done when one is clearly meant; when a few
   * could be, they are offered, and nothing is done until one is chosen.
   * False when none comes close, for the models.
   */
  const fuzzyLane = async (words: string, spoken: boolean, ours: boolean): Promise<boolean> => {
    if (!intentOf(words) && /[?؟]|^(?:what|why|which|who|is|are|does|ما |ماذا|وش |ايش|ليش|لماذا|هل )/i.test(words.trim())) return false;
    // A question about the world ("how many days until Ramadan", «متى العيد») is the model's.
    if (asksTheWorld(words)) return false;
    const entries = await bookNow(ours);
    const sure = fuzzyPick(words, entries, true);
    if (sure) {
      await runPicked(sure, words, spoken);
      return true;
    }
    const offers = fuzzyOffers(words, entries, true);
    if (offers.length === 0) return false;
    const language = languageOf(words);
    aloud(
      sayChoices(
        translate(language, 'ask.pick.title'),
        offers.map((offer) => offerName(offer, language)),
        language,
        translate(language, 'ask.pick.other'),
      ),
      spoken,
    );
    setPhase({ kind: 'pick', words, offers, spoken });
    return true;
  };

  /** What an offer is called on its button, in the language of the request. */
  const offerName = (picked: Picked, language: 'ar' | 'en') => {
    if (picked.kind === 'book') return stepWords(picked.step);
    const { name, choice } = settingWords(picked.ask.entry, picked.ask.value, language);
    return choice ? `${name}: ${choice}` : name;
  };

  /** Runs the book's steps in the editor: one by one, lit; Show me waits for each click. */
  const runBook = async (mode: Intent, words: string, steps: BookStep[], spoken: boolean) => {
    endGuide();
    const turn = (guideTurn.current += 1);
    const live = () => guideTurn.current === turn;
    const language = languageOf(words);
    const talks = shouldTalk(readAskPreferences().talkBack, spoken);
    const show = (say: string, step: number, wait: GuideWait) =>
      live() && setPhase({ kind: 'guide', mode, words, say, step, of: steps.length, wait, onlyPoints: false });
    const finish = (say: string) => {
      if (!live()) return;
      endGuide();
      sayOnly(words, say, spoken);
    };
    try {
      for (const [index, step] of steps.entries()) {
        const say = stepWords(step);
        if (mode === 'do') {
          if (asksFirst(step)) {
            show(say, index + 1, 'confirm');
            if ((await waitFor()) === 'stop' || !live()) return;
          }
          show(say, index + 1, 'busy');
          if (talks) void talk(say);
          const done = (await invokeHost('ask_command', { step, mode: 'do' })) as { ran: boolean; reason?: string };
          if (!live()) return;
          if (!done.ran)
            return finish(bookEnding(done.reason === 'page' ? 'page' : done.reason === 'missing' ? 'missing' : 'disabled', language, { name: say }));
          continue;
        }
        show(say, index + 1, 'click');
        if (talks) void talk(say);
        const clicked = invokeHost('ask_command', { step, mode: 'show' }).then(
          (done) => done as { ran: boolean; reason?: string; menu?: string },
          () => ({ ran: false, reason: 'stopped' }),
        );
        const choice = await Promise.race([clicked, waitFor().then((said) => ({ ran: said === 'next', reason: 'said' }))]);
        void invokeHost('ask_command_stop').catch(() => undefined);
        if (!live()) return;
        if (choice.reason === 'said' && !choice.ran) return;
        if (!choice.ran && choice.reason === 'hidden') {
          // No button on the screen for it (a Mac's menus are the system's): where it is, in words.
          const entry = ((await invokeHost('ask_book').catch(() => null)) as { entries?: BookEntry[] } | null)?.entries?.find(
            (one) => one.id === step.id,
          );
          show(bookEnding('menu', language, { name: say, menu: entry?.menu ?? '' }), index + 1, 'click');
          if ((await waitFor(CLICK_WAITS_MS)) === 'stop' || !live()) return;
        } else if (!choice.ran && choice.reason !== 'said') return finish(bookEnding('missing', language, { name: say }));
        await sleep(300);
      }
      finish(ending('done', language));
    } catch (error) {
      if (!live()) return;
      endGuide();
      setPhase({ kind: 'problem', ...errorKey(error) });
    }
  };

  /**
   * Another app's everyday command by its own shortcut (`shortcuts.ts`):
   * pressed in the app that was in front, with Do it for me on; told, as
   * the keys to press, with it off. Closing a tab asks first.
   */
  const shortcutLane = async (words: string, shortcut: Shortcut, spoken: boolean) => {
    const language = languageOf(words);
    const mac = /mac/i.test(navigator.platform || navigator.userAgent);
    const keys = keysOf(shortcut, mac);
    const name = translate(language, `ask.shortcut.${shortcut}` as TKey);
    if (!readAskPreferences().doForMe) {
      sayOnly(words, translate(language, 'ask.shortcut.tell', { name, keys }), spoken);
      return;
    }
    if (ASKS_FIRST.has(shortcut)) {
      endGuide();
      const turn = (guideTurn.current += 1);
      setPhase({ kind: 'guide', mode: 'do', words, say: name, step: 1, of: 1, wait: 'confirm', onlyPoints: false });
      if ((await waitFor()) === 'stop' || guideTurn.current !== turn) return;
      endGuide();
    }
    await invokeHost('ask_shortcut', { name: shortcut });
    sayOnly(words, translate(language, 'ask.shortcut.done', { name, keys }), spoken);
  };

  /**
   * Other apps, by their buttons' names (`ask/controls.rs`): "click Print",
   * "show me where Share is", "اضغط حفظ ثم إرسال". Each part of the request
   * is matched to a button the window lists, and ZOOD's pointer goes there;
   * Do it for me clicks it, after one Do it for the whole request. False
   * when the first part names no button, for the picture to be read instead.
   */
  const controlsLane = async (words: string, spoken: boolean, how: 'bare' | 'named' | 'guess' = 'guess'): Promise<boolean> => {
    // Bare: a button's name said alone, with no "click" or "show me": only that name, exactly, counts.
    // Named: "click Insert": the first button by its name only. Guess: the decider may pick it.
    const bare = how === 'bare';
    const said = bare ? (intentOf(words) || asksAboutWords(words) ? null : 'do') : intentOf(words);
    if (!said) return false;
    const parts = partsOf(words);
    if (parts.length === 0 || (bare && (parts.length > 1 || parts[0]!.split(' ').length > 4))) return false;
    const read = async () => {
      // Read once a request: the lanes before the guess ask for the same window's buttons.
      if (controlsRead.current && controlsRead.current.asked === asked && Date.now() - controlsRead.current.at < 3000)
        return controlsRead.current.list;
      const list = await readFresh();
      controlsRead.current = { asked, at: Date.now(), list };
      return list;
    };
    const readFresh = async () => {
      // A window that takes too long to list its buttons is looked at instead; a browser that has
      // only begun to list them (its page comes after its first answer) is asked once more.
      const once = () =>
        Promise.race([
          invokeHost('ask_controls').then((found) => (found as Control[] | null) ?? [], () => [] as Control[]),
          sleep(CONTROLS_WAIT_MS).then(() => [] as Control[]),
        ]);
      const first = await once();
      if (first.length >= FEW_CONTROLS) return first;
      await sleep(400);
      const again = await once();
      return again.length > first.length ? again : first;
    };
    const pick = async (part: string, controls: Control[]) => {
      const named = controlNamed(part, controls);
      if (named) return named;
      const key = await decided(part, 'Which button should be clicked?', controlOptions(controls));
      return key === null ? null : (controls[Number(key)] ?? null);
    };
    const controls = await read();
    if (controls.length === 0) return false;
    const first =
      how === 'bare'
        ? controlNamedAlone(parts[0] ?? '', controls)
        : how === 'named'
          ? controlNamed(parts[0] ?? '', controls)
          : await pick(parts[0] ?? '', controls);
    if (!first) return false;
    await runControls(said, words, parts, first, readFresh, pick, spoken);
    return true;
  };

  /** Points at (or clicks) each part's button in turn: see `controlsLane`. */
  const runControls = async (
    said: Intent,
    words: string,
    parts: string[],
    first: Control,
    read: () => Promise<Control[]>,
    pick: (part: string, controls: Control[]) => Promise<Control | null>,
    spoken: boolean,
  ) => {
    endGuide();
    const turn = (guideTurn.current += 1);
    const live = () => guideTurn.current === turn;
    const language = languageOf(words);
    const prefs = readAskPreferences();
    const talks = shouldTalk(prefs.talkBack, spoken);
    const acting = said === 'do' && prefs.doForMe;
    const mode: GuideMode = acting ? 'do' : 'show';
    const show = (say: string, step: number, wait: GuideWait) =>
      live() &&
      setPhase({ kind: 'guide', mode, words, say, step, of: parts.length, wait, onlyPoints: said === 'do' && !acting });
    const finish = (say: string) => {
      if (!live()) return;
      endGuide();
      sayOnly(words, say, spoken);
    };
    try {
      let control: Control | null = first;
      for (const [index, part] of parts.entries()) {
        if (index > 0) {
          await sleep(600);
          control = await pick(part, await read());
        }
        if (!live()) return;
        if (!control) return finish(bookEnding('notFound', language, { name: part }));
        const step = { say: control.name, x: control.x, y: control.y };
        await pointAt(step);
        if (!live()) return;
        if (acting) {
          // Another app: every click asks first. A button's name there is the app's (or a web page's) to choose,
          // so "Continue" may pay or send: no name is trusted to be harmless.
          show(bookEnding('pressIn', language, { name: control.name }), index + 1, 'confirm');
          if ((await waitFor()) === 'stop' || !live()) return;
          show(control.name, index + 1, 'busy');
          if (talks) void talk(control.name);
          await sleep(500);
          let resume = false;
          for (;;) {
            if (!live()) return;
            try {
              await invokeHost('ask_click', { x: control.x, y: control.y, resume, control: true });
              break;
            } catch (error) {
              if (!String(error).includes('E_MOVED')) throw error;
              show(control.name, index + 1, 'paused');
              if ((await waitFor()) === 'stop' || !live()) return;
              resume = true;
            }
          }
          continue;
        }
        show(control.name, index + 1, 'click');
        if (talks) void talk(control.name);
        void invokeHost('ask_watch_clicks', { on: true }).catch(() => undefined);
        const choice = await waitFor(CLICK_WAITS_MS);
        void invokeHost('ask_watch_clicks', { on: false }).catch(() => undefined);
        if (choice === 'stop' || !live()) return choice === 'stop' && live() ? close() : undefined;
      }
      finish(ending('done', language));
    } catch (error) {
      if (!live()) return;
      endGuide();
      setPhase({ kind: 'problem', ...errorKey(error) });
    }
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
    const point = pointAt;
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
    const ear = await readyEar(await machineMemoryGiB()).catch(() => undefined);
    if (!ear) return setPhase({ kind: 'problem', message: 'ask.problem.models' });
    asked += 1;
    const id = `ask-${Date.now()}-${asked}-ear`;
    try {
      setPhase({ kind: 'hearing' });
      request.current = id;
      const words = ((await invokeHost('ask_transcribe', {
          id,
          model: ear.id,
          words: readAskPreferences().words,
        })) as string).trim();
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
      setReadingOut(false);
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
      // The keys again while it waits for typing, from another window.
      onHostEvent('ask://hide', () => closeLater()),
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
      // Last: anything said while this page loaded comes now, to the listeners above.
      announceReady(),
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

  /** The presentation's questions, with the topic already said filled in. */
  const startDeck = (words: string, spoken: boolean) => {
    aloud(translate(languageOf(words), 'ask.deck.ask'), spoken);
    setPhase({ kind: 'deck', words, topic: deckTopic(words), notes: '', size: 8, look: 'zood', working: false });
    // The island takes the keyboard, as it does for typing.
    void invokeHost('ask_type_instead').catch(() => undefined);
  };

  /** Writes the slides with the best model there is, builds the file, saves and opens it. */
  const makeDeck = async (asked: Extract<Phase, { kind: 'deck' }>) => {
    stopSpeaking();
    setPhase({ ...asked, working: true });
    const language = languageOf(`${asked.topic} ${asked.notes}`.trim() || asked.words);
    const id = `ask-deck-${Date.now()}`;
    try {
      const prefs = readAskPreferences();
      const memory = await machineMemoryGiB();
      const model = await writerFor(chosenBrain(prefs, memory), memory);
      request.current = id;
      const done = (await invokeHost('ask_think', {
        request: {
          id,
          model: model.id,
          messages: [
            { role: 'system', content: deckPrompt(asked.size, language) },
            { role: 'user', content: deckRequest(asked.topic, asked.notes, asked.source) },
          ],
          grammar: deckGrammar(asked.size),
          maxTokens: 300 + asked.size * 180,
          contextTokens: 8192,
          screen: false,
        },
      })) as { text: string };
      request.current = null;
      const deck = readDeck(done.text, asked.size);
      if (!deck) return setPhase({ kind: 'problem', message: 'ask.deck.failed' });
      const rtl = language === 'ar';
      const [cover, page] = await Promise.all([drawBackground(asked.look, 'cover', rtl), drawBackground(asked.look, 'page', rtl)]);
      const file = deckFile(deck, asked.look, rtl, (kind) => (kind === 'cover' ? cover : page), canvasMeasure());
      await saveDeck(file, deck.title);
      const say = translate(language, 'ask.deck.done', { title: deck.title, count: deck.slides.length + 1 });
      aloud(say, false);
      setPhase({ kind: 'decked', words: asked.words, say });
    } catch (error) {
      request.current = null;
      setPhase({ kind: 'problem', ...errorKey(error) });
    }
  };

  /** An answer kept as a PDF or a Word file: saved in Documents › ZOOD PDF and opened. */
  const keepAs = async (kind: AnswerFileKind, words: string, answer: string) => {
    stopSpeaking();
    setMaking(kind);
    const language = languageOf(words || answer);
    try {
      const title = answerTitle(words, translate(language, 'ask.file.untitled'));
      const bytes = await answerFile(kind, title, answer, getSharedCoreClient());
      await saveDeck(bytes, title, kind);
      const say = translate(
        language,
        kind === 'pdf' ? 'ask.file.donePdf' : kind === 'xlsx' ? 'ask.file.doneExcel' : 'ask.file.doneWord',
        { title },
      );
      aloud(say, false);
      setPhase({ kind: 'decked', words, say });
    } catch (error) {
      setPhase({ kind: 'problem', ...errorKey(error) });
    } finally {
      setMaking(null);
    }
  };

  /** An answer made a presentation: the deck's questions, with the answer to build it from. */
  const deckFromAnswer = (words: string, answer: string) => {
    stopSpeaking();
    setPhase({
      kind: 'deck',
      words,
      topic: answerTitle(words, ''),
      notes: '',
      size: 5,
      look: 'zood',
      working: false,
      source: answer,
    });
    void invokeHost('ask_type_instead').catch(() => undefined);
  };

  /** "Keep it as": PDF, Word or PowerPoint, under an answer. */
  const fileButtons = (words: string, answer: string) => (
    <div className="ask-keep">
      <span className="ask-detail">{t('ask.file.keepAs')}</span>
      <button type="button" className="ask-cancel" disabled={making !== null} onClick={() => void keepAs('pdf', words, answer)}>
        {making === 'pdf' ? <Loader className="spin" /> : <FileText />} PDF
      </button>
      <button type="button" className="ask-cancel" disabled={making !== null} onClick={() => void keepAs('docx', words, answer)}>
        {making === 'docx' ? <Loader className="spin" /> : <FileType />} Word
      </button>
      <button type="button" className="ask-cancel" disabled={making !== null} onClick={() => void keepAs('xlsx', words, answer)}>
        {making === 'xlsx' ? <Loader className="spin" /> : <FileSpreadsheet />} Excel
      </button>
      <button type="button" className="ask-cancel" disabled={making !== null} onClick={() => deckFromAnswer(words, answer)}>
        <Presentation /> PowerPoint
      </button>
    </div>
  );

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

  /** Reads an answer out, whatever the talk-back setting; pressed again, stops. */
  const readOut = (text: string) => {
    if (readingOut) {
      stopSpeaking();
      setReadingOut(false);
      return;
    }
    setReadingOut(true);
    void talk(text).finally(() => setReadingOut(false));
  };

  /** Copy and Read, under every answer that has words to keep or hear. */
  const answerButtons = (text: string) => (
    <>
      <button type="button" className="ask-cancel" onClick={() => copy(text)}>
        {copied ? <Check /> : <Copy />} {t(copied ? 'ask.copied' : 'ask.copy')}
      </button>
      <button type="button" className="ask-cancel" aria-pressed={readingOut} onClick={() => readOut(text)}>
        {readingOut ? <VolumeX /> : <Volume2 />} {t(readingOut ? 'ask.stopReading' : 'ask.read')}
      </button>
    </>
  );

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
    phase.kind === 'pick' ||
    phase.kind === 'tidy' ||
    phase.kind === 'tidied' ||
    phase.kind === 'thinking' ||
    phase.kind === 'researching' ||
    phase.kind === 'placed' ||
    phase.kind === 'deck' ||
    phase.kind === 'decked'
      ? phase.words
      : '';
  const lang = words ? languageOf(words) : null;
  const busy =
    phase.kind === 'hearing' ||
    phase.kind === 'thinking' ||
    phase.kind === 'researching' ||
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
                  : phase.kind === 'researching'
                  ? t(`ask.web.${phase.step}`, { count: phase.count })
                  : phase.kind === 'reading'
                    ? t('ask.reading')
                    : phase.kind === 'drafting'
                      ? phase.app
                        ? t('ask.draftingIn', { app: phase.app })
                        : t('ask.drafting')
                      : phase.kind === 'placed'
                        ? phase.held
                          ? t('ask.heldTitle')
                          : phase.app
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
              if (
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
          <AnswerText text={phase.decision.text} />
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
            {answerButtons(phase.decision.text)}
          </div>
          {phase.decision.act === 'answer' && fileButtons(phase.words, phase.decision.text)}
        </div>
      )}
      {phase.kind === 'said' && !phase.decision.text && phase.decision.act === 'answer' && phase.decision.say && (
        <div className="ask-actions">{answerButtons(phase.decision.say)}</div>
      )}
      {phase.kind === 'said' && phase.decision.act === 'answer' && asksBack(phase.decision.say) && (
        <div className="ask-actions">
          {offeredSite(phase.words, phase.decision) && (
            <button
              type="button"
              className="ask-do"
              onClick={() => void openSite(phase.words, offeredSite(phase.words, phase.decision)!, false).catch(fail)}
            >
              <Globe /> {t('ask.site.yes', { site: siteName(offeredSite(phase.words, phase.decision)!) })}
            </button>
          )}
          <button type="button" className="ask-cancel" onClick={() => void invokeHost('ask_listen_again').catch(fail)}>
            <Mic /> {t('ask.reply')}
          </button>
        </div>
      )}
      {phase.kind === 'placed' && (
        <div className="ask-plan">
          {phase.say && (
            <p className="ask-say" dir="auto">
              {phase.say}
            </p>
          )}
          {phase.held ? (
            <>
              <p className="ask-say ask-held" dir="auto">
                {phase.text}
              </p>
              <p className="ask-detail">{t(phase.held === 'terminal' ? 'ask.heldTerminal' : 'ask.heldLibrary')}</p>
            </>
          ) : (
            <p className="ask-detail">{t(mac ? 'ask.placedHintMac' : 'ask.placedHint')}</p>
          )}
          <div className="ask-actions">
            {phase.held === 'library' && (
              <button
                type="button"
                className="ask-do"
                onClick={() => {
                  const { held: _held, ...shown } = phase;
                  void invokeHost('ask_paste', { text: phase.text }).then(() => setPhase(shown), fail);
                }}
              >
                <PenLine /> {t('ask.heldPaste')}
              </button>
            )}
            <button
              type="button"
              className="ask-cancel"
              onClick={() => {
                // The draft just pasted is undone first, in the app it went to.
                void (phase.held ? Promise.resolve() : invokeHost('ask_undo')).then(
                  () => (phase.words ? respond(phase.words, false) : draft()),
                  fail,
                );
              }}
            >
              <RotateCcw /> {t('ask.again')}
            </button>
            {answerButtons(phase.text)}
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
      {phase.kind === 'pick' && (
        <div className="ask-plan">
          <p dir={lang === 'ar' ? 'rtl' : 'ltr'}>{translate(lang ?? 'en', 'ask.pick.title')}</p>
          <div className="ask-actions">
            {phase.offers.map((picked) => (
              <button
                key={picked.kind === 'book' ? picked.step.id : picked.ask.entry.id}
                type="button"
                className="ask-do"
                onClick={() => void runPicked(picked, phase.words, phase.spoken)}
              >
                {offerName(picked, lang ?? 'en')}
              </button>
            ))}
            <button type="button" className="ask-cancel" onClick={() => void respond(phase.words, phase.spoken, undefined, true)}>
              {translate(lang ?? 'en', 'ask.pick.other')}
            </button>
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
      {phase.kind === 'deck' && (
        <form
          className="ask-plan ask-deck"
          dir={lang === 'ar' ? 'rtl' : 'ltr'}
          onSubmit={(event) => {
            event.preventDefault();
            if (!phase.working && phase.topic.trim()) void makeDeck(phase);
          }}
        >
          <p className="ask-say">
            <Presentation className="ask-inline-icon" /> {translate(lang ?? 'en', 'ask.deck.ask')}
          </p>
          <label>
            <span>{translate(lang ?? 'en', 'ask.deck.topic')}</span>
            <input
              dir="auto"
              value={phase.topic}
              disabled={phase.working}
              autoFocus
              onChange={(event) => setPhase({ ...phase, topic: event.target.value.slice(0, 200) })}
            />
          </label>
          <label>
            <span>{translate(lang ?? 'en', 'ask.deck.notes')}</span>
            <textarea
              dir="auto"
              rows={2}
              value={phase.notes}
              disabled={phase.working}
              onChange={(event) => setPhase({ ...phase, notes: event.target.value.slice(0, 600) })}
            />
          </label>
          <div className="ask-deck-choices">
            <span>{translate(lang ?? 'en', 'ask.deck.size')}</span>
            {DECK_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                aria-pressed={phase.size === size}
                disabled={phase.working}
                onClick={() => setPhase({ ...phase, size })}
              >
                {size}
              </button>
            ))}
          </div>
          <div className="ask-deck-choices">
            <span>{translate(lang ?? 'en', 'ask.deck.look')}</span>
            {DECK_LOOKS.map((look) => (
              <button
                key={look}
                type="button"
                aria-pressed={phase.look === look}
                disabled={phase.working}
                onClick={() => setPhase({ ...phase, look })}
              >
                {translate(lang ?? 'en', `ask.deck.look.${look}` as TKey)}
              </button>
            ))}
          </div>
          {phase.working && <p className="ask-detail">{translate(lang ?? 'en', 'ask.deck.working')}</p>}
          <div className="ask-actions">
            <button type="submit" className="ask-do" disabled={phase.working || !phase.topic.trim()}>
              {phase.working ? <Loader className="spin" /> : <Check />} {translate(lang ?? 'en', 'ask.deck.make')}
            </button>
            <button type="button" className="ask-cancel" onClick={() => close()}>
              {t('ask.cancel')}
            </button>
          </div>
        </form>
      )}
      {phase.kind === 'decked' && (
        <div className="ask-plan">
          <p className="ask-say" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
            {phase.say}
          </p>
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
