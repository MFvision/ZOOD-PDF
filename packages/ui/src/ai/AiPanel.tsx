import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, MessageSquarePlus, Settings2, Sparkles, Wrench } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { isTauriHost } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { AiSetup } from './AiSetup';
import { AiTasks } from './AiTasks';
import { ChatView } from './chat/ChatView';
import { keptOnDevice } from './chat/kept';
import { deviceRunner, remoteRunner } from './chat/runner';
import type { Runner } from './chat/runner';
import { forgetKnown, inspect, newChat, readBytes, useConversation } from './chat/store';
import { GENERAL_CHAT, LIBRARY_CHAT } from './chat/across';
import type { FileBasis, Scope, SourceDoc } from './chat/across';
import { hasLibrary, searchLibrary } from './chat/library';
import { useSettings } from '../state/settings';
import { requestPage } from '../home/pendingPage';
import { fileForKey } from '../library/sources';
import { libraryStore } from '../library/store';
import type { Env } from './chat/store';
import { contextTokensFor } from './device/context';
import { DeviceSection } from './device/DeviceSection';
import { deviceEngine } from './device/engine';
import { DEVICE_MODELS, chatModels, deviceModel, modelBytes, shortModelName } from './device/models';
import type { DeviceModel, DeviceModelId } from './device/models';
import { machineMemoryGiB, useDeviceModel } from './device/useDeviceModel';
import { CLAUDE_HOST, localAddress } from './providers';
import { onAiRequest, takeAiRequest } from './request';
import type { AiRequest } from './request';
import { forgetKey, keepKey, loadKey, readSettings, writeSettings } from './store';
import type { AiSettings } from './store';
import './ai.css';
import './chat/chat.css';

type View = 'chat' | 'setup' | 'tasks';

/**
 * The on-device models this machine can run, the better one first: both on
 * a computer with 8 GB or more; the small one alone below that, and in a
 * browser, where the model runs in WebAssembly on the processor.
 */
export function runnableModels(memoryGiB: number | null, inBrowser: boolean): DeviceModel[] {
  if (inBrowser || memoryGiB === null || memoryGiB < 7.5) return [deviceModel('qwen2.5-0.5b')];
  // A larger model that also reads pictures (Ask ZOOD's) chats too, on a
  // machine with the memory for it.
  const larger = chatModels(false)
    .filter((model) => model.projector && model.ramGiB <= memoryGiB + 0.5)
    .sort((a, b) => modelBytes(b) - modelBytes(a));
  return [...larger, deviceModel('qwen2.5-1.5b'), deviceModel('qwen2.5-0.5b')];
}

/**
 * The AI tool: a conversation about the open document. The chat is the
 * panel; which model answers, and the tools whose answers are data (OCR
 * correction, form filling, personal information, tables), are a button
 * away in its header. On this device nothing leaves, so a message is sent
 * as it is typed; for Claude and a local server the first message about a
 * document waits until the person has seen what will go and where, and
 * pressed Send. Nothing is ever written into the PDF.
 */
