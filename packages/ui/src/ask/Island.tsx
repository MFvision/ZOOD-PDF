import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Check, FileText, Loader, Mic, MousePointerClick, Search, X } from 'lucide-react';
import '../styles/tokens.css';
import '../styles/looks.css';
import '../styles/appearance.css';
import '../styles/fonts.css';
import './ask.css';
import { searchLibrary } from '../ai/chat/library';
import { machineMemoryGiB } from '../ai/device/useDeviceModel';
import { loadWallet } from '../ai/profile/walletState';
import { targetWords, valueOf } from '../ai/profile/wallet';
import type { Target, WalletProfile } from '../ai/profile/wallet';
import { getSharedCoreClient } from '../core/client';
import { invokeHost, isTauriHost, onHostEvent } from '../core/host-tauri';
import { I18nProvider } from '../i18n/I18nProvider';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { applyAppearance } from '../settings/SettingsEffects';
import { useSettings } from '../state/settings';
import { defaultLook, readPreferences } from '../state/preferences';
import { decisionGrammar, languageOf, readDecision, systemPrompt } from './plan';
import type { AskTool, Decision, Moment } from './plan';
import { chosenBrain, earModels, readAskPreferences } from './settings';
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

type Phase =
  | { kind: 'idle' }
  | { kind: 'listening'; screen: boolean }
  | { kind: 'short' }
  | { kind: 'hearing' }
  | { kind: 'thinking'; words: string; screen: boolean }
  | { kind: 'confirm'; words: string; decision: Decision; profile: WalletProfile | null; files: number }
  | { kind: 'found'; words: string; decision: Decision; hits: Hit[] }
  | { kind: 'said'; words: string; decision: Decision }
  | { kind: 'problem'; message: TKey; detail?: string };

/** How long an answer stays once said, and a list or a question waits. */
const SAID_STAYS_MS = 9000;
const WAITS_MS = 25000;
const SHORT_STAYS_MS = 2600;

let asked = 0;

function errorKey(error: unknown): { message: TKey; detail: string } {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes('E_MODEL_MISSING')) return { message: 'ask.problem.models', detail: '' };
  if (text.includes('E_MIC')) return { message: 'ask.problem.mic', detail: '' };
  if (text.includes('E_CANCELLED')) return { message: 'ask.problem.stopped', detail: '' };
  return { message: 'ask.problem.failed', detail: text.replace(/^E_[A-Z_]+:\s*/, '') };
}

/**
 * Ask ZOOD's island: a small card at the top of the screen while the keys
 * are held and after — listening, what was heard, the answer, and when there
 * is something to do, what it will be with Do it and Cancel. The window is
 * never focused (the host makes it so), so the app the person was in keeps
 * the keyboard and the cursor where details are typed.
 */
