import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, FileSearch, Loader, Send, Sparkles, Square, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useI18n } from '../i18n/useT';
import type { Lang, TKey, TParams } from '../i18n/messages';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { budgetFor, formatPages, pageRange, takeWithinBudget } from './budget';
import type { TaskKind } from './budget';
import { splitCitations } from './citations';
import { preflightFor } from './preflight';
import type { Preflight, ProviderSettings } from './preflight';
import { answersWithData } from './prompt';
import type { AiTask } from './prompt';
import { CLAUDE_MODELS, LOCAL_ALLOWED_ORIGINS, PROVIDERS, localAddress } from './providers';
import type { Answer, Failure, LocalApi, ProviderId } from './providers';
import { readDocument } from './readDocument';
import { DeviceSection } from './device/DeviceSection';
import { generateOnDevice } from './device/generate';
import { needsRetrieval, retrievePassages } from './device/retrieval';
import { useDeviceModel } from './device/useDeviceModel';
import { profileDetails, profileIsEmpty } from './profile/profile';
import { useProfile } from './profile/ProfileEditor';
import { onAiRequest, takeAiRequest } from './request';
import type { AiRequest } from './request';
import { send } from './send';
import { forgetKey, keepKey, loadKey, readSettings, writeSettings } from './store';
import type { AiSettings } from './store';
import { fillableFields } from './extras/formFill';
import type { FillField } from './extras/formFill';
import { pageText } from './extras/ocrFix';
import type { LayerText } from './extras/ocrFix';
import type { PiiFinding } from './extras/pii';
import { forgetProfile, keepProfile, loadProfile } from './extras/profile';
import { FormFillReview, OcrFixReview, PiiReview, TablesReview, findWithPatterns } from './extras/Reviews';
import { findTablesOnDevice } from './extras/tables';
import type { Table } from './extras/tables';
import { layerWords } from '../ocr/layer';
import type { FormModel } from '../forms/formTypes';
import type { TextLineData } from '../core/types';
import './ai.css';

type Message = { key: TKey; params?: TParams };

const numbers = new Intl.NumberFormat('en-US');

const PROVIDER_LABEL: Record<ProviderId, TKey> = { device: 'ai.device', claude: 'ai.claude', local: 'ai.local' };

/**
 * The whole document is read for the on-device model, whatever its length,
 * so the passages that answer a question can be chosen from all of it —
 * within a bound no document of a person's reaches.
 */
const READ_ALL = 2_000_000;

const TASKS: Record<TaskKind, TKey> = {
  summarize: 'ai.summarize',
  ask: 'ai.ask',
  translate: 'ai.translate',
  fixOcr: 'ai.fixOcr',
  fill: 'ai.fill',
  pii: 'ai.pii',
  tables: 'ai.tables',
};

/** What a data task read to build its request, kept for reviewing the answer. */
interface Extra {
  layer?: LayerText[];
  fields?: FillField[];
  name?: string;
}

function failureMessage(failure: Failure, provider: ProviderId): Message {
  switch (failure.kind) {
    case 'key':
      return { key: 'ai.keyRejected' };
    case 'rate':
      return { key: 'ai.rate' };
    case 'busy':
      return { key: 'ai.busy' };
    case 'billing':
      return { key: 'ai.billing' };
    case 'denied':
      return { key: 'ai.denied' };
    case 'model':
      return {
        key: provider === 'claude' ? 'ai.modelMissingClaude' : 'ai.modelMissingLocal',
        params: { model: failure.model },
      };
    case 'tooLarge':
      return { key: 'ai.tooLarge' };
    case 'server':
      return { key: 'ai.server', params: { status: failure.status } };
    case 'other':
      return { key: 'ai.other', params: { status: failure.status, message: failure.message } };
    case 'offline':
      return { key: 'ai.offline', params: { host: failure.host } };
    case 'localDown':
      return { key: 'ai.localDown', params: { url: failure.url } };
    case 'blocked':
      return {
        key: provider === 'claude' ? 'ai.blockedClaude' : 'ai.blockedLocal',
        params: { url: failure.url },
      };
    case 'empty':
      return { key: 'ai.empty' };
    case 'cancelled':
      return { key: 'ai.cancelled' };
    case 'modelMissing':
      return { key: 'ai.modelMissing' };
    case 'device':
      return { key: 'ai.deviceFailed', params: { message: failure.message } };
  }
}

