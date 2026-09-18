import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { ArrowLeftRight, FileDown, FilePlus2, GitCompare, LocateFixed, LockKeyhole } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import type { CoreClient } from '../core/client';
import { isTauriHost, pickPdfFile } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import type { Direction, TKey, TParams } from '../i18n/messages';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { isPdf } from '../state/pdfFile';
import { comparisonFileName } from '../state/saveFile';
import { comparePages } from './comparison';
import type { Passage } from './comparison';
import { EXACT } from './normalize';
import type { CompareOptions } from './normalize';
import { comparisonReport, isolate } from './report';
import { findRevisions } from './revisions';
import type { Revision } from './revisions';
import './compare.css';

type Translate = (key: TKey, params?: TParams) => string;

/** A PDF chosen to compare the open file with. */
interface OtherFile {
  name: string;
  bytes: ArrayBuffer;
  /** Null while it is locked. */
  pages: number | null;
  locked: boolean;
  /** The password that opened it, if it needed one. */
  password: string | undefined;
  /** What is typed in its password field. */
  typed: string;
  /** The last password tried did not open it. */
  wrong: boolean;
}

/** One side of a comparison: which version it is, and the text of its pages. */
interface Version {
  is: { kind: 'open'; name: string } | { kind: 'revision'; number: number; name: string } | { kind: 'file'; name: string };
  pages: string[];
}

interface Texts {
  /** The open file they were read for: another one open makes them stale. */
  bytes: ArrayBuffer;
  older: Version;
  newer: Version;
  /** Which side is the open document, the one Go to page moves through. */
  open: 'older' | 'newer';
}

/**
 * Every page's text by Warraq's own reading (`extract_text`: logical order,
 * so Arabic compares as it is read, not as PDFium lays it out).
 */
async function readPages(client: CoreClient, bytes: ArrayBuffer, password?: string): Promise<string[]> {
  const doc = await client.open(bytes, password);
  try {
    const pages: string[] = [];
    for (let index = 0; index < doc.pageCount; index += 1) pages.push(await doc.extract_text(index));
    return pages;
  } finally {
    void doc.free();
  }
}

/** A file's page count, or `locked` when it needs a password it was not given. */
async function probe(client: CoreClient, bytes: ArrayBuffer, password?: string): Promise<number | 'locked'> {
  try {
    const doc = await client.open(bytes.slice(0), password);
    const pages = doc.pageCount;
    void doc.free();
    return pages;
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'E_PASSWORD') return 'locked';
    throw error;
  }
}

/**
 * One passage of a changed page. Struck-through removals and underlined
 * additions differ without colour, and hidden words announce each to a screen
 * reader; those carry the interface's `dir`, which keeps them out of the
 * passage's own `dir="auto"`.
 */
function PassageText({ passage, t, dir }: { passage: Passage; t: Translate; dir: Direction }) {
  return (
    <p dir="auto" className="compare-passage">
      {passage.before && '… '}
      {passage.parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && ' '}
          {part.kind === 'same' && part.text}
          {part.kind === 'removed' && (
            <del className="compare-removed">
              <span className="sr-only" dir={dir}>{`${t('compare.srRemoved')} `}</span>
              {part.text}
              <span className="sr-only" dir={dir}>{` ${t('compare.srRemovedEnd')}`}</span>
            </del>
          )}
          {part.kind === 'added' && (
            <ins className="compare-added">
              <span className="sr-only" dir={dir}>{`${t('compare.srAdded')} `}</span>
              {part.text}
              <span className="sr-only" dir={dir}>{` ${t('compare.srAddedEnd')}`}</span>
            </ins>
          )}
        </Fragment>
      ))}
      {passage.after && ' …'}
    </p>
  );
}

/**
 * Compare: what changed in the text between the open file and an earlier
 * revision of it, or another PDF — page by page, word by word, with the
 * Arabic-aware options of Warraq's search. The results stay in this pane,
 * beside the document, so Go to page shows the change next to its account.
 */
