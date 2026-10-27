import { useEffect, useRef, useState } from 'react';
import { Check, Download, Loader, Mic, Sparkles } from 'lucide-react';
import './askSetup.css';
import { Icon } from '../components/Icon';
import { formatBytes, modelBytes } from '../ai/device/models';
import { machineMemoryGiB, useDeviceModel } from '../ai/device/useDeviceModel';
import type { DeviceModelView } from '../ai/device/useDeviceModel';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { downloadNeuralVoice, neuralPacks } from '../speech/neural';
import type { NeuralPack } from '../speech/neural';
import { refreshVoices } from '../speech/readAloud';
import { isolate } from '../signatures/model';
import { noteAskReady } from './ReadyHint';
import { quickModel } from './quick';
import {
  askAccess,
  askAllow,
  chosenBrain,
  configureAsk,
  earFor,
  missingAccess,
  onMac,
  readAskPreferences,
  tapKeyLabel,
  voiceAvailable,
} from './settings';
import type { AskAccess, AskPermission } from './settings';

/**
 * Ask ZOOD's setup in one button: the models it needs are downloaded (the
 * one that hears and the one that decides, both at once), and meanwhile
 * each permission still missing is asked for in turn — the system's own
 * question where it has one, else its Settings at the right list — waiting
 * for each switch before the next. Shown in Settings › AI › Ask ZOOD and in
 * the welcome tour until everything is there; then it says it is ready, and
 * the host is told to listen.
 */

const PERMISSION_LABEL: Record<AskPermission, TKey> = {
  microphone: 'ask.access.microphone',
  input: 'ask.access.input',
  accessibility: 'ask.access.accessibility',
  screen: 'ask.access.screen',
};

/** How often a switch turned on in System Settings is looked for. */
const LOOK_EVERY_MS = 1000;
/** How long one permission is waited for before the setup moves on. */
const WAIT_AT_MOST_MS = 90_000;

function downloading(view: DeviceModelView): boolean {
  return view.status?.kind === 'downloading';
}

function ready(view: DeviceModelView): boolean {
  return view.status?.kind === 'ready';
}

