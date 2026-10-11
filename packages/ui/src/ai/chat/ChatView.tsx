import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowUp, Check, Copy, ScanText, Sparkles, Square, Volume2, VolumeX } from 'lucide-react';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { useI18n } from '../../i18n/useT';
import type { TKey } from '../../i18n/messages';
import { formatPages } from '../budget';
import type { Failure, ProviderId } from '../providers';
import { start as startReading, stop as stopReading, useReadAloud } from '../../speech/readAloud';
import { AnswerText, spokenText } from './AnswerText';
import type { Progress } from './analyze';
import type { Ask, Basis } from './answer';
import { deviceModel, shortModelName } from '../device/models';
import { CHIPS } from './chips';
import { analyzeNow, approve, ask, discard, setDraft, stop, useConversation } from './store';
import type { AssistantTurn, Env, Note, Turn } from './store';

const numbers = new Intl.NumberFormat('en-US');
/** Page buttons under an answer made from passages, at most: the line above them names every page. */
const PAGES_SHOWN = 16;

export function failureNote(failure: Failure, provider: ProviderId): Note {
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
      return { key: provider === 'claude' ? 'ai.modelMissingClaude' : 'ai.modelMissingLocal', params: { model: failure.model } };
    case 'tooLarge':
      return { key: provider === 'device' ? 'ai.chat.tooLargeDevice' : 'ai.tooLarge' };
    case 'server':
      return { key: 'ai.server', params: { status: failure.status } };
    case 'other':
      return { key: 'ai.other', params: { status: failure.status, message: failure.message } };
    case 'offline':
      return { key: 'ai.offline', params: { host: failure.host } };
    case 'localDown':
      return { key: 'ai.localDown', params: { url: failure.url } };
    case 'blocked':
      return { key: provider === 'claude' ? 'ai.blockedClaude' : 'ai.blockedLocal', params: { url: failure.url } };
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

export interface ChatViewProps {
  documentId: number | null;
  /** A document is open and can be read now. */
  hasDocument: boolean;
  currentPage: number;
  /** Why nothing can be asked yet (no key, no model…), or null when it can. */
  missing: TKey | null;
  /** What stands in the thread while something is missing: the model's download, a way to the settings. */
  setup: ReactNode;
  env: Env;
  /** Where messages go, as the line under the input says it. */
  where: string;
  goToPage: (page: number) => void;
  openOcr: () => void;
  /** A request waiting to be sent, from the home screen: taken once it can go. */
  incoming: { kind: Ask['kind']; text: string } | null;
  onIncomingTaken: () => void;
}

/**
 * The conversation about the open document: the person's messages and the
 * assistant's, newest at the bottom; the input fixed at the foot, with the
 * quick actions over it; and under the input, always, where messages go.
 */
export function ChatView(props: ChatViewProps) {
  const { documentId, hasDocument, currentPage, missing, env, incoming, onIncomingTaken } = props;
  const { t, dir } = useI18n();
  const conversation = useConversation(documentId);
  const reading = useReadAloud();
  const [copied, setCopied] = useState<{ id: number; state: 'yes' | 'failed' } | null>(null);
  const [heard, setHeard] = useState<number | null>(null);
  // The answer being read aloud: the one whose Listen was pressed, for as long as the voice is on it.
  const listening = reading.active && reading.scope === 'selection' ? heard : null;
  const startedReading = useRef(false);
  const [showText, setShowText] = useState(false);
  const thread = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const pinned = useRef(true);
  const inputId = useId();
  const reviewId = useId();
  const { turns, busy, progress, review, known, draft } = conversation;
  const canSend = hasDocument && documentId !== null && missing === null && !busy;

  // In Arabic text a range such as 1–2 reads backwards unless it is isolated as left-to-right.
  const pageList = (pages: readonly number[]) => (dir === 'rtl' ? `⁦${formatPages(pages)}⁩` : formatPages(pages));
  const range = (from: number, to: number) => (dir === 'rtl' ? `\u2066${from}–${to}\u2069` : `${from}–${to}`);
  const say = (note: Note) => t(note.key, note.params).trim();

  const send = (request: Ask) => {
    if (!canSend || documentId === null) return false;
    pinned.current = true;
    void ask(documentId, request, env);
    return true;
  };
  const sendTyped = () => {
    const text = draft.trim();
    if (text.length === 0) return;
    if (send({ kind: 'question', text }) && documentId !== null) setDraft(documentId, '');
  };

  // A request from the home screen goes as soon as it can; until then it waits in the input.
  useEffect(() => {
    if (!incoming) return;
    if (canSend && documentId !== null) {
      pinned.current = true;
      void ask(documentId, incoming.kind === 'translate' ? { kind: 'translate', text: incoming.text, page: currentPage } : { kind: incoming.kind, text: incoming.text }, env);
      onIncomingTaken();
    } else if (hasDocument && documentId !== null && missing !== null) {
      setDraft(documentId, incoming.text);
      onIncomingTaken();
    }
  }, [incoming, canSend, documentId, hasDocument, missing, currentPage, env, onIncomingTaken]);

  // The newest words stay in view while the reader has not scrolled away from them.
  useLayoutEffect(() => {
    const node = thread.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  });
  // The input grows with what is typed, up to a few lines.
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.blockSize = 'auto';
    node.style.blockSize = `${Math.min(node.scrollHeight, 132)}px`;
  }, [draft]);
  useEffect(() => {
    if (copied?.state !== 'yes') return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  // Leaving the panel stops the voice that was reading one of its answers.
  useEffect(
    () => () => {
      if (startedReading.current) stopReading();
    },
    [],
  );

  const copy = async (turn: AssistantTurn) => {
    try {
      await navigator.clipboard.writeText(turn.text);
      setCopied({ id: turn.id, state: 'yes' });
    } catch {
      setCopied({ id: turn.id, state: 'failed' });
    }
  };

  const listen = (turn: AssistantTurn) => {
    if (listening === turn.id) {
      stopReading();
      startedReading.current = false;
      return;
    }
    setHeard(turn.id);
    startedReading.current = true;
    // The answer goes to the reader as a selection does: sentence by sentence, each in the voice of its own script.
    void startReading(
      { pageCount: 0, currentPage: 1, lines: async () => [], selection: async () => spokenText(turn.text), goToPage: () => undefined, close: () => undefined },
      'selection',
    );
  };

  const progressText = (at: Progress) =>
    at.stage === 'reading'
      ? at.from === at.to
        ? t('ai.chat.progressReadingOne', { page: at.from, total: at.pageCount })
        : t('ai.chat.progressReading', { pages: range(at.from, at.to), total: at.pageCount })
      : at.stage === 'combining'
        ? t('ai.chat.progressCombining', { done: at.done + 1, total: at.total })
        : t('ai.chat.progressOutline');
  const progressShare = (at: Progress) => (at.stage === 'reading' ? (at.done / Math.max(1, at.total)) * 0.85 : at.stage === 'combining' ? 0.85 + (at.done / Math.max(1, at.total)) * 0.1 : 0.97);

  const basisText = (basis: Basis) => {
    switch (basis.kind) {
      case 'whole':
        return t('ai.chat.basisWhole', { total: basis.pageCount });
      case 'analysis':
        return t('ai.chat.basisAnalysis', { total: basis.pageCount });
      case 'passages':
        return t(basis.outline ? 'ai.chat.basisPassagesOutline' : 'ai.chat.basisPassages', { pages: pageList(basis.pages), total: basis.pageCount });
      case 'page':
        return t('ai.chat.basisPage', { page: basis.page });
    }
  };

  const renderTurn = (turn: Turn): ReactNode => {
    if (turn.role === 'user') {
      return (
        <li key={turn.id} className="ai-turn ai-turn-user">
          <span className="sr-only">{t('ai.chat.you')}</span>
          <p dir="auto">{turn.text}</p>
        </li>
      );
    }
    if (turn.role === 'event') {
      return (
        <li key={turn.id} className="ai-turn ai-turn-event">
          {say(turn.note)}
        </li>
      );
    }
    const working = turn.status === 'working';
    const failed = turn.failure ? failureNote(turn.failure, turn.provider) : null;
    return (
      <li key={turn.id} className="ai-turn ai-turn-assistant" aria-busy={working} data-status={turn.status}>
        <span className="sr-only">{t('ai.chat.assistant')}</span>
        {turn.analyzed && <p className="ai-turn-line">{t('ai.chat.analyzingFirst')}</p>}
        {turn.text.length > 0 && <AnswerText text={turn.text} pageCount={turn.pageCount} onPage={props.goToPage} />}
        {working && turn.text.length === 0 && !review && (
          <p className="ai-turn-wait">
            {conversation.reading !== null && !progress ? (
              t('ai.reading', { page: conversation.reading })
            ) : turn.thinking ? (
              t('ai.thinking')
            ) : (
              <>
                <span className="sr-only">{t('ai.chat.writing')}</span>
                <span className="ai-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </>
            )}
          </p>
        )}
        {turn.status === 'noText' && (
          <div className="ai-turn-notice">
            <p>{t(turn.noText === 'page' ? 'ai.chat.noTextPage' : 'ai.chat.noTextDocument')}</p>
            <IconButton label={t('ai.chat.openOcr')} icon={<Icon of={ScanText} />} showLabel onClick={props.openOcr} />
          </div>
        )}
        {turn.status === 'stopped' && <p className="ai-turn-line">{t(turn.text.length > 0 ? 'ai.chat.stoppedPartial' : 'ai.chat.stopped')}</p>}
        {turn.status === 'done' && turn.cutOff && <p className="ai-turn-line ai-warning">{t('ai.cutOff')}</p>}
        {failed && (
          <p className="field-error" role="alert">
            {say(failed)}
          </p>
        )}
        {!working && turn.text.length > 0 && (
          <div className="ai-turn-foot">
            <div className="ai-turn-actions">
              <IconButton
                className="ai-turn-action"
                label={t(copied?.id === turn.id && copied.state === 'yes' ? 'ai.copied' : 'ai.copy')}
                icon={<Icon of={copied?.id === turn.id && copied.state === 'yes' ? Check : Copy} size={14} />}
                onClick={() => void copy(turn)}
              />
              <IconButton
                className="ai-turn-action"
                label={t(listening === turn.id ? 'ai.chat.stopListening' : 'ai.chat.listen')}
                icon={<Icon of={listening === turn.id ? VolumeX : Volume2} size={14} />}
                pressed={listening === turn.id}
                onClick={() => listen(turn)}
              />
            </div>
            {turn.basis && (
              <p className="ai-turn-basis">
                <bdi dir="ltr">{turn.provider === 'device' ? shortModelName(deviceModel(turn.model).name) : turn.model}</bdi> · {basisText(turn.basis)}
              </p>
            )}
            {turn.basis?.kind === 'passages' && (
              // The pages the passages came from, each a way there — whether or not the model cited them.
              <ul className="ai-turn-pages" aria-label={t('ai.chat.pagesRead')}>
                {turn.basis.pages.slice(0, PAGES_SHOWN).map((page) => (
                  <li key={page}>
                    <button type="button" className="ai-cite" dir={dir} title={t('ai.goToPage', { page })} aria-label={t('ai.goToPage', { page })} onClick={() => props.goToPage(page)}>
                      {t('ai.cite', { page })}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {copied?.id === turn.id && copied.state === 'failed' && (
          <p className="field-error" role="alert">
            {t('ai.copyFailed')}
          </p>
        )}
        {listening === turn.id && reading.notice && reading.notice !== 'done' && (
          <p className="field-error" role="alert">
            {t(reading.notice === 'unsupported' ? 'readAloud.unsupported' : 'readAloud.noVoices')}
          </p>
        )}
      </li>
    );
  };

  /** The line that says what is known of the document, with the one thing to do about it. */
  const documentLine = (): ReactNode => {
    if (!hasDocument || documentId === null) return null;
    if (busy && progress) {
      return (
        <div className="ai-doc" role="status">
          <span className="ai-doc-text">{progressText(progress)}</span>
          <progress className="ai-progress" max={1} value={progressShare(progress)} aria-label={t('ai.chat.progress')} />
        </div>
      );
    }
    if (!known) return null;
    if (known.noText) {
      return (
        <div className="ai-doc">
          <span className="ai-doc-text">{t('ai.chat.docNoText')}</span>
          <IconButton label={t('ai.chat.openOcr')} icon={<Icon of={ScanText} />} showLabel onClick={props.openOcr} />
        </div>
      );
    }
    // A document the model reads whole needs nothing said about it.
    if (known.whole) return null;
    if (known.analyzed) return <div className="ai-doc ai-doc-quiet">{t('ai.chat.docAnalyzed', { total: known.pageCount })}</div>;
    return (
      <div className="ai-doc">
        <span className="ai-doc-text">{t('ai.chat.docLong', { total: known.pageCount, parts: known.parts })}</span>
        <IconButton label={t('ai.chat.analyze')} icon={<Icon of={Sparkles} />} showLabel disabled={!canSend} onClick={() => void analyzeNow(documentId, env)} />
      </div>
    );
  };

  const empty = turns.length === 0;
  return (
    <div className="ai-chat">
      {documentLine()}
      <div
        ref={thread}
        className="ai-thread"
        tabIndex={0}
        role="log"
        aria-live="polite"
        aria-label={t('ai.chat.conversation')}
        onScroll={(event) => {
          const node = event.currentTarget;
          pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        }}
      >
        {missing !== null && hasDocument ? (
          <div className="ai-chat-setup">{props.setup}</div>
        ) : !hasDocument && incoming ? (
          // From the home screen, before its file is chosen: the request, where it will be asked.
          <ol className="ai-turns">
            <li className="ai-turn ai-turn-user">
              <p dir="auto">{incoming.text}</p>
            </li>
            <li className="ai-turn ai-turn-event">{t('ai.card.needsFile')}</li>
          </ol>
        ) : empty ? (
          <div className="ai-chat-empty">
            <span className="ai-chat-mark" aria-hidden="true">
              <Icon of={Sparkles} size={22} />
            </span>
            <h4>{t(hasDocument ? 'ai.chat.emptyTitle' : 'ai.chat.emptyNoFile')}</h4>
            <p>{t(hasDocument ? 'ai.chat.emptyText' : 'tool.openFirst')}</p>
          </div>
        ) : (
          <ol className="ai-turns">{turns.map(renderTurn)}</ol>
        )}
        {conversation.notice && (
          <p className="field-error" role="alert">
            {say(conversation.notice)}
          </p>
        )}
        {conversation.failure && (
          <p className="field-error" role="alert">
            {say(failureNote(conversation.failure.failure, conversation.failure.provider))}
          </p>
        )}
        {review && documentId !== null && (
          <section className="ai-preflight ai-chat-review" aria-labelledby={reviewId}>
            <h4 id={reviewId}>{t('ai.preflight')}</h4>
            <dl className="ai-facts">
              <div>
                <dt>{t('ai.sentTo')}</dt>
                <dd>{review.provider === 'claude' ? t('ai.toAnthropic', { host: review.destination }) : t('ai.toThisComputer', { url: review.destination })}</dd>
              </div>
              <div>
                <dt>{t('ai.model')}</dt>
                <dd dir="ltr">{review.model}</dd>
              </div>
              <div>
                <dt>{t('ai.chat.reviewDocument')}</dt>
                <dd>{t(review.whole ? 'ai.chat.reviewWhole' : 'ai.chat.reviewParts', { total: review.pageCount, characters: numbers.format(review.characters) })}</dd>
              </div>
              <div>
                <dt>{t('ai.chat.reviewNow')}</dt>
                <dd>{t('ai.chat.reviewNowCount', { characters: numbers.format(review.prompt.system.length + review.prompt.user.length) })}</dd>
              </div>
            </dl>
            <p className="tool-panel-note">{t('ai.chat.reviewOnce')}</p>
            <details className="ai-exact" open={showText} onToggle={(event) => setShowText(event.currentTarget.open)}>
              <summary>{t('ai.showText')}</summary>
              {showText && <pre>{`${review.prompt.system}\n\n${review.prompt.user}`}</pre>}
            </details>
            <div className="tool-actions">
              <IconButton label={t(review.provider === 'claude' ? 'ai.sendClaude' : 'ai.sendLocal')} icon={<Icon of={ArrowUp} />} showLabel variant="primary" onClick={() => approve(documentId)} />
              <IconButton label={t('ai.discard')} icon={<Icon of={Square} />} showLabel onClick={() => discard(documentId)} />
            </div>
          </section>
        )}
      </div>

      <ul className="ai-chips" aria-label={t('ai.card.chips')}>
        {CHIPS.map((chip) => (
          <li key={chip.id}>
            <button
              type="button"
              className="ai-chip"
              disabled={!canSend}
              onClick={() => {
                const text = t(chip.prompt);
                send(chip.kind === 'translate' ? { kind: 'translate', text, page: currentPage } : { kind: chip.kind, text });
                input.current?.focus();
              }}
            >
              {t(chip.label)}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="ai-composer"
        onSubmit={(event) => {
          event.preventDefault();
          sendTyped();
        }}
      >
        <label className="sr-only" htmlFor={inputId}>
          {t('ai.chat.input')}
        </label>
        <textarea
          id={inputId}
          ref={input}
          className="ai-input"
          // What is typed takes its own direction; the empty field's hint takes the interface's.
          dir={draft.length === 0 ? dir : 'auto'}
          rows={1}
          maxLength={2000}
          placeholder={t(hasDocument ? 'ai.chat.placeholder' : 'tool.openFirst')}
          disabled={!hasDocument}
          value={draft}
          onChange={(event) => documentId !== null && setDraft(documentId, event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter is a new line; Enter that ends a composition (Arabic, CJK input) does neither.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              sendTyped();
            }
          }}
        />
        {busy && documentId !== null ? (
          <IconButton
            className="ai-send ai-send-stop"
            label={t('ai.stop')}
            icon={<Icon of={Square} size={12} />}
            onClick={() => {
              stop(documentId);
              input.current?.focus();
            }}
          />
        ) : (
          <IconButton className="ai-send" label={t('ai.chat.send')} icon={<Icon of={ArrowUp} size={16} />} variant="primary" type="submit" disabled={!canSend || draft.trim().length === 0} />
        )}
      </form>
      <p className="ai-where">{missing !== null && hasDocument ? t(missing) : props.where}</p>
    </div>
  );
}
