import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, FileSearch, Loader, Send, Sparkles, Square, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useI18n } from '../i18n/useT';
import type { Lang, TKey, TParams } from '../i18n/messages';
import { useAppState, useServices } from '../state/AppContext';
import { budgetFor, formatPages, pageRange } from './budget';
import type { TaskKind } from './budget';
import { splitCitations } from './citations';
import { preflightFor } from './preflight';
import type { Preflight, ProviderSettings } from './preflight';
import type { AiTask } from './prompt';
import { CLAUDE_MODELS, LOCAL_ALLOWED_ORIGINS, localAddress } from './providers';
import type { Answer, Failure, LocalApi, ProviderId } from './providers';
import { readDocument } from './readDocument';
import { send } from './send';
import { forgetKey, keepKey, loadKey, readSettings, writeSettings } from './store';
import type { AiSettings } from './store';
import './ai.css';

type Message = { key: TKey; params?: TParams };

const numbers = new Intl.NumberFormat('en-US');

const TASKS: Record<TaskKind, TKey> = {
  summarize: 'ai.summarize',
  ask: 'ai.ask',
  translate: 'ai.translate',
};

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
  }
}

/** What came back, and from where; kept with the document it is about. */
interface Result {
  documentId: number;
  answer: Answer;
  model: string;
  pages: number[];
  pageCount: number;
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
  const [settings, setSettings] = useState<AiSettings>(readSettings);
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
  const [preflight, setPreflight] = useState<(Preflight & { documentId: number }) | null>(null);
  const [showText, setShowText] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<{ failure: Failure; provider: ProviderId } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const abortRef = useRef<AbortController | null>(null);
  // Bumped by every change of what would be sent, so a review still reading
  // when the person changed their mind does not show the old choice as current.
  const generation = useRef(0);
  const preflightId = useId();
  const answerId = useId();

  useEffect(() => writeSettings(settings), [settings]);
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
  const addressProblem: TKey | null =
    claude || address.ok ? null : address.reason === 'notLocal' ? 'ai.notLocal' : 'ai.invalidUrl';
  const otherPort =
    !claude &&
    address.ok &&
    !(LOCAL_ALLOWED_ORIGINS as readonly string[]).includes(new URL(address.base).origin);
  const missing: TKey | null =
    claude && key.trim().length === 0
      ? 'ai.needKey'
      : !claude && settings.localModel.trim().length === 0
        ? 'ai.needModel'
        : task === 'ask' && question.trim().length === 0
          ? 'ai.needQuestion'
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

  const review = async () => {
    if (!canReview || documentId === null) return;
    let target: ProviderSettings;
    if (claude) target = { provider: 'claude', model: settings.claudeModel };
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
          : { kind: 'summarize' };
    const budget = budgetFor(target.provider, task);
    const current = state.currentPage;
    const pagesOf = (count: number) =>
      task !== 'translate'
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
      const read = await readDocument(services, pagesOf, budget, setReading);
      if (ticket !== generation.current) return;
      if (!read) {
        setNotice({ key: 'ai.readFailed' });
        return;
      }
      const next = preflightFor(target, aiTask, read.budgeted, {
        lang,
        pageCount: read.pageCount,
        budget,
      });
      if (next.pages.length === 0 && next.left.length > 0) {
        setNotice({
          key: 'ai.nothingFits',
          params: { page: next.left[0] ?? 1, budget: numbers.format(budget) },
        });
      } else if (next.empty) {
        setNotice({ key: 'ai.noText' });
      } else {
        setPreflight({ ...next, documentId });
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
    const outcome = await send(sent, key.trim(), controller.signal);
    if (abortRef.current === controller) abortRef.current = null;
    setSending(false);
    if (outcome.ok) {
      setResult({
        documentId: sent.documentId,
        answer: outcome.answer,
        model: sent.settings.model,
        pages: sent.pages,
        pageCount: sent.pageCount,
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
        {(['claude', 'local'] as const).map((provider) => (
          <label key={provider} className="ai-choice">
            <input
              type="radio"
              name="ai-provider"
              checked={settings.provider === provider}
              onChange={() => update({ provider })}
            />
            {t(provider === 'claude' ? 'ai.claude' : 'ai.local')}
          </label>
        ))}
      </fieldset>

      {claude ? (
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

      {task === 'translate' && (
        <div className="ai-group">
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
      </div>
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
                  : t('ai.toThisComputer', { url: shownPreflight.destination })}
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
                shownPreflight.settings.provider === 'claude' ? 'ai.sendClaude' : 'ai.sendLocal',
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
          <span>{t('ai.waiting')}</span>
          <IconButton
            label={t('ai.stop')}
            icon={<Icon of={Square} />}
            showLabel
            onClick={() => abortRef.current?.abort()}
          />
        </div>
      )}
      {failed && (
        <p className="field-error" role="alert">
          {t(failed.key, failed.params).trim()}
        </p>
      )}

      {shownResult && (
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