export function ComparePanel() {
  const { t, lang, dir } = useI18n();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const { client, documentBytes: bytes, documentPassword: password } = services;
  const [source, setSource] = useState<'revision' | 'file'>('revision');
  const [found, setFound] = useState<{ bytes: ArrayBuffer; revisions: Revision[] | null } | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [other, setOther] = useState<OtherFile | null>(null);
  const [options, setOptions] = useState<CompareOptions>(EXACT);
  const [busy, setBusy] = useState(false);
  const [texts, setTexts] = useState<Texts | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const ids = useId();

  // The revisions inside the file as it was handed to the view: every prefix
  // ending at an earlier %%EOF that the core opens.
  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    const pagesOf = async (prefix: ArrayBuffer) => {
      try {
        const doc = await client.open(prefix, password);
        const pages = doc.pageCount;
        void doc.free();
        return pages;
      } catch {
        return null;
      }
    };
    findRevisions(new Uint8Array(bytes), pagesOf)
      .then((revisions) => {
        if (!cancelled) setFound({ bytes, revisions });
      })
      .catch(() => {
        if (!cancelled) setFound({ bytes, revisions: null });
      });
    return () => {
      cancelled = true;
    };
  }, [bytes, client, password]);

  // Undefined while they are being looked for, null if that failed.
  const revisions = found && found.bytes === bytes ? found.revisions : undefined;
  const earlier = revisions?.slice(0, -1) ?? [];
  const selected = earlier.find((revision) => revision.number === chosen) ?? earlier.at(-1);
  const shown = texts && texts.bytes === bytes ? texts : null;
  const result = useMemo(() => (shown ? comparePages(shown.older.pages, shown.newer.pages, options) : null), [shown, options]);

  const ready = state.view === 'viewer' && state.document !== null && bytes !== null && !busy && state.switching === null;
  const canCompare = ready && (source === 'revision' ? selected !== undefined : other !== null && !other.locked);

  /** A version as a sentence of the interface, its file name isolated for bidi. */
  const nameOf = (version: Version) =>
    version.is.kind === 'open'
      ? t('compare.openNow', { name: isolate(version.is.name) })
      : version.is.kind === 'revision'
        ? t('compare.revisionOf', { n: version.is.number, name: isolate(version.is.name) })
        : isolate(version.is.name);

  const compare = async () => {
    const name = state.document?.name;
    if (!bytes || !name) return;
    setBusy(true);
    try {
      // The open file as it stands now, with whatever either engine has changed.
      const current = await services.currentFileBytes();
      if (!current) throw new Error('E_NOT_FOUND: no open file');
      const open: Version = { is: { kind: 'open', name }, pages: await readPages(client, current, password) };
      if (source === 'revision' && selected) {
        const pages = await readPages(client, bytes.slice(0, selected.length), password);
        setTexts({ bytes, older: { is: { kind: 'revision', number: selected.number, name }, pages }, newer: open, open: 'newer' });
      } else if (source === 'file' && other && !other.locked) {
        const pages = await readPages(client, other.bytes.slice(0), other.password);
        setTexts({ bytes, older: open, newer: { is: { kind: 'file', name: other.name }, pages }, open: 'older' });
      }
    } catch {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'compare.failed' });
    } finally {
      setBusy(false);
    }
  };

  /** A chosen PDF: tried without a password, then with the open file's, then it asks. */
  const take = async (name: string, data: ArrayBuffer) => {
    try {
      let pages = await probe(client, data);
      let used: string | undefined;
      if (pages === 'locked' && password) {
        pages = await probe(client, data, password);
        used = password;
      }
      setOther(
        pages === 'locked'
          ? { name, bytes: data, pages: null, locked: true, password: undefined, typed: '', wrong: false }
          : { name, bytes: data, pages, locked: false, password: used, typed: '', wrong: false },
      );
    } catch {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'compare.unreadable' });
    }
  };

  const choose = () => {
    if (!isTauriHost()) {
      inputRef.current?.click();
      return;
    }
    // The desktop webview ignores file inputs: the native panel instead.
    void pickPdfFile()
      .then((picked) => (picked ? take(picked.name, picked.bytes) : undefined))
      .catch(() => dispatch({ type: 'DOCUMENT_FAILED', error: 'compare.unreadable' }));
  };

  const onInput = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!(await isPdf(file))) {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'error.notPdf' });
      return;
    }
    await take(file.name, await file.arrayBuffer());
  };

  const unlock = async () => {
    if (!other || other.typed.length === 0) return;
    const { bytes: tried, typed } = other;
    const pages = await probe(client, tried, typed).catch(() => 'locked' as const);
    // Another file may have been chosen while this one was being tried.
    setOther((current) =>
      current?.bytes !== tried
        ? current
        : pages === 'locked'
          ? { ...current, wrong: true }
          : { ...current, locked: false, pages, password: typed, wrong: false },
    );
  };

  const swap = () =>
    setTexts((current) => current && { ...current, older: current.newer, newer: current.older, open: current.open === 'older' ? 'newer' : 'older' });

  const saveReport = () => {
    if (!result || !shown) return;
    const html = comparisonReport({
      comparison: result,
      options,
      older: nameOf(shown.older),
      newer: nameOf(shown.newer),
      date: new Intl.DateTimeFormat(lang, { dateStyle: 'long' }).format(new Date()),
      lang,
      t,
    });
    void services
      .saveReport(html, comparisonFileName(state.document?.name ?? 'document'))
      .catch(() => dispatch({ type: 'DOCUMENT_FAILED', error: 'file.saveFailed' }));
  };

  const openPages = shown ? shown[shown.open].pages.length : 0;
  const swappable = shown !== null && (shown.older.is.kind === 'file' || shown.newer.is.kind === 'file');

  return (
    <div className="tool-panel">
      <h3>
        <Icon of={GitCompare} />
        {t('tool.compare')}
      </h3>
      {state.document === null && <p className="tool-panel-note">{t('tool.openFirst')}</p>}
      <p className="tool-panel-note">{t('compare.intro')}</p>

      <fieldset className="compare-choice" disabled={!ready}>
        <legend>{t('compare.source')}</legend>
        <label className="compare-option">
          <input type="radio" name={`${ids}-source`} checked={source === 'revision'} onChange={() => setSource('revision')} />
          <span>{t('compare.sourceRevision')}</span>
        </label>
        <label className="compare-option">
          <input type="radio" name={`${ids}-source`} checked={source === 'file'} onChange={() => setSource('file')} />
          <span>{t('compare.sourceFile')}</span>
        </label>
      </fieldset>

      {source === 'revision' &&
        state.document !== null &&
        (revisions === undefined ? (
          <p className="tool-panel-note" role="status">
            {t('compare.finding')}
          </p>
        ) : revisions === null ? (
          <p className="field-error" role="alert">
            {t('compare.findFailed')}
          </p>
        ) : earlier.length === 0 ? (
          <p className="compare-alone" role="status">
            {t('compare.oneRevision')}
          </p>
        ) : (
          <fieldset className="compare-choice" disabled={!ready}>
            <legend>{t('compare.revisions')}</legend>
            {earlier.map((revision) => (
              <label key={revision.number} className="compare-option">
                <input
                  type="radio"
                  name={`${ids}-revision`}
                  checked={selected?.number === revision.number}
                  onChange={() => setChosen(revision.number)}
                />
                <span className="compare-option-text">
                  <span>{t('compare.revision', { n: revision.number })}</span>
                  <span className="compare-option-note">{t('compare.pages', { count: revision.pages ?? 0 })}</span>
                </span>
              </label>
            ))}
            <p className="compare-option-note">{t('compare.current', { n: revisions.length })}</p>
          </fieldset>
        ))}

      {source === 'file' && (
        <>
          <div className="tool-actions">
            <IconButton label={t('compare.choose')} icon={<Icon of={FilePlus2} />} showLabel disabled={!ready} onClick={choose} />
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => void onInput(event)}
          />
          {other && (
            <div className="compare-file">
              <div className="compare-file-row">
                <span className="compare-file-name" dir="auto" title={other.name}>
                  {other.name}
                </span>
                <span className="compare-file-pages">
                  {other.locked ? <Icon of={LockKeyhole} /> : t('compare.pages', { count: other.pages ?? 0 })}
                </span>
              </div>
              {other.locked && (
                <form
                  className="compare-unlock"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void unlock();
                  }}
                >
                  <label className="field">
                    <span>{t('compare.password', { name: other.name })}</span>
                    <input
                      className="text-input"
                      type="password"
                      dir="auto"
                      autoComplete="off"
                      value={other.typed}
                      onChange={(event) => {
                        const typed = event.target.value;
                        setOther((current) => current && { ...current, typed, wrong: false });
                      }}
                    />
                  </label>
                  {other.wrong && (
                    <p className="field-error" role="alert">
                      {t('password.wrong')}
                    </p>
                  )}
                  <button type="submit" className="icon-btn icon-btn-labeled" disabled={other.typed.length === 0}>
                    {t('compare.unlock')}
                  </button>
                </form>
              )}
            </div>
          )}
        </>
      )}

      <div className="compare-options">
        <label className="compare-option">
          <input
            type="checkbox"
            checked={options.ignoreMarks}
            onChange={(event) => setOptions({ ...options, ignoreMarks: event.target.checked })}
          />
          <span>{t('compare.ignoreMarks')}</span>
        </label>
        <label className="compare-option">
          <input
            type="checkbox"
            checked={options.unifyLetters}
            onChange={(event) => setOptions({ ...options, unifyLetters: event.target.checked })}
          />
          <span>{t('compare.unifyLetters')}</span>
        </label>
        <p className="compare-option-note">{t('compare.optionsNote')}</p>
      </div>

      <div className="tool-actions">
        <IconButton
          label={busy ? t('compare.working') : t('compare.go')}
          icon={<Icon of={GitCompare} />}
          showLabel
          variant="primary"
          disabled={!canCompare}
          aria-busy={busy}
          onClick={() => void compare()}
        />
      </div>
      <p className="tool-panel-note">{t('compare.note')}</p>

      {result && shown && (
        <section className="compare-results" aria-label={t('compare.results')}>
          <dl className="compare-versions">
            <dt>{t('compare.older')}</dt>
            <dd>{nameOf(shown.older)}</dd>
            <dt>{t('compare.newer')}</dt>
            <dd>{nameOf(shown.newer)}</dd>
          </dl>
          <div className="compare-summary" role="status">
            {result.olderWords + result.newerWords === 0 ? (
              <p>{t('compare.noText')}</p>
            ) : result.changed.length === 0 ? (
              <p>{t('compare.noChanges')}</p>
            ) : (
              <ul>
                <li>{t('compare.pagesChanged', { count: result.changed.length })}</li>
                <li>{t('compare.wordsAdded', { count: result.added })}</li>
                <li>{t('compare.wordsRemoved', { count: result.removed })}</li>
              </ul>
            )}
          </div>
          {result.olderPages !== result.newerPages && (
            <p className="tool-panel-note">
              {t('compare.pageCountsDiffer', { older: result.olderPages, newer: result.newerPages })}
            </p>
          )}
          <div className="tool-actions">
            <IconButton label={t('compare.save')} icon={<Icon of={FileDown} />} showLabel onClick={saveReport} />
            {swappable && <IconButton label={t('compare.swap')} icon={<Icon of={ArrowLeftRight} />} showLabel onClick={swap} />}
          </div>
          {result.changed.map((change) => (
            <article key={change.page} className="compare-page" aria-labelledby={`${ids}-page-${change.page}`}>
              <div className="compare-page-head">
                <h4 id={`${ids}-page-${change.page}`}>{t('compare.page', { page: change.page })}</h4>
                {change.page <= openPages && (
                  <IconButton
                    label={t('compare.goTo', { page: change.page })}
                    icon={<Icon of={LocateFixed} />}
                    showLabel
                    onClick={() => services.goToPage(change.page)}
                  />
                )}
              </div>
              <p className="compare-page-words">{t('compare.pageWords', { added: change.added, removed: change.removed })}</p>
              {!change.inOlder && <p className="tool-panel-note">{t('compare.onlyNewer')}</p>}
              {!change.inNewer && <p className="tool-panel-note">{t('compare.onlyOlder')}</p>}
              {change.passages.map((passage, index) => (
                <PassageText key={index} passage={passage} t={t} dir={dir} />
              ))}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