export function AiPanel() {
  const { t } = useI18n();
  const state = useAppState();
  const services = useServices();
  const dispatch = useAppDispatch();
  const [settings, setSettings] = useState<AiSettings>(readSettings);
  const device = useDeviceModel(settings.deviceModel);
  const [key, setKey] = useState(() => loadKey().key);
  const [remember, setRemember] = useState(() => loadKey().remembered);
  const [storeFailed, setStoreFailed] = useState(false);
  const [view, setView] = useState<View>('chat');
  const [incoming, setIncoming] = useState<AiRequest | null>(() => takeAiRequest());
  // Settings › AI › What the AI can see, and the switch at the top of the chat that changes it for now.
  const appSettings = useSettings();
  // A request from the home screen's "Ask about all my documents" comes with its scope; with no document open, the chat is about anything.
  const [scope, setScope] = useState<Scope>(() => (incoming ? (incoming.scope ?? 'document') : state.view === 'viewer' && state.document ? appSettings.aiScope : 'chat'));
  const [memory, setMemory] = useState<number | null>(null);
  const inBrowser = !isTauriHost();

  useEffect(() => writeSettings(settings), [settings]);
  useEffect(() => {
    let cancelled = false;
    void machineMemoryGiB().then((value) => {
      if (!cancelled) setMemory(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // A request from the home screen's card goes into the chat.
  useEffect(
    () =>
      onAiRequest((request) => {
        takeAiRequest();
        setView('chat');
        // A suggestion about a document is for the document, even from the general chat.
        setScope((current) => request.scope ?? (current === 'chat' ? 'document' : current));
        setIncoming(request);
      }),
    [],
  );

  const [libraryReady, setLibraryReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void hasLibrary().then((ready) => {
      if (alive) setLibraryReady(ready);
    });
    return () => {
      alive = false;
    };
  }, []);

  const documentId = state.document?.id ?? null;
  const documentOpen = state.view === 'viewer' && documentId !== null;
  const hasDocument = documentOpen && state.switching === null;
  const conversationId = scope === 'library' ? LIBRARY_CHAT : scope === 'chat' ? GENERAL_CHAT : documentId;
  const conversation = useConversation(conversationId);

  // The document closed: the chat goes on about anything. A document opened from the general chat: the chat turns to it.
  const openedId = documentOpen ? documentId : null;
  const [lastOpened, setLastOpened] = useState(openedId);
  if (lastOpened !== openedId) {
    setLastOpened(openedId);
    if (openedId === null && (scope === 'document' || scope === 'open')) setScope('chat');
    else if (openedId !== null && lastOpened === null && scope === 'chat' && !incoming) setScope(appSettings.aiScope);
  }

  const address = localAddress(settings.localUrl);
  const provider = settings.provider;
  const runnable = useMemo(() => runnableModels(memory, inBrowser), [memory, inBrowser]);
  const contextTokens = contextTokensFor(memory, inBrowser);
  const missing: TKey | null =
    provider === 'claude' && key.trim().length === 0
      ? 'ai.needKey'
      : provider === 'local' && !address.ok
        ? address.reason === 'notLocal'
          ? 'ai.notLocal'
          : 'ai.invalidUrl'
        : provider === 'local' && settings.localModel.trim().length === 0
          ? 'ai.needModel'
          : provider === 'device' && device.status?.kind !== 'ready'
            ? 'ai.needDeviceModel'
            : null;

  const update = (patch: Partial<AiSettings>) => setSettings((current) => ({ ...current, ...patch }));
  const onKey = (value: string) => {
    setKey(value);
    setStoreFailed(!keepKey(value.trim(), remember));
  };
  const onRemember = (value: boolean) => {
    setRemember(value);
    setStoreFailed(!keepKey(key.trim(), value));
  };
  const onForget = () => {
    forgetKey();
    setKey('');
    setRemember(false);
    setStoreFailed(false);
  };

  const modelId = provider === 'device' ? device.model.id : provider === 'claude' ? settings.claudeModel : settings.localModel.trim();
  const base = address.ok ? address.base : '';
  const makeRunner = useCallback(
    async (sample: string): Promise<Runner> => {
      if (provider === 'device') {
        const engine = await deviceEngine(deviceModel(modelId));
        return deviceRunner(engine, { contextTokens, runtime: await engine.runtime(), sample });
      }
      if (provider === 'claude') return remoteRunner({ provider: 'claude', model: modelId }, key.trim());
      return remoteRunner({ provider: 'local', api: settings.localApi, base, model: modelId }, '');
    },
    [provider, modelId, contextTokens, key, settings.localApi, base],
  );
  // The services are the app's own, new on every render; the chat is given one thing that reads the latest.
  const latest = useRef(services);
  useEffect(() => {
    latest.current = services;
  });
  const env = useMemo<Env>(
    () => ({
      services: {
        get client() {
          return latest.current.client;
        },
        get documentPassword() {
          return latest.current.documentPassword;
        },
        get pendingRedactions() {
          return latest.current.pendingRedactions;
        },
        currentFileBytes: () => latest.current.currentFileBytes(),
      },
      kept: keptOnDevice(),
      makeRunner,
      // Every open tab: the live one as it stands now, the parked ones as they were left.
      openDocuments: async (onPage, signal) => {
        const services = latest.current;
        const read: SourceDoc[] = [];
        for (const tab of services.tabs) {
          if (signal.aborted) break;
          const live = tab.key === services.activeTab;
          const bytes = live ? await services.currentFileBytes() : await tab.parked?.arrayBuffer();
          if (!bytes) continue;
          const doc = await readBytes(services.client, bytes, live ? services.documentPassword : tab.password, onPage, signal).catch(() => null);
          if (doc) read.push({ key: String(tab.key), name: tab.name, doc });
        }
        return read;
      },
      searchLibrary: (query) => searchLibrary(latest.current.client, query),
    }),
    [makeRunner],
  );

  /** A citation of another file: an open tab is brought forward, a Library document opened, at its page. */
  const openSource = useCallback(
    (file: FileBasis, page: number, from: Scope) => {
      void (async () => {
        const services = latest.current;
        if (from === 'open') {
          const key = Number(file.key);
          if (key !== services.activeTab) services.activateTab(key);
          requestPage(page);
          return;
        }
        const meta = await libraryStore().readMeta().catch(() => null);
        const opened = meta ? await fileForKey(meta, file.key).catch(() => null) : null;
        if (!opened) {
          dispatch({ type: 'TOAST', key: 'ai.scope.fileMissing' });
          return;
        }
        // The answer is in the Library's chat, which stays where it is.
        await services.openFile(opened);
        requestPage(page);
      })();
    },
    [dispatch],
  );

  // What is known of the document — its length, whether it is analyzed — is read once for each model.
  const inspected = useRef<string | null>(null);
  const runnerKey = `${provider}|${modelId}|${base}|${contextTokens}`;
  useEffect(() => {
    if (view !== 'chat' || scope !== 'document' || !hasDocument || documentId === null || missing !== null || conversation.busy) return;
    const mark = `${documentId}|${runnerKey}`;
    if (inspected.current === mark) return;
    if (inspected.current !== null) forgetKnown(documentId);
    inspected.current = mark;
    void inspect(documentId, env);
  }, [view, scope, hasDocument, documentId, missing, runnerKey, env, conversation.busy]);

  const taken = useCallback(() => setIncoming(null), []);
  // With the kept analyses gone, the document is looked at afresh on coming back to the chat.
  const keptCleared = () => {
    inspected.current = null;
    if (documentId !== null) forgetKnown(documentId);
  };
  const where =
    provider === 'device'
      ? t('ai.chat.whereDevice')
      : provider === 'claude'
        ? t('ai.chat.whereClaude', { host: CLAUDE_HOST })
        : t('ai.chat.whereLocal', { url: base || settings.localUrl });
  const modelLabel = provider === 'device' ? shortModelName(device.model.name) : modelId;
  const providerLabel = t(provider === 'device' ? 'ai.chat.onDevice' : provider === 'claude' ? 'ai.chat.viaClaude' : 'ai.chat.viaLocal');

  const setup = (
    <>
      {provider === 'device' ? (
        <DeviceSection view={device} showDelete={false} />
      ) : (
        <p className="tool-panel-note">{missing ? t(missing) : ''}</p>
      )}
      <div className="tool-actions">
        <IconButton label={t('ai.chat.openSetup')} icon={<Icon of={Settings2} />} showLabel onClick={() => setView('setup')} />
      </div>
    </>
  );

  return (
    <div className="ai-panel" data-view={view}>
      <header className="ai-head">
        {view === 'chat' ? (
          <>
            <div className="ai-head-title">
              <Icon of={Sparkles} className="ai-head-mark" />
              {provider === 'device' && runnable.length > 1 ? (
                // The larger model is one choice away, where this machine can run it.
                <label className="ai-model">
                  <span className="sr-only">{t('ai.chat.modelAnswering')}</span>
                  <select
                    className="ai-model-select"
                    value={device.model.id}
                    onChange={(event) => update({ deviceModel: (DEVICE_MODELS.find((model) => model.id === event.target.value)?.id ?? null) as DeviceModelId | null })}
                  >
                    {runnable.map((model) => (
                      <option key={model.id} value={model.id}>
                        {shortModelName(model.name)}
                      </option>
                    ))}
                  </select>
                  <span className="ai-model-where">{providerLabel}</span>
                </label>
              ) : (
                <button type="button" className="ai-model ai-model-button" title={t('ai.chat.openSetup')} onClick={() => setView('setup')}>
                  <span className="sr-only">{t('ai.chat.modelAnswering')} </span>
                  <bdi dir="ltr">{modelLabel}</bdi>
                  <span className="ai-model-where">{providerLabel}</span>
                </button>
              )}
            </div>
            <div className="ai-head-actions">
              <IconButton
                label={t('ai.chat.new')}
                icon={<Icon of={MessageSquarePlus} />}
                disabled={conversationId === null || conversation.turns.length === 0}
                onClick={() => conversationId !== null && newChat(conversationId)}
              />
              <IconButton label={t('ai.chat.tools')} icon={<Icon of={Wrench} />} onClick={() => setView('tasks')} />
              <IconButton label={t('ai.chat.openSetup')} icon={<Icon of={Settings2} />} onClick={() => setView('setup')} />
            </div>
          </>
        ) : (
          <>
            <IconButton className="inspector-back" label={t('ai.chat.back')} icon={<Icon of={ChevronLeft} mirror />} onClick={() => setView('chat')} />
            <h3>{t(view === 'setup' ? 'ai.setup.title' : 'ai.tasks.title')}</h3>
          </>
        )}
      </header>
      {view === 'chat' && (
        <ChatView
          documentId={documentId}
          hasDocument={hasDocument}
          currentPage={state.currentPage}
          missing={missing}
          settling={provider === 'device' && device.status === null}
          setup={setup}
          env={env}
          where={where}
          goToPage={services.goToPage}
          openOcr={() => dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'ocr' })}
          incoming={incoming}
          onIncomingTaken={taken}
          onUseDevice={() => update({ provider: 'device' })}
          scope={scope}
          onScope={setScope}
          openCount={hasDocument ? services.tabs.length : 0}
          libraryReady={libraryReady}
          onSource={openSource}
        />
      )}
      {view === 'setup' && (
        <div className="ai-view">
          <AiSetup settings={settings} update={update} device={device} runnable={runnable} apiKey={key} remember={remember} storeFailed={storeFailed} onKey={onKey} onRemember={onRemember} onForget={onForget} onKeptCleared={keptCleared} />
        </div>
      )}
      {/* Kept while the chat is in front: a review half-way through is still there on coming back. */}
      <div className="ai-view" hidden={view !== 'tasks'}>
        <AiTasks settings={settings} apiKey={key} device={device} />
      </div>
    </div>
  );
}