export function AskSetup({ compact = false }: { compact?: boolean }) {
  const { t, lang } = useI18n();
  const [prefs] = useState(readAskPreferences);
  const [memory, setMemory] = useState<number | null>(null);
  const [access, setAccess] = useState<AskAccess | null>(null);
  const [asking, setAsking] = useState<AskPermission | null>(null);
  const [running, setRunning] = useState(false);
  const live = useRef(true);
  const brain = chosenBrain(prefs, memory);
  const voice = voiceAvailable();
  const ear = useDeviceModel(earFor(memory)?.id ?? null);
  const decide = useDeviceModel(brain.id);
  // The quick decider: quick asks answer in about half a second.
  const quick = useDeviceModel(quickModel()?.id ?? null);
  // The natural voice answers are said in: part of the same one click.
  const [voicePack, setVoicePack] = useState<NeuralPack | null>(null);
  const [voiceShare, setVoiceShare] = useState(0);
  const [voiceFailed, setVoiceFailed] = useState(false);
  const talks = voicePack !== null && prefs.talkBack !== 'never';
  const voiceReady = !talks || voicePack.state === 'ready';

  useEffect(() => {
    live.current = true;
    void machineMemoryGiB().then((value) => live.current && setMemory(value));
    void neuralPacks().then((packs) => live.current && setVoicePack(packs[0] ?? null));
    const read = () => void askAccess().then((value) => live.current && setAccess(value));
    read();
    window.addEventListener('focus', read);
    return () => {
      live.current = false;
      window.removeEventListener('focus', read);
    };
  }, []);

  const views = [...(voice ? [ear] : []), decide, ...(quickModel() ? [quick] : [])];
  const missing = missingAccess(access, prefs, Boolean(brain.sees));
  const modelsReady = views.every(ready);
  const done = modelsReady && voiceReady && missing.length === 0;

  // The host listens as soon as the downloads are in, wherever this was
  // pressed (Settings tells it again on its own; the tour has only this).
  useEffect(() => {
    if (!modelsReady || memory === null) return;
    void configureAsk(prefs, memory).then(noteAskReady, () => undefined);
  }, [modelsReady, memory, prefs]);

  const start = async () => {
    setRunning(true);
    for (const view of views) if (!ready(view) && !downloading(view)) view.download();
    if (talks && voicePack.state === 'missing') {
      const pack = voicePack;
      setVoiceFailed(false);
      setVoicePack({ ...pack, state: 'downloading' });
      void downloadNeuralVoice(pack.id, (received, total) => setVoiceShare(total > 0 ? received / total : 0))
        .catch(() => live.current && setVoiceFailed(true))
        .then(() => neuralPacks())
        .then((packs) => {
          refreshVoices();
          if (live.current) setVoicePack(packs.find((one) => one.id === pack.id) ?? null);
        });
    }
    // One permission at a time: the system shows one question at a time.
    for (const kind of missingAccess(await askAccess(), prefs, Boolean(brain.sees))) {
      if (!live.current) return;
      setAsking(kind);
      await askAllow(kind);
      const until = Date.now() + WAIT_AT_MOST_MS;
      for (;;) {
        await new Promise((resolve) => window.setTimeout(resolve, LOOK_EVERY_MS));
        const now = await askAccess();
        if (!live.current) return;
        setAccess(now);
        if (!missingAccess(now, prefs, Boolean(brain.sees)).includes(kind) || Date.now() > until)
          break;
      }
    }
    if (!live.current) return;
    setAsking(null);
    setRunning(false);
  };

  const mac = onMac();
  const tap = isolate(tapKeyLabel(prefs.tapKey, mac, lang === 'ar' ? 'ar' : 'en'));
  const size = views
    .filter((view) => !ready(view))
    .reduce((sum, view) => sum + modelBytes(view.model), talks && !voiceReady ? voicePack.bytes : 0);

  if (done)
    return (
      <p className="ask-setup-done" role="status">
        <Icon of={Check} size={14} />
        {t(voice && prefs.oneTap === 'speak' ? 'ask.setup.readySpeak' : 'ask.setup.ready', { tap })}
      </p>
    );

  return (
    <section
      className={compact ? 'ask-setup is-compact' : 'ask-setup'}
      aria-labelledby="ask-setup-title"
    >
      <div className="ask-setup-head">
        <span className="ask-setup-mark" aria-hidden="true">
          <Icon of={voice ? Mic : Sparkles} size={18} />
        </span>
        <div>
          <p id="ask-setup-title" className="ask-setup-title">
            {t('ask.setup.title')}
          </p>
          <p className="ask-setup-note">
            {t(voice ? 'ask.setup.note' : 'ask.setup.noteTyped', { tap })}
          </p>
        </div>
      </div>
      <ul className="ask-setup-steps">
        {views.map((view) => {
          const status = view.status;
          const state = ready(view) ? 'done' : downloading(view) ? 'busy' : 'todo';
          return (
            <li key={view.model.id} className={`is-${state}`}>
              <StepMark state={state} />
              <span className="ask-setup-step">
                {t(
                  view === ear && voice
                    ? 'ask.setup.hearing'
                    : view === quick
                      ? 'ask.setup.quick'
                      : 'ask.setup.deciding',
                )}
                {status?.kind === 'downloading' && (
                  <progress
                    className="ai-progress"
                    max={status.total || 1}
                    value={status.received}
                  />
                )}
                {view.error && <span className="ask-setup-error">{view.error}</span>}
              </span>
            </li>
          );
        })}
        {talks && (
          <li className={`is-${voiceReady ? 'done' : voicePack.state === 'downloading' ? 'busy' : 'todo'}`}>
            <StepMark state={voiceReady ? 'done' : voicePack.state === 'downloading' ? 'busy' : 'todo'} />
            <span className="ask-setup-step">
              {t('ask.setup.voice')}
              {voicePack.state === 'downloading' && (
                <progress className="ai-progress" max={1} value={voiceShare} />
              )}
              {voiceFailed && <span className="ask-setup-error">{t('ask.setup.voiceFailed')}</span>}
            </span>
          </li>
        )}
        {(access ? missingAccess(access, prefs, Boolean(brain.sees)) : []).map((kind) => (
          <li key={kind} className={asking === kind ? 'is-busy' : 'is-todo'}>
            <StepMark state={asking === kind ? 'busy' : 'todo'} />
            <span className="ask-setup-step">
              {t(PERMISSION_LABEL[kind])}
              {asking === kind && (
                <span className="ask-setup-hint">
                  {t(mac ? 'ask.setup.waitingMac' : 'ask.setup.waitingWindows')}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="ask-setup-actions">
        <button
          type="button"
          className="icon-btn icon-btn-labeled icon-btn-primary"
          disabled={running}
          onClick={() => void start()}
        >
          <Icon
            of={running ? Loader : Download}
            size={14}
            className={running ? 'spin' : undefined}
          />
          {running
            ? t('ask.setup.working')
            : size > 0
              ? t('ask.setup.go', { size: formatBytes(size) })
              : t('ask.setup.goAllow')}
        </button>
      </div>
    </section>
  );
}

function StepMark({ state }: { state: 'done' | 'busy' | 'todo' }) {
  return (
    <span className="ask-setup-mark-small" aria-hidden="true">
      {state === 'done' ? (
        <Icon of={Check} size={12} />
      ) : state === 'busy' ? (
        <Icon of={Loader} size={12} className="spin" />
      ) : null}
    </span>
  );
}