function Island() {
  const { t } = useI18n();
  const settings = useSettings();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [level, setLevel] = useState(0);
  const card = useRef<HTMLDivElement | null>(null);
  const request = useRef<string | null>(null);

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
      void invokeHost('ask_resize', { height: Math.ceil(node.getBoundingClientRect().height) + 24 }).catch(() => undefined);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const close = () => {
    stopSpeaking();
    if (request.current) void invokeHost('ai_cancel', { id: request.current }).catch(() => undefined);
    request.current = null;
    setPhase({ kind: 'idle' });
    void invokeHost('ask_hide').catch(() => undefined);
  };
  const closeLater = useEffectEvent(close);

  // An answer goes by itself after a while; a question waits longer.
  useEffect(() => {
    const stays = phase.kind === 'said' ? SAID_STAYS_MS : phase.kind === 'short' ? SHORT_STAYS_MS : phase.kind === 'confirm' || phase.kind === 'found' || phase.kind === 'problem' ? WAITS_MS : 0;
    if (!stays) return;
    const timer = window.setTimeout(() => closeLater(), stays);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const answer = useEffectEvent(async () => {
    const prefs = readAskPreferences();
    const ear = earModels()[0];
    if (!ear) return setPhase({ kind: 'problem', message: 'ask.problem.models' });
    const brain = chosenBrain(prefs, await machineMemoryGiB());
    asked += 1;
    const id = `ask-${Date.now()}-${asked}`;
    try {
      setPhase({ kind: 'hearing' });
      request.current = `${id}-ear`;
      const words = ((await invokeHost('ask_transcribe', { id: `${id}-ear`, model: ear.id })) as string).trim();
      if (!words) return setPhase({ kind: 'problem', message: 'ask.problem.notHeard' });
      const moment = (await invokeHost('ask_moment')) as { files: string[]; screen: boolean };
      const wallet = await loadWallet(t('wallet.me')).catch(() => null);
      const context: Moment = { files: moment.files, screen: moment.screen && Boolean(brain.sees), profiles: wallet?.profiles ?? [] };
      setPhase({ kind: 'thinking', words, screen: context.screen });
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
          maxTokens: 320,
          contextTokens: context.screen ? 8192 : 4096,
          screen: context.screen,
        },
      })) as { text: string };
      request.current = null;
      const decision = readDecision(done.text, context) ?? { say: t(languageOf(words) === 'ar' ? 'ask.notUnderstoodAr' : 'ask.notUnderstoodEn'), act: 'answer', tool: null, query: '', fields: [], profile: '', x: -1, y: -1 };
      speak(decision.say);
      if (decision.act === 'tool') return setPhase({ kind: 'confirm', words, decision, profile: null, files: moment.files.length });
      if (decision.act === 'fill') {
        const profile = context.profiles.find((one) => one.name === decision.profile) ?? context.profiles[0] ?? null;
        return setPhase({ kind: 'confirm', words, decision, profile, files: 0 });
      }
      if (decision.act === 'find') {
        const hits = await searchLibrary(getSharedCoreClient(), decision.query).catch(() => []);
        const seen = new Set<string>();
        const files = hits.filter((hit) => !seen.has(hit.key) && seen.add(hit.key)).slice(0, 5);
        return setPhase({ kind: 'found', words, decision, hits: files });
      }
      if (decision.act === 'point') await invokeHost('ask_point', { x: decision.x, y: decision.y, label: decision.say }).catch(() => undefined);
      setPhase({ kind: 'said', words, decision });
    } catch (error) {
      request.current = null;
      const { message, detail } = errorKey(error);
      setPhase({ kind: 'problem', message, detail });
    }
  });

  useEffect(() => {
    const stops = [
      onHostEvent<{ screen: boolean }>('ask://listen', (payload) => {
        stopSpeaking();
        if (request.current) void invokeHost('ai_cancel', { id: request.current }).catch(() => undefined);
        request.current = null;
        setLevel(0);
        setPhase({ kind: 'listening', screen: payload.screen });
      }),
      onHostEvent<number>('ask://level', (value) => setLevel((before) => before * 0.4 + value * 0.6)),
      onHostEvent<{ seconds: number; short: boolean; problem?: string }>('ask://heard', (heard) => {
        if (heard.problem) return setPhase({ kind: 'problem', message: 'ask.problem.mic', detail: heard.problem.replace(/^E_[A-Z_]+:\s*/, '') });
        if (heard.short) return setPhase({ kind: 'short' });
        void answer();
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);

  const doIt = (decision: Decision, profile: WalletProfile | null) => {
    stopSpeaking();
    if (decision.act === 'tool' && decision.tool) {
      void invokeHost('ask_run_tool', { tool: decision.tool }).then(
        () => setPhase({ kind: 'idle' }),
        (error: unknown) => setPhase({ kind: 'problem', ...errorKey(error) }),
      );
    } else if (decision.act === 'fill' && profile) {
      const parts = decision.fields.map((field) => valueOf(profile, field));
      void invokeHost('ask_type', { parts }).then(
        () => setPhase({ kind: 'idle' }),
        (error: unknown) => setPhase({ kind: 'problem', ...errorKey(error) }),
      );
    }
  };

  const lang = phase.kind === 'confirm' || phase.kind === 'found' || phase.kind === 'said' || phase.kind === 'thinking' ? languageOf(phase.words) : null;

  return (
    <div className={`ask-island ask-${phase.kind}`} ref={card} role="status" aria-live="polite" hidden={phase.kind === 'idle'}>
      <div className="ask-head">
        <span className="ask-orb" style={{ '--level': phase.kind === 'listening' ? level : 0 } as React.CSSProperties} aria-hidden="true">
          {phase.kind === 'hearing' || phase.kind === 'thinking' ? <Loader className="spin" /> : <Mic />}
        </span>
        <span className="ask-title">
          {phase.kind === 'listening'
            ? t(phase.screen ? 'ask.listeningScreen' : 'ask.listening')
            : phase.kind === 'short'
              ? t('ask.holdToTalk')
              : phase.kind === 'hearing'
                ? t('ask.hearing')
                : phase.kind === 'thinking'
                  ? t(phase.screen ? 'ask.lookingAndThinking' : 'ask.thinking')
                  : phase.kind === 'problem'
                    ? t(phase.message)
                    : t('ask.settings.title')}
        </span>
        <button type="button" className="ask-close" aria-label={t('ask.close')} onClick={() => close()}>
          <X />
        </button>
      </div>
      {phase.kind === 'problem' && phase.detail && <p className="ask-detail">{phase.detail}</p>}
      {(phase.kind === 'thinking' || phase.kind === 'confirm' || phase.kind === 'found' || phase.kind === 'said') && (
        <p className="ask-words" dir="auto">
          {languageOf(phase.words) === 'ar' ? `«${phase.words}»` : `“${phase.words}”`}
        </p>
      )}
      {(phase.kind === 'confirm' || phase.kind === 'found' || phase.kind === 'said') && phase.decision.say && (
        <p className="ask-say" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
          {phase.kind === 'said' && phase.decision.act === 'point' && <MousePointerClick className="ask-inline-icon" />}
          {phase.decision.say}
        </p>
      )}
      {phase.kind === 'confirm' && phase.decision.act === 'tool' && phase.decision.tool && (
        <div className="ask-plan">
          <p>{t('ask.planTool', { tool: t(TOOL_NAME[phase.decision.tool]), count: phase.files })}</p>
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
            <button type="button" className="ask-do" onClick={() => doIt(phase.decision, phase.profile)}>
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
              <Search className="ask-inline-icon" /> {t('ask.foundNone', { query: phase.decision.query })}
            </p>
          ) : (
            <ul className="ask-hits">
              {phase.hits.map((hit) => (
                <li key={hit.key}>
                  <button type="button" onClick={() => void invokeHost('ask_open', { path: hit.key }).then(() => setPhase({ kind: 'idle' }), (error: unknown) => setPhase({ kind: 'problem', ...errorKey(error) }))}>
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
