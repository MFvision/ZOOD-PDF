import { useId, useRef, useState } from 'react';
import { FileSearch, Loader, Send, Square, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useI18n } from '../i18n/useT';
import type { TKey, TParams } from '../i18n/messages';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { budgetFor, formatPages, pageRange, takeWithinBudget } from './budget';
import { preflightFor } from './preflight';
import type { Preflight, ProviderSettings } from './preflight';
import type { AiTask } from './prompt';
import { localAddress } from './providers';
import type { Answer, Failure, ProviderId } from './providers';
import { readDocument } from './readDocument';
import { deviceEngine } from './device/engine';
import { deviceBudget, generateOnDevice } from './device/generate';
import type { DeviceModelView } from './device/useDeviceModel';
import { profileHasDetails, walletDetails } from './profile/wallet';
import { useWallet } from './profile/walletState';
import { openSettingsAt } from '../settings/SettingsWindow';
import { send } from './send';
import type { AiSettings } from './store';
import { failureNote } from './chat/ChatView';
import { readFillFields } from './extras/formFill';
import type { FillField } from './extras/formFill';
import { pageText } from './extras/ocrFix';
import type { LayerText } from './extras/ocrFix';
import type { PiiFinding } from './extras/pii';
import { forgetProfile, keepProfile, loadProfile } from './extras/profile';
import { FormFillReview, OcrFixReview, PiiReview, TablesReview, findWithPatterns } from './extras/Reviews';
import { findTablesOnDevice } from './extras/tables';
import type { Table } from './extras/tables';
import { layerWords } from '../ocr/layer';

type Message = { key: TKey; params?: TParams };

const numbers = new Intl.NumberFormat('en-US');

/** The tools whose answer is data, reviewed before anything is done with it. */
type DataTask = 'fixOcr' | 'fill' | 'pii' | 'tables';

const TASKS: Record<DataTask, TKey> = {
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
 * The AI tool's document tools — correct the OCR text, fill in a form, find
 * personal information, extract the tables — each one request whose answer
 * is data the panel shows for review before anything is done with it. They
 * use the model chosen in the assistant's settings. Nothing leaves the
 * device until the person has seen, in the preflight, the provider and
 * model, where the text goes, which pages and how many characters — and
 * then pressed the Send button under it.
 */
export function AiTasks({ settings, apiKey, device }: { settings: AiSettings; apiKey: string; device: DeviceModelView }) {
  const { t, lang, dir } = useI18n();
  const state = useAppState();
  const services = useServices();
  const dispatch = useAppDispatch();
  const wallet = useWallet(t('wallet.me'));
  const [profileId, setProfileId] = useState<string | null>(null);
  const profile = wallet?.profiles.find((one) => one.id === profileId) ?? wallet?.profiles[0] ?? null;
  const key = apiKey;
  const [task, setTask] = useState<DataTask>('fixOcr');
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
  const abortRef = useRef<AbortController | null>(null);
  // Bumped by every change of what would be sent, so a review still reading
  // when the person changed their mind does not show the old choice as current.
  const generation = useRef(0);
  const preflightId = useId();
  const answerId = useId();

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
  // The saved details, as smart fill sends them, before anything typed here.
  const savedDetails = profile && profileHasDetails(profile) ? walletDetails(profile, lang) : '';
  const allDetails = [savedDetails, details.trim()].filter(Boolean).join('\n');
  const missing: TKey | null =
    claude && key.trim().length === 0
      ? 'ai.needKey'
      : localServer && settings.localModel.trim().length === 0
        ? 'ai.needModel'
        : onDevice && device.status?.kind !== 'ready'
          ? 'ai.needDeviceModel'
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
    const aiTask: AiTask = task === 'fill' ? { kind: 'fill', fields: [], details: allDetails } : { kind: task };
    let budget = budgetFor(target.provider, task);
    const current = state.currentPage;
    const pagesOf = (count: number) =>
      task !== 'tables'
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
        if (target.provider === 'device') budget = await deviceBudget(await deviceEngine(device.model), task, [...texts.values()][0] ?? '');
        const budgeted = await takeWithinBudget([...texts.keys()], budget, async (page) => texts.get(page) ?? '');
        read = { pageCount, budgeted };
      } else if (aiTask.kind === 'fill') {
        // The form's fields, and the words beside each one on its page.
        const bytes = await services.currentFileBytes();
        if (!bytes) throw new Error('E_NOT_FOUND: no open file');
        const fields = await readFillFields(services.client, bytes, services.documentPassword);
        if (ticket !== generation.current) return;
        if (fields.length === 0) {
          setNotice({ key: 'ai.fill.noFields' });
          return;
        }
        extra.fields = fields;
        aiTask.fields = fields;
        read = { pageCount, budgeted: { sent: [], left: [], characters: 0 } };
      } else {
        if (target.provider === 'device') {
          // The on-device window is counted in tokens: the budget is what this document's text costs in them.
          const first = await readDocument(services, (count) => pagesOf(count).slice(0, 1), 2_000_000);
          if (ticket !== generation.current) return;
          budget = await deviceBudget(await deviceEngine(device.model), task, first?.budgeted.sent[0]?.text ?? '');
        }
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
      setPreflight(null);
    } else {
      setFailure({ failure: outcome.failure, provider: sent.settings.provider });
    }
  };

  const failed = failure ? failureNote(failure.failure, failure.provider) : null;

  return (
    <div className="tool-panel ai-tasks">
      <p className="tool-panel-note">{t('ai.tasks.intro')}</p>

      <fieldset className="ai-group">
        <legend>{t('ai.action')}</legend>
        {(Object.keys(TASKS) as DataTask[]).map((kind) => (
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

      {task === 'fill' && (
        <div className="ai-group">
          {/* The saved details first (Settings keeps them encrypted); anything more is typed here. */}
          {wallet && wallet.profiles.length > 1 && (
            <label className="field">
              <span>{t('wallet.useProfile')}</span>
              <select
                className="text-input"
                value={profile?.id ?? ''}
                onChange={(event) => {
                  setProfileId(event.target.value);
                  changed();
                }}
              >
                {wallet.profiles.map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="tool-panel-note" data-profile={savedDetails ? 'saved' : 'empty'}>
            {savedDetails ? t('ai.fill.profileSaved', { count: savedDetails.split('\n').length }) : t('ai.fill.profileEmpty')}
          </p>
          <div className="tool-actions">
            <IconButton
              label={t('ai.fill.editProfile')}
              icon={<Icon of={FileSearch} />}
              showLabel
              onClick={() => {
                // A saved change reaches this panel by itself; what would be sent changes with it.
                openSettingsAt('wallet', () => dispatch({ type: 'DIALOG', dialog: 'settings' }));
                changed();
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

      {task === 'tables' && (
        <div className="ai-group">
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
      {failed && (
        <p className="field-error" role="alert">
          {t(failed.key, failed.params).trim()}
        </p>
      )}

      {shownResult && (
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
    </div>
  );
}