/** What came back, and from where; kept with the document it is about. */
interface Result {
  documentId: number;
  answer: Answer;
  model: string;
  pages: number[];
  pageCount: number;
  task: AiTask;
  extra: Extra;
}

/**
 * The AI tool. Nothing leaves the device until the person has seen, in the
 * preflight, the provider and model, where the text goes, which pages and how
 * many characters — and then pressed the Send button under it. Reading the
 * document to build that preflight happens here, on this device. The answer
 * is shown in the panel and never written into the PDF.
 */
export function AiPanel() {
  const { t, lang, dir } = useI18n();
  const state = useAppState();
  const services = useServices();
  const dispatch = useAppDispatch();
  const [settings, setSettings] = useState<AiSettings>(readSettings);
  // The on-device model for this machine, and the person's saved details.
  const device = useDeviceModel(settings.deviceModel);
  const { profile, reload: reloadProfile } = useProfile();
  const [key, setKey] = useState(() => loadKey().key);
  const [remember, setRemember] = useState(() => loadKey().remembered);
  const [storeFailed, setStoreFailed] = useState(false);
  const [task, setTask] = useState<TaskKind>('summarize');
  const [question, setQuestion] = useState('');
  const [translateTo, setTranslateTo] = useState<Lang>(lang);
  const [scope, setScope] = useState<'current' | 'range'>('current');
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState('1');
  const [reading, setReading] = useState<number | null>(null);
  const [notice, setNotice] = useState<Message | null>(null);
  const [preflight, setPreflight] = useState<(Preflight & { documentId: number; extra: Extra }) | null>(null);
  const [details, setDetails] = useState(() => loadProfile().text);
  const [rememberDetails, setRememberDetails] = useState(() => loadProfile().remembered);
  const [local, setLocal] = useState<{ documentId: number; findings: PiiFinding[] } | null>(null);
  const [finding, setFinding] = useState(false);
  const [localTables, setLocalTables] = useState<{ documentId: number; tables: Table[] } | null>(null);
  const [showText, setShowText] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<{ failure: Failure; provider: ProviderId } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  /** The answer as it streams in, and whether the model is still thinking before it. */
  const [partial, setPartial] = useState<{ text: string; thinking: boolean } | null>(null);
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const abortRef = useRef<AbortController | null>(null);
  // Bumped by every change of what would be sent, so a review still reading
  // when the person changed their mind does not show the old choice as current.
  const generation = useRef(0);
  const preflightId = useId();
  const answerId = useId();

  useEffect(() => writeSettings(settings), [settings]);
  // A request from the home screen's chips chooses the action and fills in
  // the question — no more: what would be sent is still reviewed here, and
  // sent only from the Send button.
  useEffect(() => {
    const apply = (request: AiRequest) => {
      setTask(request.task);
      if (request.question !== undefined) setQuestion(request.question);
      if (request.to) setTranslateTo(request.to);
      generation.current += 1;
      setPreflight(null);
      setNotice(null);
      setFailure(null);
      setShowText(false);
    };
    const first = takeAiRequest();
    if (first) apply(first);
    return onAiRequest(apply);
  }, []);
  // Leaving the panel stops waiting for an answer nobody will see.
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (copied !== 'yes') return;
    const timer = setTimeout(() => setCopied('no'), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  // In Arabic text a range such as 1–2 reads backwards unless it is isolated as left-to-right.
  const pageList = (pages: readonly number[]) =>
    dir === 'rtl' ? `\u2066${formatPages(pages)}\u2069` : formatPages(pages);

  const documentId = state.document?.id ?? null;
  const pageCount = state.document?.pageCount ?? 0;
  const documentOpen = state.view === 'viewer' && documentId !== null;
  const hasDocument = documentOpen && state.switching === null;
  // A preflight or answer belongs to the document it was made from.
  const shownPreflight = preflight && preflight.documentId === documentId ? preflight : null;
  const shownResult = result && result.documentId === documentId ? result : null;

  const address = localAddress(settings.localUrl);
  const claude = settings.provider === 'claude';
  const onDevice = settings.provider === 'device';
  const localServer = settings.provider === 'local';
  const addressProblem: TKey | null =
    !localServer || address.ok ? null : address.reason === 'notLocal' ? 'ai.notLocal' : 'ai.invalidUrl';
  const otherPort =
    localServer &&
    address.ok &&
    !(LOCAL_ALLOWED_ORIGINS as readonly string[]).includes(new URL(address.base).origin);
  // The saved details, as smart fill sends them, before anything typed here.
  const savedDetails = profile && !profileIsEmpty(profile) ? profileDetails(profile, lang) : '';
  const allDetails = [savedDetails, details.trim()].filter(Boolean).join('\n');
  const missing: TKey | null =
    claude && key.trim().length === 0
      ? 'ai.needKey'
      : localServer && settings.localModel.trim().length === 0
        ? 'ai.needModel'
        : onDevice && device.status?.kind !== 'ready'
          ? 'ai.needDeviceModel'
          : task === 'ask' && question.trim().length === 0
            ? 'ai.needQuestion'
            : task === 'fill' && allDetails.length === 0
              ? 'ai.fill.needDetails'
              : null;
  const canReview =
    hasDocument && missing === null && addressProblem === null && reading === null && !sending;

  /** Any change of what would be sent makes the preflight, and what went wrong with it, stale. */
  const changed = () => {
    generation.current += 1;
    setPreflight(null);
    setNotice(null);
    setFailure(null);
    setShowText(false);
  };
  const update = (patch: Partial<AiSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
    changed();
  };

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

  // Personal information by Warraq's own patterns: on this device, nothing sent.
  const findLocal = async () => {
    if (documentId === null) return;
    setFinding(true);
    setNotice(null);
    try {
      setLocal({ documentId, findings: await findWithPatterns(services) });
    } catch {
      setNotice({ key: 'ai.pii.failed' });
    } finally {
      setFinding(false);
    }
  };

  // Tables by Warraq's own detection (the Excel export's): on this device, nothing sent.
  const findTablesLocally = async () => {
    if (documentId === null) return;
    setFinding(true);
    setNotice(null);
    try {
      const bytes = await services.currentFileBytes();
      if (!bytes) throw new Error('E_NOT_FOUND: no open file');
      const current = state.currentPage;
      const pages = scope === 'current' ? pageRange(current, current, pageCount) : pageRange(Number(from) || 1, Number(to) || 1, pageCount);
      setLocalTables({ documentId, tables: await findTablesOnDevice(services.client, bytes, services.documentPassword, pages) });
    } catch {
      setNotice({ key: 'ai.tables.failed' });
    } finally {
      setFinding(false);
    }
  };

  const review = async () => {
    if (!canReview || documentId === null) return;
    let target: ProviderSettings;
    if (onDevice) target = { provider: 'device', model: device.model.id, runtime: device.runtime ?? 'cpu' };
    else if (claude) target = { provider: 'claude', model: settings.claudeModel };
    else if (address.ok)
      target = {
        provider: 'local',
        api: settings.localApi,
        base: address.base,
        model: settings.localModel.trim(),
      };
    else return;
    const aiTask: AiTask =
      task === 'ask'
        ? { kind: 'ask', question }
        : task === 'translate'
          ? { kind: 'translate', to: translateTo }
          : task === 'fixOcr' || task === 'pii' || task === 'tables'
            ? { kind: task }
            : task === 'fill'
              ? { kind: 'fill', fields: [], details: allDetails }
              : { kind: 'summarize' };
    const budget = budgetFor(target.provider, task);
    const current = state.currentPage;
    const pagesOf = (count: number) =>
      task !== 'translate' && task !== 'tables'
        ? pageRange(1, count, count)
        : scope === 'current'
          ? pageRange(current, current, count)
          : pageRange(Number(from) || 1, Number(to) || 1, count);
    setPreflight(null);
    setResult(null);
    setFailure(null);
    setNotice(null);
    setShowText(false);
    setReading(0);
    const ticket = generation.current;
    try {
      // Marked but not applied, a redaction still leaves its text in the file.
      if (services.pendingRedactions > 0) {
        setNotice({ key: 'ai.redactPending' });
        return;
      }
      const extra: Extra = { name: state.document?.name ?? 'document.pdf' };
      let read: Awaited<ReturnType<typeof readDocument>>;
      let passages = false;
      if (aiTask.kind === 'fixOcr') {
        // The words Scan & OCR wrote, as kept with their pages.
        const bytes = await services.currentFileBytes();
        const layer = bytes ? await layerWords(services.client, bytes, services.documentPassword) : [];
        if (ticket !== generation.current) return;
        if (layer.length === 0) {
          setNotice({ key: 'ai.fix.noLayer' });
          return;
        }
        extra.layer = layer.map((page) => ({ page: page.index + 1, angle: page.angle, words: page.words }));
        const texts = new Map(extra.layer.map((page) => [page.page, pageText(page.words)]));
        const budgeted = await takeWithinBudget([...texts.keys()], budget, async (page) => texts.get(page) ?? '');
        read = { pageCount, budgeted };
      } else if (aiTask.kind === 'fill') {
        // The form's fields, and the words beside each one on its page.
        const bytes = await services.currentFileBytes();
        if (!bytes) throw new Error('E_NOT_FOUND: no open file');
        const { result: model } = await services.client.callStatic<FormModel>('forms.inspect', { password: services.documentPassword ?? null }, [bytes.slice(0)]);
        const doc = await services.client.open(bytes, services.documentPassword);
        const lines = new Map<number, TextLineData[]>();
        try {
          for (const page of new Set(model.fields.flatMap((field) => field.widgets.map((w) => w.page)))) {
            if (page >= 0 && page < doc.pageCount) lines.set(page, await doc.text_lines(page));
          }
        } finally {
          void doc.free();
        }
        if (ticket !== generation.current) return;
        const fields = fillableFields(model, (page) => lines.get(page) ?? []);
        if (fields.length === 0) {
          setNotice({ key: 'ai.fill.noFields' });
          return;
        }
        extra.fields = fields;
        aiTask.fields = fields;
        read = { pageCount, budgeted: { sent: [], left: [], characters: 0 } };
      } else if (target.provider === 'device' && aiTask.kind === 'ask') {
        // A question for the small model: the whole document is read here,
        // and when it does not fit its window, the passages that answer the
        // question go instead of whole pages (`device/retrieval.ts`).
        read = await readDocument(services, pagesOf, READ_ALL, setReading);
        if (ticket !== generation.current) return;
        if (read && needsRetrieval(read.budgeted.sent, budget)) {
          const found = await retrievePassages(services.client, read.budgeted.sent, aiTask.question, budget);
          if (ticket !== generation.current) return;
          read = { pageCount: read.pageCount, budgeted: { sent: found.passages, left: [], characters: found.characters } };
          passages = true;
        }
      } else {
        read = await readDocument(services, pagesOf, budget, setReading);
      }
      if (ticket !== generation.current) return;
      if (!read) {
        setNotice({ key: 'ai.readFailed' });
        return;
      }
      const next = preflightFor(target, aiTask, read.budgeted, {
        lang,
        pageCount: read.pageCount,
        budget,
        passages,
      });
      if (next.pages.length === 0 && next.left.length > 0) {
        setNotice({
          key: 'ai.nothingFits',
          params: { page: next.left[0] ?? 1, budget: numbers.format(budget) },
        });
      } else if (next.empty) {
        setNotice({ key: 'ai.noText' });
      } else {
        setPreflight({ ...next, documentId, extra });
      }
    } catch {
      setNotice({ key: 'ai.readFailed' });
    } finally {
      setReading(null);
    }
  };

  const go = async () => {
    if (!shownPreflight || sending) return;
    const sent = shownPreflight;
    const controller = new AbortController();
    abortRef.current = controller;
    setSending(true);
    setFailure(null);
    setPartial({ text: '', thinking: false });
    // On this device the model runs in the app; the others are one request.
    const outcome =
      sent.settings.provider === 'device'
        ? await generateOnDevice(sent, controller.signal, { onText: (text) => setPartial({ text, thinking: false }) })
        : await send(sent, key.trim(), controller.signal, {
            onText: (text, thinking) => setPartial({ text, thinking }),
          });
    if (abortRef.current === controller) abortRef.current = null;
    setSending(false);
    setPartial(null);
    if (outcome.ok) {
      setResult({
        documentId: sent.documentId,
        answer: outcome.answer,
        model: sent.settings.model,
        pages: sent.pages,
        pageCount: sent.pageCount,
        task: sent.task,
        extra: sent.extra,
      });
      setCopied('no');
      setPreflight(null);
    } else {
      setFailure({ failure: outcome.failure, provider: sent.settings.provider });
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
  };

  const failed = failure ? failureMessage(failure.failure, failure.provider) : null;

  return (
    <div className="tool-panel ai-panel">
      <h3>
        <Icon of={Sparkles} />
        {t('tool.ai')}
      </h3>
      <p className="tool-panel-note">{t('ai.intro')}</p>

      <fieldset className="ai-group">
        <legend>{t('ai.provider')}</legend>
        {PROVIDERS.map((provider) => (
          <label key={provider} className="ai-choice">
            <input
              type="radio"
              name="ai-provider"
              checked={settings.provider === provider}
              onChange={() => update({ provider })}
            />
            {t(PROVIDER_LABEL[provider])}
          </label>
        ))}
      </fieldset>

      {onDevice ? (
        <DeviceSection view={device} showDelete={false} />
      ) : claude ? (
        <div className="ai-group">
          <label className="field">
            <span>{t('ai.key')}</span>
            <input
              className="text-input"
              type="password"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(event) => onKey(event.target.value)}
            />
          </label>
          <label className="ai-choice">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => onRemember(event.target.checked)}
            />
            {t('ai.remember')}
          </label>
          <p className="tool-panel-note">{t('ai.rememberNote')}</p>
          {storeFailed && <p className="tool-panel-note">{t('ai.rememberFailed')}</p>}
          <div className="tool-actions">
            <IconButton
              label={t('ai.forget')}
              icon={<Icon of={X} />}
              showLabel
              disabled={key.length === 0 && !remember}
              onClick={onForget}
            />
          </div>
          <label className="field">
            <span>{t('ai.model')}</span>
            <select
              className="select"
              dir="ltr"
              value={settings.claudeModel}
              onChange={(event) => update({ claudeModel: event.target.value })}
            >
              {CLAUDE_MODELS.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <p className="tool-panel-note">{t('ai.claudeNote')}</p>
        </div>
      ) : (
        <div className="ai-group">
          <p className="tool-panel-note">{t('ai.localNote')}</p>
          <label className="field">
            <span>{t('ai.localUrl')}</span>
            <input
              className="text-input"
              dir="ltr"
              spellCheck={false}
              value={settings.localUrl}
              onChange={(event) => update({ localUrl: event.target.value })}
            />
          </label>
          {addressProblem && <p className="field-error">{t(addressProblem)}</p>}
          {otherPort && <p className="tool-panel-note">{t('ai.portNote')}</p>}
          <label className="field">
            <span>{t('ai.localApi')}</span>
            <select
              className="select"
              value={settings.localApi}
              onChange={(event) => update({ localApi: event.target.value as LocalApi })}
            >
              <option value="ollama">{t('ai.apiOllama')}</option>
              <option value="openai">{t('ai.apiOpenai')}</option>
            </select>
          </label>
          {settings.localApi === 'openai' && (
            <p className="tool-panel-note">{t('ai.openaiNote')}</p>
          )}
          <label className="field">
            <span>{t('ai.localModel')}</span>
            <input
              className="text-input"
              dir="ltr"
              spellCheck={false}
              value={settings.localModel}
              onChange={(event) => update({ localModel: event.target.value })}
            />
          </label>
        </div>
      )}

      <fieldset className="ai-group">
        <legend>{t('ai.action')}</legend>
        {(Object.keys(TASKS) as TaskKind[]).map((kind) => (
          <label key={kind} className="ai-choice">
            <input
              type="radio"
              name="ai-task"
              checked={task === kind}
              onChange={() => {
                setTask(kind);
                changed();
              }}
            />
            {t(TASKS[kind])}
          </label>
        ))}
      </fieldset>

      {task === 'ask' && (
        <label className="field">
          <span>{t('ai.question')}</span>
          <textarea
            className="text-input ai-question"
            dir="auto"
            rows={3}
            maxLength={2000}
            value={question}
            onChange={(event) => {
              setQuestion(event.target.value);
              changed();
            }}
          />
        </label>
      )}

      {task === 'fill' && (
        <div className="ai-group">
          {/* The saved details first (Settings keeps them encrypted); anything more is typed here. */}
          <p className="tool-panel-note" data-profile={savedDetails ? 'saved' : 'empty'}>
            {savedDetails ? t('ai.fill.profileSaved', { count: savedDetails.split('\n').length }) : t('ai.fill.profileEmpty')}
          </p>
          <div className="tool-actions">
            <IconButton
              label={t('ai.fill.editProfile')}
              icon={<Icon of={FileSearch} />}
              showLabel
              onClick={() => {
                dispatch({ type: 'DIALOG', dialog: 'settings' });
                // When the sheet closes, the details it saved are read again.
                const again = () => {
                  void reloadProfile();
                  changed();
                  globalThis.document?.removeEventListener('close', again, true);
                };
                globalThis.document?.addEventListener('close', again, true);
              }}
            />
          </div>
          <label className="field">
            <span>{t('ai.fill.details')}</span>
            <textarea
              className="text-input ai-question"
              dir="auto"
              rows={5}
              maxLength={4000}
              value={details}
              onChange={(event) => {
                setDetails(event.target.value);
                keepProfile(event.target.value, rememberDetails);
                changed();
              }}
            />
          </label>
          <label className="ai-choice">
            <input
              type="checkbox"
              checked={rememberDetails}
              onChange={(event) => {
                setRememberDetails(event.target.checked);
                keepProfile(details, event.target.checked);
              }}
            />
            {t('ai.fill.remember')}
          </label>
          <p className="tool-panel-note">{t('ai.fill.detailsNote')}</p>
          <div className="tool-actions">
            <IconButton
              label={t('ai.fill.forget')}
              icon={<Icon of={X} />}
              showLabel
              disabled={details.length === 0 && !rememberDetails}
              onClick={() => {
                forgetProfile();
                setDetails('');
                setRememberDetails(false);
                changed();
              }}
            />
          </div>
        </div>
      )}

      {(task === 'translate' || task === 'tables') && (
        <div className="ai-group">
          {task === 'translate' && (
            <label className="field">
              <span>{t('ai.direction')}</span>
              <select
                className="select"
                value={translateTo}
                onChange={(event) => {
                  setTranslateTo(event.target.value as Lang);
                  changed();
                }}
              >
                <option value="en">{t('ai.toEnglish')}</option>
                <option value="ar">{t('ai.toArabic')}</option>
              </select>
            </label>
          )}
          <fieldset className="ai-group">
            <legend>{t('ai.pages')}</legend>
            <label className="ai-choice">
              <input
                type="radio"
                name="ai-scope"
                checked={scope === 'current'}
                onChange={() => {
                  setScope('current');
                  changed();
                }}
              />
              {t('ai.currentPage', { page: state.currentPage })}
            </label>
            <label className="ai-choice">
              <input
                type="radio"
                name="ai-scope"
                checked={scope === 'range'}
                onChange={() => {
                  setScope('range');
                  changed();
                }}
              />
              {t('ai.pageRange')}
            </label>
            {scope === 'range' && (
              <div className="ai-range">
                <label className="field">
                  <span>{t('ai.from')}</span>
                  <input
                    className="text-input"
                    type="number"
                    min={1}
                    max={Math.max(1, pageCount)}
                    value={from}
                    onChange={(event) => {
                      setFrom(event.target.value);
                      changed();
                    }}
                  />
                </label>
                <label className="field">
                  <span>{t('ai.to')}</span>
                  <input
                    className="text-input"
                    type="number"
                    min={1}
                    max={Math.max(1, pageCount)}
                    value={to}
                    onChange={(event) => {
                      setTo(event.target.value);
                      changed();
                    }}
                  />
                </label>
              </div>
            )}
          </fieldset>
        </div>
      )}

      {!documentOpen && <p className="tool-panel-note">{t('tool.openFirst')}</p>}
      <div className="tool-actions">
        <IconButton
          label={t('ai.review')}
          icon={<Icon of={FileSearch} />}
          showLabel
          disabled={!canReview}
          onClick={() => void review()}
        />
        {task === 'pii' && (
          <IconButton
            label={t('ai.pii.local')}
            icon={<Icon of={FileSearch} />}
            showLabel
            disabled={!hasDocument || finding}
            onClick={() => void findLocal()}
          />
        )}
        {task === 'tables' && (
          <IconButton
            label={t('ai.tables.local')}
            icon={<Icon of={FileSearch} />}
            showLabel
            disabled={!hasDocument || finding}
            onClick={() => void findTablesLocally()}
          />
        )}
      </div>
      {task === 'tables' && <p className="tool-panel-note">{t('ai.tables.localNote')}</p>}
      {task === 'tables' && localTables && localTables.documentId === documentId && (
        <section className="ai-answer" aria-label={t('ai.tables.localTitle')}>
          <h4>{t('ai.tables.localTitle')}</h4>
          <TablesReview key={localTables.tables.length} found={localTables.tables} pageCount={pageCount} name={state.document?.name ?? 'document.pdf'} />
        </section>
      )}
      {task === 'pii' && <p className="tool-panel-note">{t('ai.pii.localNote')}</p>}
      {task === 'pii' && local && local.documentId === documentId && (
        <section className="ai-answer" aria-label={t('ai.pii.localTitle')}>
          <h4>{t('ai.pii.localTitle')}</h4>
          <PiiReview key={local.findings.length} pageCount={pageCount} local={local.findings} />
        </section>
      )}
      {hasDocument && missing && <p className="tool-panel-note">{t(missing)}</p>}
      {reading !== null && reading > 0 && (
        <p className="tool-panel-note" role="status">
          {t('ai.reading', { page: reading })}
        </p>
      )}
      {notice && (
        <p className="field-error" role="alert">
          {t(notice.key, notice.params)}
        </p>
      )}

      {shownPreflight && (
        <section className="ai-preflight" aria-labelledby={preflightId}>
          <h4 id={preflightId}>{t('ai.preflight')}</h4>
          <dl className="ai-facts">
            <div>
              <dt>{t('ai.sentTo')}</dt>
              <dd>
                {shownPreflight.settings.provider === 'claude'
                  ? t('ai.toAnthropic', { host: shownPreflight.destination })
                  : shownPreflight.settings.provider === 'local'
                    ? t('ai.toThisComputer', { url: shownPreflight.destination })
                    : t('ai.toThisDevice')}
              </dd>
            </div>
            <div>
              <dt>{t('ai.model')}</dt>
              <dd dir="ltr">{shownPreflight.settings.model}</dd>
            </div>
            <div>
              <dt>{t('ai.pages')}</dt>
              <dd>
                {t('ai.pagesOf', {
                  pages: pageList(shownPreflight.pages),
                  total: shownPreflight.pageCount,
                })}
              </dd>
            </div>
            <div>
              <dt>{t('ai.characters')}</dt>
              <dd>{numbers.format(shownPreflight.characters)}</dd>
            </div>
          </dl>
          {shownPreflight.left.length > 0 && (
            <p className="ai-warning">
              {t('ai.leftOut', {
                pages: pageList(shownPreflight.left),
                budget: numbers.format(shownPreflight.budget),
              })}
            </p>
          )}
          {shownPreflight.task.kind === 'ask' && (
            <p className="tool-panel-note">{t('ai.questionSent')}</p>
          )}
          {shownPreflight.passages && <p className="tool-panel-note">{t('ai.passagesNote', { pages: pageList(shownPreflight.pages) })}</p>}
          <details
            className="ai-exact"
            open={showText}
            onToggle={(event) => setShowText(event.currentTarget.open)}
          >
            <summary>{t('ai.showText')}</summary>
            {showText && (
              <pre>{`${shownPreflight.prompt.system}\n\n${shownPreflight.prompt.user}`}</pre>
            )}
          </details>
          <div className="tool-actions">
            <IconButton
              label={t(
                shownPreflight.settings.provider === 'claude' ? 'ai.sendClaude' : shownPreflight.settings.provider === 'local' ? 'ai.sendLocal' : 'ai.runOnDevice',
              )}
              icon={<Icon of={Send} mirror />}
              showLabel
              variant="primary"
              disabled={sending}
              onClick={() => void go()}
            />
            <IconButton
              label={t('ai.discard')}
              icon={<Icon of={X} />}
              showLabel
              disabled={sending}
              onClick={changed}
            />
          </div>
        </section>
      )}

      {sending && (
        <div className="ai-status" role="status">
          <Icon of={Loader} className="spin" />
          <span>
            {t(partial?.text ? 'ai.arriving' : partial?.thinking ? 'ai.thinking' : 'ai.waiting')}
          </span>
          <IconButton
            label={t('ai.stop')}
            icon={<Icon of={Square} />}
            showLabel
            onClick={() => abortRef.current?.abort()}
          />
        </div>
      )}
      {sending && partial?.text && !(preflight && answersWithData(preflight.task)) && (
        // As it is written; read out once, whole, when it is done.
        <div className="ai-answer-text ai-streaming" aria-live="off">
          {partial.text.split('\n').map((line, index) =>
            line.trim().length === 0 ? null : (
              <p key={index} dir="auto">
                {line}
              </p>
            ),
          )}
        </div>
      )}
      {failed && (
        <p className="field-error" role="alert">
          {t(failed.key, failed.params).trim()}
        </p>
      )}

      {shownResult && answersWithData(shownResult.task) && (
        <section className="ai-answer" aria-labelledby={answerId}>
          <h4 id={answerId}>{t('ai.review.title')}</h4>
          {shownResult.answer.cutOff && <p className="ai-warning">{t('ai.cutOff')}</p>}
          {shownResult.task.kind === 'fixOcr' && <OcrFixReview answer={shownResult.answer.text} layer={shownResult.extra.layer ?? []} />}
          {shownResult.task.kind === 'fill' && <FormFillReview answer={shownResult.answer.text} fields={shownResult.extra.fields ?? []} />}
          {shownResult.task.kind === 'pii' && <PiiReview answer={shownResult.answer.text} pageCount={shownResult.pageCount} />}
          {shownResult.task.kind === 'tables' && (
            <TablesReview answer={shownResult.answer.text} pageCount={shownResult.pageCount} name={shownResult.extra.name ?? 'document.pdf'} />
          )}
          <p className="tool-panel-note">{t('ai.review.from', { model: shownResult.model })}</p>
        </section>
      )}
      {shownResult && !answersWithData(shownResult.task) && (
        <section className="ai-answer" aria-labelledby={answerId}>
          <h4 id={answerId}>{t('ai.answer')}</h4>
          <div className="ai-answer-text">
            {shownResult.answer.text.split('\n').map((line, index) =>
              line.trim().length === 0 ? null : (
                <p key={index} dir="auto">
                  {splitCitations(line, shownResult.pageCount).map((piece, at) =>
                    piece.kind === 'text' ? (
                      <Fragment key={at}>{piece.text}</Fragment>
                    ) : (
                      // Its own direction keeps the button out of the line's automatic one.
                      <button
                        key={at}
                        type="button"
                        className="ai-cite"
                        dir={dir}
                        title={t('ai.goToPage', { page: piece.page })}
                        aria-label={t('ai.goToPage', { page: piece.page })}
                        onClick={() => services.goToPage(piece.page)}
                      >
                        {t('ai.cite', { page: piece.page })}
                      </button>
                    ),
                  )}
                </p>
              ),
            )}
          </div>
          {shownResult.answer.cutOff && <p className="ai-warning">{t('ai.cutOff')}</p>}
          <p className="tool-panel-note">
            {t('ai.answerFrom', { model: shownResult.model, pages: pageList(shownResult.pages) })}
          </p>
          <div className="tool-actions">
            <IconButton
              label={t(copied === 'yes' ? 'ai.copied' : 'ai.copy')}
              icon={<Icon of={copied === 'yes' ? Check : Copy} />}
              showLabel
              onClick={() => void copy(shownResult.answer.text)}
            />
          </div>
          {copied === 'failed' && (
            <p className="field-error" role="alert">
              {t('ai.copyFailed')}
            </p>
          )}
          <p className="tool-panel-note">{t('ai.answerNote')}</p>
        </section>
      )}
    </div>
  );
}
