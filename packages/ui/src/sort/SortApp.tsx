import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import {
  Check,
  CircleAlert,
  Combine,
  FileText,
  FolderTree,
  Loader2,
  Mic,
  PenLine,
  RotateCcw,
  Scissors,
  Sparkles,
  X,
} from 'lucide-react';
import '../styles/tokens.css';
import '../styles/looks.css';
import '../styles/appearance.css';
import '../styles/fonts.css';
import '../styles/base.css';
import '../styles/components.css';
import './sort.css';
import { applyAppearance } from '../settings/SettingsEffects';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { ZoodMark } from '../components/ZoodMark';
import { getSharedCoreClient } from '../core/client';
import {
  SORT_SAY_EVENT,
  isSortWindow,
  onHostEvent,
  readBatchFile,
  sortApply,
  sortClose,
  sortJob,
  sortListen,
  sortLook,
  sortMade,
  sortUndo,
  writeBatchResult,
} from '../core/host-tauri';
import type { SortJob, SortStep } from '../core/host-tauri';
import { DEFAULT_CREATE_OPTIONS, createPdf } from '../create/createPdf';
import { appCreateEnvironment } from '../create/environment';
import { I18nProvider } from '../i18n/I18nProvider';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { translate } from '../i18n/messages';
import { defaultLook, readPreferences } from '../state/preferences';
import { languageOf } from '../ask/plan';
import { talk } from '../ask/voice';
import { guessTopics } from './ai';
import { KIND_ORDER, filesOf, stemOf, suggest, topicsOf } from './plan';
import type { FileLook, Shelf, SortFile, Suggestion, SuggestionKind, Topic } from './plan';
import { readAnswer } from './voice';

/**
 * The Sort window (`src-tauri/src/sort.rs`): the files thrown on ZOOD, what
 * ZOOD suggests for them, and a Do it / Skip on each, Do all, Undo, and
 * Speak, which hands the answer to Ask ZOOD's ear (`voice.ts` reads it).
 * New files (merged, split) are written beside the others and told to the
 * host; the originals they were made of go into an "Originals" folder,
 * never deleted. Everything is undone in one step.
 */

type Status = 'reading' | 'ready' | 'working';
type Outcome = 'done' | 'skipped' | 'failed';

const ICONS: Record<SuggestionKind, typeof Combine> = {
  merge: Combine,
  split: Scissors,
  rename: PenLine,
  folders: FolderTree,
};

const shelfKey = (shelf: Shelf) => `sort.shelf.${shelf}` as TKey;
const topicKey = (topic: Topic) => `sort.topic.${topic}` as TKey;

