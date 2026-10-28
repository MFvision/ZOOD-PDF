import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, FormEvent, ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bug,
  CheckCircle2,
  ChevronUp,
  CircleDot,
  Clapperboard,
  FileText,
  Globe,
  Hand,
  ImagePlus,
  Lightbulb,
  Loader2,
  Mail,
  MessageCircleQuestion,
  MousePointerClick,
  Search,
  Send,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { isTauriHost } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { openSettingsAt } from '../settings/SettingsWindow';
import type { SectionId } from '../settings/SettingsWindow';
import { openMail } from '../settings/about';
import { openTourAt } from '../tour/openAt';
import { openRemoteSheet } from '../remote/store';
import { openExternalUrl } from '../core/host-tauri';
import { readSettings } from '../ai/store';
import { appVersion } from '../updates/updates';
import { useDeviceModel } from '../ai/device/useDeviceModel';
import { deviceEngine } from '../ai/device/engine';
import { useReducedMotion } from '../components/useReducedMotion';
import { CATEGORIES, FAQ, KNOWN_ISSUES, articleById, articlesFor } from './articles';
import type { Article, Run } from './articles';
import { searchArticles, words } from './search';
import { runGuide } from './guide';
import type { GuideMode } from './guide';
import { takeSupportStart } from './open';
import type { SupportTab } from './open';
import { recentLog, logText } from './log';
import { RelayError } from './relay';
import { TICKET_KINDS, forgetTicket, keepMailed, readTickets, refreshTickets, sendTicket, shrinkPicture, systemFacts, ticketMail, validDraft } from './tickets';
import type { Draft, Picture, Ticket, TicketKind } from './tickets';
import { loadIdeas, postIdea, readIdeaDraft, sortIdeas, validIdea, vote, writeIdeaDraft } from './ideas';
import type { Idea, IdeaSort } from './ideas';
import { SUPPORT, LIMITS } from './config';
import { guidePdfUrl } from './guidePdfs';
import { motionUrl, shotUrl } from './guideShots';
import './support.css';

/**
 * Help & Support: one place, four tabs.
 *  - Ask: a question in the person's words finds the guide that answers it,
 *    with Show me and Do it for me; the on-device AI can explain it further.
 *  - Learn: every article, the FAQ and the known problems, each article as
 *    a PDF guide and, where there is one, a video and a tour chapter.
 *  - Report a problem: private, no account; the person sees all that is sent
 *    first, and follows its status here.
 *  - Ideas: write one, upvote others, no account.
 * Help › Help & Support opens it, Settings › About, F1, and the AI help.
 */

const TABS: readonly { id: SupportTab; label: TKey; icon: typeof Search }[] = [
  { id: 'ask', label: 'support.tab.ask', icon: MessageCircleQuestion },
  { id: 'learn', label: 'support.tab.learn', icon: BookOpen },
  { id: 'report', label: 'support.tab.report', icon: Bug },
  { id: 'ideas', label: 'support.tab.ideas', icon: Lightbulb },
];

export function SupportCenter() {
  const { dialog } = useAppState();
  const dispatch = useAppDispatch();
  const { t } = useI18n();
  const open = dialog === 'support';
  const close = () => dispatch({ type: 'DIALOG', dialog: null });
  return (
    <Dialog open={open} title={t('support.title')} onClose={close} className="support-dialog" closeOnBackdrop={false}>
      {open ? <SupportBook onClose={close} /> : null}
    </Dialog>
  );
}