function SortWindow() {
  const { t, lang } = useI18n();
  const client = useMemo(() => getSharedCoreClient(), []);
  const [job, setJob] = useState<SortJob | null>(null);
  const [failedToLoad, setFailedToLoad] = useState(false);
  const [looks, setLooks] = useState<Map<number, FileLook>>(new Map());
  const [read, setRead] = useState(0);
  const [guessed, setGuessed] = useState<Map<number, Topic>>(new Map());
  const [thinking, setThinking] = useState(false);
  const [status, setStatus] = useState<Status>('reading');
  const [outcomes, setOutcomes] = useState<Map<string, Outcome>>(new Map());
  const [open, setOpen] = useState<string | null>(null);
  const [heard, setHeard] = useState<{ words: string; reply: string } | null>(null);
  const [problem, setProblem] = useState<TKey | null>(null);
  const [frozen, setFrozen] = useState<Suggestion[] | null>(null);
  // The originals of merges and splits, put away: for the work (a ref) and for the list (state).
  const retired = useRef<Set<number>>(new Set());
  const [putAway, setPutAway] = useState<ReadonlySet<number>>(new Set());
  const stopGuessing = useRef<AbortController | null>(null);

  useEffect(() => {
    document.title = t('sort.title');
  }, [t]);

  useEffect(() => {
    const root = document.documentElement;
    const { theme, look } = readPreferences();
    if (theme && theme !== 'system') root.dataset.theme = theme;
    const shown = look ?? defaultLook();
    if (shown !== 'glass') root.dataset.look = shown;
    applyAppearance(root);
  }, []);

  // The files, then what each says, one at a time so the window shows progress.
  useEffect(() => {
    if (!isSortWindow()) return;
    let live = true;
    void (async () => {
      const first = await sortJob().catch(() => null);
      if (!live) return;
      if (!first) return setFailedToLoad(true);
      setJob(first);
      const found = new Map<number, FileLook>();
      for (const file of first.files) {
        if (!live) return;
        if (file.kind === 'pdf' || file.kind === 'documents') {
          const look = await sortLook(file.index).catch(() => null);
          if (look) found.set(file.index, look);
        }
        setRead((n) => n + 1);
      }
      if (!live) return;
      setLooks(found);
      setStatus('ready');
      // The on-device model then names the kind of the documents the rules could not.
      const controller = new AbortController();
      stopGuessing.current = controller;
      setThinking(true);
      await guessTopics(
        first.files,
        found,
        topicsOf(first.files, found),
        (file, topic) => topic && setGuessed((current) => new Map(current).set(file, topic)),
        controller.signal,
      ).catch(() => undefined);
      if (live) setThinking(false);
    })();
    return () => {
      live = false;
    };
  }, []);

  const word = useMemo(() => (topic: Topic) => t(topicKey(topic)), [t]);

  // The suggestions follow what is read and guessed until the person acts;
  // then they stay put (`frozen`) while files move and new ones appear.
  const live = useMemo(
    () => (job && status !== 'reading' ? suggest(job.files, looks, word, guessed) : []),
    [job, looks, status, word, guessed],
  );
  const suggestions = frozen ?? live;

  useEffect(() => () => stopGuessing.current?.abort(), []);

  const files = job?.files ?? [];
  const fileName = (index: number) => files.find((f) => f.index === index)?.name ?? '';
  const folderName = (shelf: Shelf) => t(shelfKey(shelf));

  const title = (s: Suggestion): string => {
    switch (s.kind) {
      case 'merge':
        return t(s.as === 'pdf' ? 'sort.merge.pdfs' : 'sort.merge.pictures', { count: s.files.length, name: s.name });
      case 'split':
        return t('sort.split', { name: fileName(s.file), count: s.parts.length });
      case 'rename':
        return t('sort.rename', { count: s.names.length });
      case 'folders':
        return t('sort.folders', { count: s.shelves.length });
    }
  };

  /* ------------------------------------------------------------- doing */

  const write = async (bytes: ArrayBuffer | Uint8Array, name: string) => {
    if (!job) throw new Error('E_SORT: no files');
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return writeBatchResult(data, `${name}.pdf`, { dir: job.folder });
  };

  /** The originals of a merge or a split go into the Originals folder, kept. */
  const retire = async (indexes: number[]) => {
    indexes.forEach((i) => retired.current.add(i));
    setPutAway(new Set(retired.current));
    return sortApply(indexes.map((file) => ({ file, folder: folderName('originals') })));
  };

  const doOne = async (s: Suggestion, current: SortJob): Promise<SortJob> => {
    const pathOf = (index: number) => current.files.find((f) => f.index === index)?.path ?? '';
    switch (s.kind) {
      case 'merge': {
        const blobs = await Promise.all(s.files.map((i) => readBatchFile(pathOf(i))));
        let bytes: ArrayBuffer | Uint8Array;
        if (s.as === 'pdf') {
          const { blobs: made } = await client.callStatic<{ pageCount: number }>('pages.combine', { passwords: s.files.map(() => null) }, blobs);
          if (!made[0]) throw new Error('E_COMBINE: nothing came back');
          bytes = made[0];
        } else {
          const sources = s.files.map((i, k) => ({ name: fileName(i), bytes: blobs[k]! }));
          bytes = (await createPdf(sources, DEFAULT_CREATE_OPTIONS, appCreateEnvironment(client))).bytes;
        }
        const written = await write(bytes, s.name || t('sort.mergedName'));
        const next = await sortMade([written]);
        const made = next.files.find((f) => f.path === written);
        if (made) carryTopic(made.index, s.files[0]!);
        return retire(s.files);
      }
      case 'split': {
        const open = await client.open(await readBatchFile(pathOf(s.file)));
        const written: string[] = [];
        try {
          for (const [k, pages] of s.parts.entries()) {
            const { blobs } = await open.call('pages.extract', { pages });
            if (!blobs[0]) throw new Error('E_SPLIT: a part came back empty');
            written.push(await write(blobs[0], `${stemOf(fileName(s.file))} ${k + 1}`));
          }
        } finally {
          void open.free();
        }
        const next = await sortMade(written);
        for (const path of written) {
          const made = next.files.find((f) => f.path === path);
          if (made) carryTopic(made.index, s.file);
        }
        return retire([s.file]);
      }
      case 'rename':
        return sortApply(s.names.filter((n) => !retired.current.has(n.file)).map((n) => ({ file: n.file, name: n.name })));
      case 'folders': {
        // Every file not put away as an original, the new ones too, by what it is now.
        const topics = topicsOf(current.files, looks, guessedRef.current);
        const steps: SortStep[] = current.files
          .filter((f) => !retired.current.has(f.index))
          .map((f) => ({ file: f.index, folder: folderName(topics.get(f.index) ?? carried.current.get(f.index) ?? f.kind) }));
        return sortApply(steps);
      }
    }
  };

  /** A file ZOOD made is about what its source was about. */
  const carried = useRef<Map<number, Topic>>(new Map());
  const guessedRef = useRef(guessed);
  useEffect(() => {
    guessedRef.current = guessed;
  }, [guessed]);
  const carryTopic = (made: number, from: number) => {
    const source = files.find((f) => f.index === from);
    const topic = source ? (topicsOf([source], looks, guessedRef.current).get(from) ?? null) : null;
    if (topic) carried.current.set(made, topic);
  };

  /** Does the chosen suggestions, in the order that keeps new files sorted too. */
  const run = async (chosen: Suggestion[], skip: Suggestion[] = []) => {
    if (!job || status === 'working') return;
    stopGuessing.current?.abort();
    setFrozen(suggestions);
    setProblem(null);
    setStatus('working');
    let current = job;
    const marks = new Map(outcomes);
    skip.forEach((s) => marks.set(s.id, 'skipped'));
    const ordered = [...chosen].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
    for (const s of ordered) {
      if (marks.has(s.id)) continue;
      try {
        current = await doOne(s, current);
        marks.set(s.id, 'done');
      } catch {
        marks.set(s.id, 'failed');
        setProblem('sort.problem.failed');
      }
      setOutcomes(new Map(marks));
      setJob(current);
    }
    setOutcomes(new Map(marks));
    setJob(current);
    setStatus('ready');
  };

  const pending = suggestions.filter((s) => !outcomes.has(s.id));

  const undo = async () => {
    if (status === 'working') return;
    setStatus('working');
    try {
      const back = await sortUndo();
      retired.current.clear();
      setPutAway(new Set());
      carried.current.clear();
      setJob(back);
      setOutcomes(new Map());
      setFrozen(null);
    } catch {
      setProblem('sort.problem.undo');
    }
    setStatus('ready');
  };

  /* -------------------------------------------------------------- voice */

  const answer = useEffectEvent((words: string) => {
    const said = readAnswer(words);
    const language = languageOf(words);
    const say = (key: TKey, params?: Record<string, string | number>) => {
      const reply = translate(language, key, params);
      setHeard({ words, reply });
      void talk(reply).catch(() => undefined);
    };
    if (said.kind === 'unknown') return say('sort.voice.unknown');
    if (said.kind === 'undo') {
      say('sort.voice.undo');
      return void undo();
    }
    if (said.kind === 'close') {
      say('sort.voice.close');
      return void window.setTimeout(() => void sortClose(), 900);
    }
    const chosen = pending.filter((s) => !said.skip.includes(s.kind) && (said.all || said.only.includes(s.kind)));
    const skipped = pending.filter((s) => said.skip.includes(s.kind));
    if (chosen.length === 0) return say('sort.voice.nothing');
    say('sort.voice.doing', { what: [...new Set(chosen.map((s) => translate(language, `sort.kind.${s.kind}` as TKey)))].join(language === 'ar' ? '، ' : ', ') });
    void run(chosen, skipped);
  });

  useEffect(() => onHostEvent<{ words: string }>(SORT_SAY_EVENT, (said) => answer(said.words)), []);

  // Esc closes, unless work is under way.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && status !== 'working') void sortClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status]);

  /* ------------------------------------------------------------- render */

  if (!isSortWindow() || failedToLoad) {
    return (
      <main className="sort" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
        <p className="sort-empty">{t('sort.unavailable')}</p>
      </main>
    );
  }

  const anyDone = [...outcomes.values()].includes('done');
  const detail = (s: Suggestion) => {
    switch (s.kind) {
      case 'merge':
        return (
          <ol className="sort-list">
            {s.files.map((i) => (
              <li key={i} dir="auto">{fileName(i)}</li>
            ))}
          </ol>
        );
      case 'split':
        return (
          <ol className="sort-list">
            {s.parts.map((pages, k) => (
              <li key={k}>{t('sort.split.part', { part: k + 1, from: pages[0]! + 1, to: pages[pages.length - 1]! + 1 })}</li>
            ))}
          </ol>
        );
      case 'rename':
        return (
          <ul className="sort-list">
            {s.names.map((n) => (
              <li key={n.file} className="sort-rename">
                <bdi className="sort-old">{fileName(n.file)}</bdi>
                <span aria-hidden="true">{lang === 'ar' ? '←' : '→'}</span>
                <bdi>{n.name}</bdi>
              </li>
            ))}
          </ul>
        );
      case 'folders':
        return (
          <ul className="sort-shelves">
            {s.shelves.map((shelf) => (
              <li key={shelf.shelf} className="sort-shelf">
                <Icon of={FolderTree} size={16} />
                <span className="sort-shelf-name">{folderName(shelf.shelf)}</span>
                <span className="sort-shelf-count">{shelf.files.length}</span>
              </li>
            ))}
          </ul>
        );
    }
  };

  return (
    <main className="sort" aria-labelledby="sort-title">
      <header className="sort-head">
        <span className="sort-mark" aria-hidden="true">
          <ZoodMark size={28} />
        </span>
        <div className="sort-heading">
          <h1 id="sort-title" className="sort-title">
            {t('sort.title')}
          </h1>
          <p className="sort-sub">{t('sort.from', { count: files.length, folder: job?.folderName ?? '' })}</p>
        </div>
        <IconButton label={t('sort.close')} icon={<Icon of={X} />} disabled={status === 'working'} onClick={() => void sortClose()} />
      </header>

      <ul className="sort-files" aria-label={t('sort.files', { count: files.length })}>
        {files.slice(0, 24).map((file: SortFile) => (
          <li key={file.index} className={putAway.has(file.index) ? 'sort-file sort-file-retired' : file.made ? 'sort-file sort-file-made' : 'sort-file'} title={file.path}>
            <Icon of={file.made ? Sparkles : FileText} size={14} />
            <bdi>{file.name}</bdi>
          </li>
        ))}
        {files.length > 24 ? <li className="sort-file sort-more">{t('sort.more', { count: files.length - 24 })}</li> : null}
      </ul>

      {status === 'reading' ? (
        <p className="sort-status" role="status">
          <Icon of={Loader2} className="sort-spin" /> {t('sort.reading', { done: read, count: files.length })}
        </p>
      ) : null}

      {status !== 'reading' && suggestions.length === 0 ? <p className="sort-empty">{t('sort.nothing')}</p> : null}

      <section className="sort-suggestions" aria-label={t('sort.suggestions')}>
        {suggestions.map((s) => {
          const outcome = outcomes.get(s.id);
          return (
            <article key={s.id} className={outcome ? `sort-card sort-card-${outcome}` : 'sort-card'}>
              <button type="button" className="sort-card-head" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>
                <span className="sort-card-icon">
                  <Icon of={ICONS[s.kind]} size={20} />
                </span>
                <span className="sort-card-text">
                  <span className="sort-card-title" dir="auto">{title(s)}</span>
                  <span className="sort-card-note">{t(`sort.note.${s.kind}` as TKey, { count: filesOf(s).length })}</span>
                </span>
              </button>
              {open === s.id ? <div className="sort-card-detail">{detail(s)}</div> : null}
              <div className="sort-card-actions">
                {outcome === 'done' ? (
                  <span className="sort-outcome"><Icon of={Check} size={16} /> {t('sort.done')}</span>
                ) : outcome === 'skipped' ? (
                  <span className="sort-outcome">{t('sort.skipped')}</span>
                ) : outcome === 'failed' ? (
                  <span className="sort-outcome sort-outcome-failed"><Icon of={CircleAlert} size={16} /> {t('sort.failed')}</span>
                ) : (
                  <>
                    <button type="button" className="sort-skip" disabled={status === 'working'} onClick={() => {
                        setFrozen(suggestions);
                        setOutcomes(new Map(outcomes).set(s.id, 'skipped'));
                      }}>
                      {t('sort.skip')}
                    </button>
                    <button type="button" className="sort-do" disabled={status !== 'ready'} onClick={() => void run([s])}>
                      {t('sort.doIt')}
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </section>

      {thinking && status !== 'reading' ? (
        <p className="sort-status sort-thinking" role="status">
          <Icon of={Sparkles} size={14} /> {t('sort.thinking')}
        </p>
      ) : null}

      {heard ? (
        <p className="sort-heard" role="status">
          <span className="sort-heard-words" dir="auto">“{heard.words}”</span>
          <span dir="auto">{heard.reply}</span>
        </p>
      ) : null}

      {problem ? (
        <p className="sort-problem" role="alert">
          {t(problem)}
        </p>
      ) : null}

      <footer className="sort-foot">
        <IconButton label={t('sort.speak')} icon={<Icon of={Mic} />} showLabel disabled={status === 'working'} onClick={() => void sortListen().catch(() => setProblem('sort.problem.voice'))} />
        {anyDone ? <IconButton label={t('sort.undo')} icon={<Icon of={RotateCcw} />} showLabel disabled={status === 'working'} onClick={() => void undo()} /> : null}
        <span className="sort-foot-gap" />
        {pending.length > 0 ? (
          <IconButton
            label={status === 'working' ? t('sort.working') : t('sort.doAll', { count: pending.length })}
            icon={<Icon of={status === 'working' ? Loader2 : Sparkles} className={status === 'working' ? 'sort-spin' : undefined} />}
            showLabel
            variant="primary"
            disabled={status !== 'ready'}
            onClick={() => void run(pending)}
          />
        ) : (
          <IconButton label={t('sort.finish')} icon={<Icon of={Check} />} showLabel variant="primary" disabled={status === 'working'} onClick={() => void sortClose()} />
        )}
      </footer>
    </main>
  );
}

/** The Sort window; the desktop host mounts it instead of `App` there. */
export function SortApp() {
  return (
    <I18nProvider>
      <SortWindow />
    </I18nProvider>
  );
}