function SupportBook({ onClose }: { onClose: () => void }) {
  const { t, lang } = useI18n();
  const [start] = useState(takeSupportStart);
  const [tab, setTab] = useState<SupportTab>(start.tab);
  const [article, setArticle] = useState<string | null>(start.article ?? null);
  const [desktop] = useState(isTauriHost);
  const state = useAppState();
  const dispatch = useAppDispatch();
  const reduced = useReducedMotion();
  const hasDocument = useRef(false);
  useEffect(() => {
    hasDocument.current = state.document !== null;
  });

  const runOf = (what: Run) => {
    if (what === 'remote') return openRemoteSheet();
    if (what === 'search') return;
    const section = what.slice('settings:'.length) as SectionId;
    openSettingsAt(section, () => dispatch({ type: 'DIALOG', dialog: 'settings' }));
  };

  const guide = (one: Article, mode: GuideMode) => {
    onClose();
    // After the sheet has gone, so the pointer is over the app itself.
    setTimeout(() => {
      void runGuide(one, mode, { lang, t: t as never, hasDocument: () => hasDocument.current, run: runOf, reduced });
    }, 250);
  };
  const actions: ArticleActions = {
    guide,
    tour: (one) => {
      if (!one.tour) return;
      const chapter = one.tour;
      onClose();
      setTimeout(() => openTourAt(chapter, () => dispatch({ type: 'DIALOG', dialog: 'tour' })), 0);
    },
    read: (id) => {
      setArticle(id);
      setTab('learn');
    },
    report: () => setTab('report'),
    idea: () => setTab('ideas'),
  };

  return (
    <div className="support">
      <div className="support-tabs" role="tablist" aria-label={t('support.title')}>
        {TABS.map((one) => (
          <button
            key={one.id}
            type="button"
            role="tab"
            id={`support-tab-${one.id}`}
            aria-selected={tab === one.id}
            aria-label={t(one.label)}
            aria-controls="support-page"
            className="support-tab"
            onClick={() => {
              setTab(one.id);
              if (one.id === 'learn') setArticle(null);
            }}
          >
            <Icon of={one.icon} size={16} />
            <span>{t(one.label)}</span>
          </button>
        ))}
      </div>
      <div className="support-page" id="support-page" role="tabpanel" aria-labelledby={`support-tab-${tab}`} key={tab}>
        {tab === 'ask' && <AskPage desktop={desktop} actions={actions} question={start.question} />}
        {tab === 'learn' && <LearnPage desktop={desktop} actions={actions} article={article} onArticle={setArticle} />}
        {tab === 'report' && <ReportPage />}
        {tab === 'ideas' && <IdeasPage />}
      </div>
    </div>
  );
}

interface ArticleActions {
  guide: (article: Article, mode: GuideMode) => void;
  tour: (article: Article) => void;
  read: (id: string) => void;
  report: () => void;
  idea: () => void;
}

/* ------------------------------------------------------------------ Ask */

const STARTERS: readonly TKey[] = ['support.ask.q1', 'support.ask.q2', 'support.ask.q3', 'support.ask.q4'];

function AskPage({ desktop, actions, question }: { desktop: boolean; actions: ArticleActions; question?: string }) {
  const { t, lang } = useI18n();
  const [text, setText] = useState(question ?? '');
  const [asked, setAsked] = useState(question ?? '');
  const list = useMemo(() => articlesFor(desktop), [desktop]);
  const found = useMemo(() => (asked ? searchArticles(asked, list, lang) : []), [asked, list, lang]);
  const faq = useMemo(() => {
    if (!asked) return [];
    const wanted = words(asked);
    return FAQ.filter((one) => wanted.some((word) => words([one.q[lang], ...one.keywords].join(' ')).some((have) => have.startsWith(word) || word.startsWith(have)))).slice(0, 2);
  }, [asked, lang]);
  const best = found[0]?.article;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setAsked(text.trim());
  };

  return (
    <div className="support-ask">
      <form className="support-ask-form" onSubmit={submit}>
        <Icon of={Search} size={16} className="support-ask-icon" />
        <input
          className="text-input support-ask-input"
          dir="auto"
          autoFocus
          value={text}
          placeholder={t('support.ask.placeholder')}
          aria-label={t('support.ask.placeholder')}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" className="icon-btn icon-btn-labeled icon-btn-primary" disabled={!text.trim()}>
          {t('support.ask.go')}
        </button>
      </form>
      {!asked && (
        <div className="support-starters">
          <p className="support-muted">{t('support.ask.intro')}</p>
          <div className="support-chips">
            {STARTERS.map((key) => (
              <button
                key={key}
                type="button"
                className="support-chip"
                onClick={() => {
                  setText(t(key));
                  setAsked(t(key));
                }}
              >
                {t(key)}
              </button>
            ))}
          </div>
        </div>
      )}
      {asked && best && (
        <>
          <ArticleCard article={best} actions={actions} lead />
          <AiExplain key={`${asked}|${best.id}`} question={asked} articles={found.map((one) => one.article).slice(0, 2)} />
          {(found.length > 1 || faq.length > 0) && (
            <div className="support-more">
              <p className="support-section-title">{t('support.ask.more')}</p>
              {faq.map((one) => (
                <details key={one.q.en} className="support-faq">
                  <summary dir="auto">{one.q[lang]}</summary>
                  <p dir="auto">{one.a[lang]}</p>
                </details>
              ))}
              {found.slice(1).map(({ article }) => (
                <button key={article.id} type="button" className="support-link-row" onClick={() => actions.read(article.id)}>
                  <Icon of={FileText} size={15} />
                  <span dir="auto">{article.title[lang]}</span>
                  <Icon of={ArrowRight} size={14} mirror />
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {asked && !best && (
        <div className="support-empty">
          {faq.length > 0 ? (
            faq.map((one) => (
              <div key={one.q.en} className="support-faq support-faq-open">
                <p className="support-faq-q" dir="auto">{one.q[lang]}</p>
                <p dir="auto">{one.a[lang]}</p>
              </div>
            ))
          ) : (
            <p>{t('support.ask.none')}</p>
          )}
          <div className="support-actions">
            <button type="button" className="icon-btn icon-btn-labeled" onClick={actions.report}>
              <Icon of={Bug} size={14} />
              {t('support.ask.toReport')}
            </button>
            <button type="button" className="icon-btn icon-btn-labeled" onClick={actions.idea}>
              <Icon of={Lightbulb} size={14} />
              {t('support.ask.toIdea')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The on-device AI puts the best guide in the person's own words. Only the
 * model on this device, never a cloud one, and only when it is downloaded.
 */
function AiExplain({ question, articles }: { question: string; articles: Article[] }) {
  const { t, lang } = useI18n();
  const [settings] = useState(readSettings);
  const device = useDeviceModel(settings.deviceModel);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  if (device.status?.kind !== 'ready') return null;

  const explain = async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setFailed(false);
    setAnswer('');
    const guides = articles
      .map((one) => `# ${one.title[lang]}\n${one.summary[lang]}\n${one.steps.map((step, index) => `${index + 1}. ${step[lang]}`).join('\n')}${one.tips ? `\n${one.tips.map((tip) => `- ${tip[lang]}`).join('\n')}` : ''}`)
      .join('\n\n');
    const system =
      lang === 'ar'
        ? `أنت مساعد تطبيق ZOOD PDF. أجب بالعربية، باختصار وبخطوات مرقمة، من هذه الأدلة فقط. إن لم تجد الجواب فيها فقل ذلك.\n\n${guides}`
        : `You are ZOOD PDF's help assistant. Answer in English, briefly, as numbered steps, from these guides only. If the answer is not in them, say so.\n\n${guides}`;
    try {
      const engine = await deviceEngine(device.model);
      let text = '';
      await engine.generate(
        [
          { role: 'system', content: system },
          { role: 'user', content: question },
        ],
        {
          maxTokens: 320,
          signal: controller.signal,
          onToken: (piece) => {
            text += piece;
            setAnswer(text);
          },
        },
      );
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (abort.current === controller) setBusy(false);
    }
  };

  return (
    <div className="support-ai">
      {!answer && !busy && (
        <button type="button" className="icon-btn icon-btn-labeled" onClick={() => void explain()}>
          <Icon of={Sparkles} size={14} />
          {t('support.ask.explain')}
        </button>
      )}
      {(answer || busy) && (
        <div className="support-ai-answer" aria-live="polite">
          <p className="support-ai-head">
            <Icon of={Sparkles} size={13} />
            {t('support.ask.aiHead')}
            {busy && <Icon of={Loader2} size={13} className="support-spin" />}
          </p>
          <p dir="auto" className="support-ai-text">
            {answer}
          </p>
        </div>
      )}
      {failed && <p className="support-muted">{t('support.ask.aiFailed')}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ Learn */

function ArticleCard({ article, actions, lead }: { article: Article; actions: ArticleActions; lead?: boolean }) {
  const { t, lang } = useI18n();
  const services = useServices();
  const dispatch = useAppDispatch();
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState<TKey | null>(null);
  const pdf = guidePdfUrl(article.id, lang);
  const openPdf = async () => {
    if (!pdf) return;
    setOpening(true);
    setFailed(null);
    try {
      const response = await fetch(pdf);
      if (!response.ok) throw new Error(`E_NET: ${response.status}`);
      const bytes = await response.arrayBuffer();
      const name = `${lang === 'ar' ? 'دليل' : 'Guide'} - ${article.title[lang]}.pdf`;
      await services.openFile(new File([bytes], name, { type: 'application/pdf' }), undefined, { recent: false });
      dispatch({ type: 'DIALOG', dialog: null });
    } catch {
      setFailed('support.pdfFailed');
    } finally {
      setOpening(false);
    }
  };
  const video = article.video;
  return (
    <article className="support-article" data-lead={lead || undefined}>
      <header>
        <h3 dir="auto">{article.title[lang]}</h3>
        <p className="support-muted" dir="auto">
          {article.summary[lang]}
        </p>
      </header>
      <ol className="support-steps">
        {article.steps.map((step, index) => {
          const pic = shotUrl(step.pic, lang);
          const motion = motionUrl(step.pic, lang);
          return (
            <li key={index} dir="auto" style={{ ['--i' as string]: index }}>
              {step[lang]}
              {pic && (
                <picture>
                  {motion && <source srcSet={motion} type="image/webp" media="(prefers-reduced-motion: no-preference)" />}
                  <img className="support-step-pic" src={pic} alt="" loading="lazy" decoding="async" />
                </picture>
              )}
            </li>
          );
        })}
      </ol>
      {article.tips && (
        <ul className="support-tips">
          {article.tips.map((tip, index) => (
            <li key={index} dir="auto">
              {tip[lang]}
            </li>
          ))}
        </ul>
      )}
      <div className="support-actions">
        {article.guide && (
          <>
            <button type="button" className="icon-btn icon-btn-labeled icon-btn-primary" onClick={() => actions.guide(article, 'show')}>
              <Icon of={MousePointerClick} size={14} />
              {t('support.showMe')}
            </button>
            <button type="button" className="icon-btn icon-btn-labeled" onClick={() => actions.guide(article, 'do')}>
              <Icon of={Hand} size={14} />
              {t('support.doIt')}
            </button>
          </>
        )}
        {article.tour && (
          <button type="button" className="icon-btn icon-btn-labeled" onClick={() => actions.tour(article)}>
            <Icon of={Clapperboard} size={14} />
            {t('support.inTour')}
          </button>
        )}
        {video && (
          <button type="button" className="icon-btn icon-btn-labeled" onClick={() => void openOutside(video).then((ok) => setFailed(ok ? null : 'link.openFailed'))}>
            <Icon of={Clapperboard} size={14} />
            {t('support.video')}
          </button>
        )}
        {pdf && (
          <button type="button" className="icon-btn icon-btn-labeled" disabled={opening} onClick={() => void openPdf()}>
            <Icon of={FileText} size={14} />
            {t('support.pdfGuide')}
          </button>
        )}
      </div>
      {failed && (
        <p className="field-error" role="alert">
          {t(failed)}
        </p>
      )}
    </article>
  );
}

/** Opens a web page outside the app; false when it could not (the caller says so). */
async function openOutside(url: string): Promise<boolean> {
  if (isTauriHost()) return openExternalUrl(url).then(() => true, () => false);
  // With noopener a browser gives back no window, so only a throw means it failed.
  try {
    globalThis.open(url, '_blank', 'noopener');
    return true;
  } catch {
    return false;
  }
}

function LearnPage({ desktop, actions, article, onArticle }: { desktop: boolean; actions: ArticleActions; article: string | null; onArticle: (id: string | null) => void }) {
  const { t, lang } = useI18n();
  const [webFailed, setWebFailed] = useState(false);
  const list = useMemo(() => articlesFor(desktop), [desktop]);
  const shown = article ? articleById(article) : undefined;
  if (shown) {
    return (
      <div className="support-learn">
        <button type="button" className="support-back" onClick={() => onArticle(null)}>
          <Icon of={ArrowLeft} size={14} mirror />
          {t('support.learn.all')}
        </button>
        <ArticleCard article={shown} actions={actions} lead />
      </div>
    );
  }
  return (
    <div className="support-learn">
      <div className="support-categories">
        {CATEGORIES.map((category) => {
          const inIt = list.filter((one) => one.category === category.id);
          if (inIt.length === 0) return null;
          return (
            <section key={category.id} className="support-category">
              <h3 className="support-section-title">{category.title[lang]}</h3>
              {inIt.map((one) => (
                <button key={one.id} type="button" className="support-link-row" onClick={() => onArticle(one.id)}>
                  <Icon of={FileText} size={15} />
                  <span dir="auto">{one.title[lang]}</span>
                  {one.guide && <span className="support-badge">{t('support.learn.canShow')}</span>}
                  <Icon of={ArrowRight} size={14} mirror />
                </button>
              ))}
            </section>
          );
        })}
      </div>
      <section className="support-category">
        <h3 className="support-section-title">{t('support.learn.faq')}</h3>
        {FAQ.map((one) => (
          <details key={one.q.en} className="support-faq">
            <summary dir="auto">{one.q[lang]}</summary>
            <p dir="auto">{one.a[lang]}</p>
          </details>
        ))}
      </section>
      <section className="support-category">
        <h3 className="support-section-title">{t('support.learn.known')}</h3>
        <ul className="support-known">
          {KNOWN_ISSUES.map((one) => (
            <li key={one.en} dir="auto">
              {one[lang]}
            </li>
          ))}
        </ul>
      </section>
      <button type="button" className="support-link-row support-web" onClick={() => void openOutside(SUPPORT.website[lang]).then((ok) => setWebFailed(!ok))}>
        <Icon of={Globe} size={15} />
        <span>{t('support.learn.website')}</span>
        <Icon of={ArrowRight} size={14} mirror />
      </button>
      {webFailed && (
        <p className="field-error" role="alert">
          {t('link.openFailed')}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Report */

const KIND_LABEL: Record<TicketKind, TKey> = {
  bug: 'support.kind.bug',
  file: 'support.kind.file',
  question: 'support.kind.question',
  other: 'support.kind.other',
};

const STATUS_LABEL: Record<Ticket['status'], TKey> = {
  sent: 'support.status.sent',
  open: 'support.status.open',
  in_progress: 'support.status.inProgress',
  resolved: 'support.status.resolved',
};

function ReportPage() {
  const { t, lang } = useI18n();
  const [draft, setDraft] = useState<Draft>({ kind: 'bug', text: '', contact: '', includeLog: false, picture: null });
  const [stage, setStage] = useState<'write' | 'review' | 'sending' | 'sent' | 'offline' | 'busy' | 'failed'>('write');
  const [pictureError, setPictureError] = useState(false);
  const [tickets, setTickets] = useState<Ticket[]>(readTickets);
  const [last, setLast] = useState<Ticket | null>(null);
  const [checking, setChecking] = useState(() => readTickets().some((one) => one.via === 'relay' && one.token));
  const [checkFailed, setCheckFailed] = useState(false);
  const [installed, setInstalled] = useState<string | null>(null);
  const facts = useMemo(() => systemFacts(lang, installed ?? undefined), [lang, installed]);
  const fileInput = useRef<HTMLInputElement>(null);
  const logLines = recentLog().length;

  // The installed app's version, not the interface package's.
  useEffect(() => {
    let live = true;
    void appVersion().then((version) => live && setInstalled(version));
    return () => {
      live = false;
    };
  }, []);

  // Looking at the list is asking how the reports stand: only then, and only with reports filed.
  useEffect(() => {
    if (!readTickets().some((one) => one.via === 'relay' && one.token)) return;
    let live = true;
    refreshTickets()
      .then((list) => live && setTickets(list))
      .catch(() => live && setCheckFailed(true))
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
  }, []);

  const setPicture = async (blob: Blob | null) => {
    setPictureError(false);
    if (!blob) return setDraft((old) => ({ ...old, picture: null }));
    try {
      const picture: Picture = await shrinkPicture(blob);
      setDraft((old) => ({ ...old, picture }));
    } catch {
      setPictureError(true);
    }
  };
  const onPaste = (event: ClipboardEvent) => {
    const item = [...event.clipboardData.items].find((one) => one.type.startsWith('image/'));
    const blob = item?.getAsFile();
    if (blob) {
      event.preventDefault();
      void setPicture(blob);
    }
  };

  const send = async () => {
    setStage('sending');
    try {
      const ticket = await sendTicket(draft, facts);
      setLast(ticket);
      setTickets(readTickets());
      setStage('sent');
    } catch (error) {
      setStage(error instanceof RelayError && error.kind === 'busy' ? 'busy' : error instanceof RelayError && error.kind === 'refused' ? 'failed' : 'offline');
    }
  };
  const mail = () => {
    openMail(ticketMail(draft, facts, t('app.name')));
    setLast(keepMailed(draft));
    setTickets(readTickets());
    setStage('sent');
  };
  const reset = () => {
    setDraft({ kind: 'bug', text: '', contact: '', includeLog: false, picture: null });
    setStage('write');
    setLast(null);
  };

  return (
    <div className="support-report" onPaste={onPaste}>
      {stage === 'sent' && last ? (
        <div className="support-done" role="status">
          <Icon of={CheckCircle2} size={28} />
          <p className="support-done-title">{last.via === 'relay' ? t('support.report.sent', { n: last.number ?? last.id.slice(0, 6) }) : t('support.report.mailed')}</p>
          <p className="support-muted">{t('support.report.sentNext')}</p>
          <button type="button" className="icon-btn icon-btn-labeled" onClick={reset}>
            {t('support.report.another')}
          </button>
        </div>
      ) : stage === 'write' ? (
        <form
          className="support-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (validDraft(draft)) setStage('review');
          }}
        >
          <p className="support-muted">{t('support.report.intro')}</p>
          <div className="support-kinds" role="radiogroup" aria-label={t('support.report.kind')}>
            {TICKET_KINDS.map((kind) => (
              <button key={kind} type="button" role="radio" aria-checked={draft.kind === kind} className="support-kind" onClick={() => setDraft((old) => ({ ...old, kind }))}>
                {t(KIND_LABEL[kind])}
              </button>
            ))}
          </div>
          <label className="field">
            <span>{t('support.report.what')}</span>
            <textarea
              className="text-input support-textarea"
              dir="auto"
              rows={5}
              maxLength={LIMITS.text}
              value={draft.text}
              placeholder={t('support.report.whatHint')}
              onChange={(event) => setDraft((old) => ({ ...old, text: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>{t('support.report.contact')}</span>
            <input
              className="text-input"
              dir="auto"
              maxLength={LIMITS.contact}
              value={draft.contact}
              placeholder={t('support.report.contactHint')}
              onChange={(event) => setDraft((old) => ({ ...old, contact: event.target.value }))}
            />
          </label>
          <div className="support-attach">
            <label className="support-check">
              <input type="checkbox" checked={draft.includeLog} onChange={(event) => setDraft((old) => ({ ...old, includeLog: event.target.checked }))} />
              <span>{t('support.report.log', { n: logLines })}</span>
            </label>
            <div className="support-picture">
              {draft.picture ? (
                <figure>
                  <img src={draft.picture.dataUrl} alt={t('support.report.pictureAlt')} />
                  <button type="button" className="icon-btn" aria-label={t('support.report.pictureRemove')} onClick={() => void setPicture(null)}>
                    <Icon of={X} size={14} />
                  </button>
                </figure>
              ) : (
                <button type="button" className="icon-btn icon-btn-labeled" onClick={() => fileInput.current?.click()}>
                  <Icon of={ImagePlus} size={14} />
                  {t('support.report.picture')}
                </button>
              )}
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => {
                  void setPicture(event.target.files?.[0] ?? null);
                  event.target.value = '';
                }}
              />
              <p className="support-muted">{t('support.report.pictureHint')}</p>
              {pictureError && <p className="field-error">{t('support.report.pictureBad')}</p>}
            </div>
          </div>
          <div className="support-actions">
            <button type="submit" className="icon-btn icon-btn-labeled icon-btn-primary" disabled={!validDraft(draft)}>
              {t('support.report.review')}
              <Icon of={ArrowRight} size={14} mirror />
            </button>
          </div>
        </form>
      ) : (
        <div className="support-review">
          <p className="support-section-title">{t('support.report.reviewTitle')}</p>
          <p className="support-muted">{t('support.report.reviewNote')}</p>
          <dl className="support-facts">
            <dt>{t('support.report.kind')}</dt>
            <dd>{t(KIND_LABEL[draft.kind])}</dd>
            <dt>{t('support.report.what')}</dt>
            <dd dir="auto" className="support-pre">
              {draft.text.trim()}
            </dd>
            {draft.contact.trim() && (
              <>
                <dt>{t('support.report.contact')}</dt>
                <dd dir="auto">{draft.contact.trim()}</dd>
              </>
            )}
            <dt>{t('support.report.system')}</dt>
            <dd dir="ltr">
              {facts.app} · {facts.platform} · {facts.lang} · {facts.screen}
            </dd>
            {draft.includeLog && (
              <>
                <dt>{t('support.report.logTitle')}</dt>
                <dd>
                  <details>
                    <summary>{t('support.report.logShow', { n: logLines })}</summary>
                    <pre dir="ltr" className="support-log">
                      {logText() || t('support.report.logEmpty')}
                    </pre>
                  </details>
                </dd>
              </>
            )}
            {draft.picture && (
              <>
                <dt>{t('support.report.pictureTitle')}</dt>
                <dd>
                  <img className="support-review-picture" src={draft.picture.dataUrl} alt={t('support.report.pictureAlt')} />
                </dd>
              </>
            )}
          </dl>
          <p className="support-muted">{t('support.report.privacy')}</p>
          {stage === 'offline' && <p className="support-warning">{t('support.report.offline')}</p>}
          {stage === 'busy' && <p className="support-warning">{t('support.report.busy')}</p>}
          {stage === 'failed' && <p className="support-warning">{t('support.report.failed')}</p>}
          <div className="support-actions">
            <button type="button" className="icon-btn icon-btn-labeled" onClick={() => setStage('write')} disabled={stage === 'sending'}>
              <Icon of={ArrowLeft} size={14} mirror />
              {t('support.report.edit')}
            </button>
            {stage === 'offline' || stage === 'failed' ? (
              <button type="button" className="icon-btn icon-btn-labeled icon-btn-primary" onClick={mail}>
                <Icon of={Mail} size={14} />
                {t('support.report.byMail')}
              </button>
            ) : (
              <button type="button" className="icon-btn icon-btn-labeled icon-btn-primary" onClick={() => void send()} disabled={stage === 'sending' || stage === 'busy'}>
                <Icon of={stage === 'sending' ? Loader2 : Send} size={14} className={stage === 'sending' ? 'support-spin' : undefined} />
                {stage === 'sending' ? t('support.report.sending') : t('support.report.send')}
              </button>
            )}
          </div>
        </div>
      )}
      {tickets.length > 0 && (
        <section className="support-tickets" aria-busy={checking || undefined}>
          <p className="support-section-title">{t('support.report.mine')}</p>
          {checkFailed && (
            <p className="support-muted" role="status">
              {t('support.report.checkFailed')}
            </p>
          )}
          <ul>
            {tickets.map((ticket) => (
              <li key={ticket.id} className="support-ticket" data-status={ticket.status}>
                <div className="support-ticket-main">
                  <span className="support-ticket-summary" dir="auto">
                    {ticket.summary}
                  </span>
                  <span className="support-muted">
                    {new Date(ticket.created).toLocaleDateString(lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB')}
                    {ticket.number ? ` · #${ticket.number}` : ''}
                    {ticket.via === 'email' ? ` · ${t('support.report.viaMail')}` : ''}
                  </span>
                  {ticket.reply && (
                    <span className="support-ticket-reply" dir="auto">
                      {t('support.report.reply')}: {ticket.reply}
                    </span>
                  )}
                </div>
                <span className="support-status" data-status={ticket.status}>
                  <Icon of={ticket.status === 'resolved' ? CheckCircle2 : CircleDot} size={12} />
                  {ticket.status === 'resolved' && ticket.fixedIn ? t('support.status.fixedIn', { v: ticket.fixedIn }) : t(STATUS_LABEL[ticket.status])}
                </span>
                <button type="button" className="icon-btn" aria-label={t('support.report.forget')} title={t('support.report.forget')} onClick={() => setTickets(forgetTicket(ticket.id))}>
                  <Icon of={Trash2} size={13} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Ideas */

const IDEA_STATUS: Record<Idea['status'], TKey> = {
  open: 'support.idea.open',
  planned: 'support.idea.planned',
  building: 'support.idea.building',
  shipped: 'support.idea.shipped',
};

function IdeasPage() {
  const { t, lang } = useI18n();
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading');
  const [sort, setSort] = useState<IdeaSort>('top');
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState(readIdeaDraft);
  const [posting, setPosting] = useState<'idle' | 'posting' | 'failed' | 'busy' | 'links'>('idle');
  const [voting, setVoting] = useState<string | null>(null);

  const fetchIdeas = () =>
    loadIdeas()
      .then((list) => {
        setIdeas(list);
        setState('ready');
      })
      .catch(() => setState('offline'));
  const load = () => {
    setState('loading');
    void fetchIdeas();
  };
  // Opening Ideas is asking for them: the one request this tab makes by itself.
  useEffect(() => {
    void fetchIdeas();
  }, []);
  useEffect(() => writeIdeaDraft(draft.title, draft.body), [draft]);

  const toggle = async (idea: Idea) => {
    setVoting(idea.id);
    const on = !idea.voted;
    try {
      const votes = await vote(idea.id, on);
      setIdeas((list) => list?.map((one) => (one.id === idea.id ? { ...one, voted: on, votes } : one)) ?? null);
    } catch {
      /* the count stays as it was; the next load shows the truth */
    } finally {
      setVoting(null);
    }
  };
  const post = async (event: FormEvent) => {
    event.preventDefault();
    if (!validIdea(draft.title, draft.body)) return;
    setPosting('posting');
    try {
      const idea = await postIdea(draft.title, draft.body, lang);
      setIdeas((list) => [idea, ...(list ?? [])]);
      setDraft({ title: '', body: '' });
      setWriting(false);
      setPosting('idle');
      setSort('new');
    } catch (error) {
      setPosting(error instanceof RelayError && error.kind === 'busy' ? 'busy' : error instanceof RelayError && error.message === 'links' ? 'links' : 'failed');
    }
  };
  const mailIdea = () => {
    const subject = `${t('app.name')} · ${t('support.tab.ideas')}: ${draft.title.trim()}`;
    openMail(`mailto:${SUPPORT.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(draft.body.trim() || draft.title.trim())}`);
  };

  const shown = ideas ? sortIdeas(ideas, sort) : [];
  const form: ReactNode = (
    <form className="support-form support-idea-form" onSubmit={(event) => void post(event)}>
      <label className="field">
        <span>{t('support.idea.title')}</span>
        <input className="text-input" dir="auto" maxLength={LIMITS.ideaTitle} value={draft.title} placeholder={t('support.idea.titleHint')} onChange={(event) => setDraft((old) => ({ ...old, title: event.target.value }))} />
      </label>
      <label className="field">
        <span>{t('support.idea.body')}</span>
        <textarea className="text-input support-textarea" dir="auto" rows={3} maxLength={LIMITS.ideaBody} value={draft.body} onChange={(event) => setDraft((old) => ({ ...old, body: event.target.value }))} />
      </label>
      {posting === 'failed' && <p className="support-warning">{t('support.idea.failed')}</p>}
      {posting === 'busy' && <p className="support-warning">{t('support.idea.busy')}</p>}
      {posting === 'links' && <p className="support-warning">{t('support.idea.links')}</p>}
      <div className="support-actions">
        {state === 'offline' ? (
          <button type="button" className="icon-btn icon-btn-labeled icon-btn-primary" disabled={!validIdea(draft.title, draft.body)} onClick={mailIdea}>
            <Icon of={Mail} size={14} />
            {t('support.idea.byMail')}
          </button>
        ) : (
          <button type="submit" className="icon-btn icon-btn-labeled icon-btn-primary" disabled={!validIdea(draft.title, draft.body) || posting === 'posting'}>
            <Icon of={posting === 'posting' ? Loader2 : Send} size={14} className={posting === 'posting' ? 'support-spin' : undefined} />
            {t('support.idea.post')}
          </button>
        )}
        {state !== 'offline' && (
          <button type="button" className="icon-btn icon-btn-labeled" onClick={() => setWriting(false)}>
            {t('support.idea.cancel')}
          </button>
        )}
      </div>
    </form>
  );

  return (
    <div className="support-ideas">
      <p className="support-muted">{t('support.idea.intro')}</p>
      {state === 'offline' && (
        <div className="support-offline">
          <p className="support-warning">{t('support.idea.offline')}</p>
          <button type="button" className="icon-btn icon-btn-labeled" onClick={load}>
            {t('support.idea.retry')}
          </button>
          {form}
        </div>
      )}
      {state === 'loading' && (
        <p className="support-muted" role="status">
          <Icon of={Loader2} size={14} className="support-spin" /> {t('support.idea.loading')}
        </p>
      )}
      {state === 'ready' && (
        <>
          <div className="support-ideas-bar">
            <div className="support-kinds" role="radiogroup" aria-label={t('support.idea.sort')}>
              {(['top', 'new'] as const).map((one) => (
                <button key={one} type="button" role="radio" aria-checked={sort === one} className="support-kind" onClick={() => setSort(one)}>
                  {t(one === 'top' ? 'support.idea.top' : 'support.idea.new')}
                </button>
              ))}
            </div>
            {!writing && (
              <button type="button" className="icon-btn icon-btn-labeled icon-btn-primary" onClick={() => setWriting(true)}>
                <Icon of={Lightbulb} size={14} />
                {t('support.idea.write')}
              </button>
            )}
          </div>
          {writing && form}
          {shown.length === 0 ? (
            <p className="support-muted">{t('support.idea.none')}</p>
          ) : (
            <ul className="support-idea-list">
              {shown.map((idea) => (
                <li key={idea.id} className="support-idea" data-status={idea.status}>
                  <button
                    type="button"
                    className="support-vote"
                    aria-pressed={idea.voted}
                    aria-label={t(idea.voted ? 'support.idea.unvote' : 'support.idea.vote', { n: idea.votes })}
                    disabled={voting === idea.id || idea.status === 'shipped'}
                    onClick={() => void toggle(idea)}
                  >
                    <Icon of={ChevronUp} size={16} />
                    <span>{idea.votes}</span>
                  </button>
                  <div className="support-idea-main">
                    <p className="support-idea-title" dir="auto">
                      {idea.title}
                    </p>
                    {idea.body && (
                      <p className="support-muted" dir="auto">
                        {idea.body}
                      </p>
                    )}
                    <p className="support-idea-meta">
                      {idea.status !== 'open' && (
                        <span className="support-status" data-status={idea.status}>
                          {idea.status === 'shipped' && idea.shippedIn ? t('support.idea.shippedIn', { v: idea.shippedIn }) : t(IDEA_STATUS[idea.status])}
                        </span>
                      )}
                      {idea.mine && <span className="support-badge">{t('support.idea.mine')}</span>}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <p className="support-muted support-note">{t('support.idea.privacy')}</p>
    </div>
  );
}
