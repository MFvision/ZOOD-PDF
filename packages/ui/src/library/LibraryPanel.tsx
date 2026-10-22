import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  CircleAlert,
  FilePlus2,
  FolderOpen,
  Library,
  Loader,
  Plus,
  Search,
  SlidersHorizontal,
  Square,
  Star,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { Dialog } from '../components/Dialog';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useServices } from '../state/AppContext';
import { LIBRARY_ACCEPT } from './kinds';
import type { LibraryKind } from './kinds';
import { badRange, filterCount, noFilters, toFilters, toggle } from './filters';
import type { FilterState } from './filters';
import { ingestFiles, skipMessage } from './ingest';
import type { IngestFile, IngestProgress, IngestRun, IngestedFile } from './ingest';
import { storedLedger } from './ledger';
import { LIBRARY_KINDS, coreLibrary, missingLibraryEngine } from './ops';
import type { IndexedDocument, LibraryStats, SearchHit, TagRule } from './ops';
import { announceLibraryChanged, onLibraryRequest, takeLibraryRequest } from './request';
import { addRule, parseTags, removeRule, ruleKey, ruleWords } from './rules';
import { snippet } from './snippet';
import {
  directoryPickerAvailable,
  fileForKey,
  filesFromPicker,
  folderOf,
  keysUnder,
  nativeFolders,
  onNativeWatch,
  pickDirectory,
  pickNativeFolderPaths,
  scanNativeFolders,
  stopNativeWatch,
  watchNativeFolders,
  watchedFiles,
} from './sources';
import type { LibraryWatchAnswer, PassedOver } from './sources';
import { requestPage } from '../home/pendingPage';
import { starId, toggleStarred, useStarred } from '../state/starred';
import { emptyMeta, libraryStore } from './store';
import type { FileRecord, FolderRecord, LibraryMeta } from './store';
import './library.css';

/**
 * The Library: one search across every document that was added, not only the
 * one on screen.
 *
 * Files and folders are read into an index kept on this device — the app's
 * own data directory on the desktop, IndexedDB in a browser — and nothing
 * about them ever leaves it: no file, no text, no thumbnail and no search. A
 * file already read is not read again while its size, date and content are
 * unchanged, so adding the same folder twice costs nothing; Stop leaves what
 * was read in place and *Carry on* picks up the files it never reached.
 *
 * A hit names its file, its page and the line it matched with the words
 * marked, and opens the document there. The reading itself is `ingest.ts`,
 * the index and the search are the core's, and this file is the interface
 * between a person and those two.
 */

const PAGE_SIZE = 25;

export function LibraryPanel() {
  const { t } = useI18n();
  const dispatch = useAppDispatch();
  const services = useServices();

  const store = useRef(libraryStore());
  const ledger = useRef(storedLedger());
  const ops = useRef(coreLibrary(services.client));
  const held = useRef(new Map<string, File>());
  const stopper = useRef<AbortController | null>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const [handle, setHandle] = useState<number | null>(null);
  const [opening, setOpening] = useState(true);
  const [engine, setEngine] = useState<'ready' | 'missing' | 'failed'>('ready');
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<LibraryMeta>(emptyMeta);
  const [stats, setStats] = useState<LibraryStats | null>(null);

  const [running, setRunning] = useState(false);
  const [finding, setFinding] = useState<{ found: number; where: string } | null>(null);
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [outcome, setOutcome] = useState<IngestRun | null>(null);
  const [remaining, setRemaining] = useState<IngestFile[]>([]);
  const [password, setPassword] = useState('');
  const [recognize, setRecognize] = useState(true);
  const [passedOver, setPassedOver] = useState<PassedOver[]>([]);
  const [gone, setGone] = useState<string[]>([]);
  const [walkTruncated, setWalkTruncated] = useState(false);
  const [watching, setWatching] = useState<LibraryWatchAnswer | null>(null);

  const [query, setQuery] = useState('');
  const [asked, setAsked] = useState('');
  // The home screen's Tags view opens the panel with one tag already chosen.
  // The Folders view opens it to add a folder, which starts once the index is open.
  const [asked0] = useState(takeLibraryRequest);
  const [filters, setFilters] = useState<FilterState>(() => (asked0 && 'tag' in asked0 ? { ...noFilters(), tags: [asked0.tag] } : noFilters()));
  const [showFilters, setShowFilters] = useState(asked0 !== null && 'tag' in asked0);
  const wantsFolder = useRef(asked0 !== null && 'addFolder' in asked0);
  const [folderAsks, setFolderAsks] = useState(0);
  const starred = useStarred();
  const starOf = (key: string) => starred.some((item) => item.id === starId('library', key));
  const star = (key: string, name: string) => toggleStarred({ id: starId('library', key), name, source: 'library' });
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [total, setTotal] = useState(0);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [searching, setSearching] = useState(false);
  const [missing, setMissing] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<ReadonlyMap<string, string>>(new Map());

  const [chosen, setChosen] = useState<IndexedDocument | null>(null);
  const [newTag, setNewTag] = useState('');
  const [rules, setRules] = useState<TagRule[]>([]);
  const [showRules, setShowRules] = useState(false);
  const [ruleWord, setRuleWord] = useState('');
  const [ruleTag, setRuleTag] = useState('');
  const [alsoName, setAlsoName] = useState(true);
  const [tagged, setTagged] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const trouble = useCallback((problem: unknown) => {
    setError(problem instanceof Error ? problem.message : String(problem));
  }, []);

  // A folder picker in a browser: an attribute React does not know.
  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '');
  }, []);

  // The Tags view asks for a tag while the panel is already open.
  useEffect(
    () =>
      onLibraryRequest((request) => {
        if ('addFolder' in request) {
          wantsFolder.current = true;
          setFolderAsks((asks) => asks + 1);
          return;
        }
        setFilters({ ...noFilters(), tags: [request.tag] });
        setShowFilters(true);
      }),
    [],
  );

  /** Opens the index the store kept — or a new one — and reads what it holds. */
  useEffect(() => {
    let alive = true;
    let opened: number | null = null;
    const library = ops.current;
    void (async () => {
      try {
        const kept = await store.current.readIndex().catch(() => null);
        const { handle: id } = await library.open(kept ?? undefined);
        opened = id;
        const [kept2, count, known] = await Promise.all([
          store.current.readMeta().catch(emptyMeta),
          library.stats(id),
          library.rules(id),
        ]);
        if (!alive) return;
        setHandle(id);
        setMeta(kept2);
        setStats(count);
        setRules(known.rules);
      } catch (problem) {
        if (!alive) return;
        setEngine(missingLibraryEngine(problem) ? 'missing' : 'failed');
        trouble(problem);
      } finally {
        if (alive) setOpening(false);
      }
    })();
    return () => {
      alive = false;
      if (opened !== null) void library.close(opened).catch(() => undefined);
    };
  }, [trouble]);

  /** Writes the index back to this device, and reads its totals again. */
  const keep = useCallback(async (id: number) => {
    const saved = await ops.current.save(id);
    await store.current.writeIndex(saved.data);
    setStats(await ops.current.stats(id));
    announceLibraryChanged();
  }, []);

  const rememberMeta = useCallback(async (next: LibraryMeta) => {
    setMeta(next);
    await store.current.writeMeta(next).catch(() => undefined);
    announceLibraryChanged();
  }, []);

  /** Reads a list of files into the index, showing how far it has come. */
  const run = useCallback(
    async (files: readonly IngestFile[], folder?: FolderRecord) => {
      if (handle === null || files.length === 0) return;
      setError(null);
      setOutcome(null);
      setRemaining([]);
      setRunning(true);
      setProgress(null);
      const controller = new AbortController();
      stopper.current = controller;
      const done: IngestedFile[] = [];
      try {
        const answer = await ingestFiles({
          handle,
          files: password ? files.map((file) => ({ ...file, password })) : files,
          client: services.client,
          ledger: ledger.current,
          recognize,
          signal: controller.signal,
          onProgress: setProgress,
          onFile: (file) => done.push(file),
        });
        const before = await store.current.readMeta().catch(emptyMeta);
        const records = { ...before.files };
        for (const file of answer.files) {
          if (!file.added) continue;
          records[file.key] = {
            key: file.key,
            name: file.name,
            folder: folder?.id ?? before.files[file.key]?.folder ?? folderOf(before, file.key)?.id ?? '',
            kind: (file.kind ?? 'pdf') as LibraryKind,
          } satisfies FileRecord;
        }
        const folders = folder && !before.folders.some((one) => one.id === folder.id) ? [...before.folders, folder] : before.folders;
        await rememberMeta({ folders, files: records });
        await keep(handle);
        setOutcome(answer);
        setRemaining(files.filter((file) => answer.remaining.includes(file.key)));
        // The readers draw a small picture of each file's first page; it is
        // kept beside the index, on this device, and shown beside its hits.
        const pictures = new Map(answer.files.filter((file) => file.thumbnail).map((file) => [file.key, file.thumbnail!]));
        if (pictures.size > 0) await store.current.writeThumbs(pictures).catch(() => undefined);
        // Newly indexed documents take the tags the rules give them.
        if (rules.length > 0 && answer.added > 0) {
          const after = await ops.current.rules(handle, { apply: true });
          if (after.tagged > 0) {
            await keep(handle);
            setTagged(after.tagged);
          }
        }
      } catch (problem) {
        trouble(problem);
        if (done.length > 0) setOutcome({ files: done, added: 0, skipped: 0, failed: 0, recognized: 0, remaining: [], took: 0 });
      } finally {
        stopper.current = null;
        setRunning(false);
        setProgress(null);
      }
    },
    [handle, keep, password, recognize, rememberMeta, rules.length, services.client, trouble],
  );

  const takeFiles = useCallback(
    (picked: readonly File[]) => {
      // A browser folder taken by `webkitdirectory` keeps its own name, so
      // the list shows the folder rather than "Chosen files" for every one.
      //
      // The id is the same every time, and so is a file's key: choosing the
      // same file twice is the same document, not a second copy under a new
      // name — which is what a fresh id each time quietly made.
      const inFolder = picked.find((file) => (file as File & { webkitRelativePath?: string }).webkitRelativePath);
      const top = inFolder ? (((inFolder as File & { webkitRelativePath?: string }).webkitRelativePath ?? '').split('/')[0] ?? '') : '';
      const folder: FolderRecord = top
        ? { id: `dir:${top}`, label: top, source: 'files' }
        : { id: 'files', label: t('library.chosenFiles'), source: 'files' };
      const { files, held: taken } = filesFromPicker(picked, folder.id);
      if (files.length === 0) {
        setError(t('library.error.noneReadable'));
        return;
      }
      for (const [key, file] of taken) held.current.set(key, file);
      void run(files, folder);
    },
    [run, t],
  );

  // Files dropped on the window while the panel is open join the library.
  const takeDrop = useRef(takeFiles);
  useEffect(() => {
    takeDrop.current = takeFiles;
  });
  useEffect(() => {
    services.claimDrops({ label: 'drop.library', take: (files) => takeDrop.current(files) });
    return () => services.claimDrops(null);
    // Claimed once for as long as the panel is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    takeFiles(files);
  };

  const addFolder = () => {
    void (async () => {
      try {
        if (nativeFolders()) {
          const paths = await pickNativeFolderPaths();
          if (paths.length === 0) return;
          setPassedOver([]);
          setGone([]);
          setWalkTruncated(false);
          setFinding({ found: 0, where: '' });
          const walker = new AbortController();
          stopper.current = walker;
          const scan = await scanNativeFolders(
            paths,
            ledger.current.all(),
            (count, where) => setFinding({ found: count, where }),
            walker.signal,
          ).finally(() => {
            setFinding(null);
            stopper.current = null;
          });
          setPassedOver(scan.skipped);
          setGone(scan.missing);
          setWalkTruncated(scan.truncated);
          for (const folder of scan.folders) {
            if (folder.files.length > 0) await run(folder.files, folder.record);
          }
          return;
        }
        if (directoryPickerAvailable()) {
          setFinding({ found: 0, where: '' });
          const picked = await pickDirectory((count) => setFinding({ found: count, where: '' })).finally(() => setFinding(null));
          if (!picked) return;
          if (picked.files.length === 0) {
            setError(t('library.error.emptyFolder'));
            return;
          }
          // No files are held: the folder's own handle is kept instead, so a
          // hit still opens after a reload, once the browser has been asked.
          await run(picked.files, picked.record);
          return;
        }
        folderInput.current?.click();
      } catch (problem) {
        setFinding(null);
        trouble(problem);
      }
    })();
  };

  // Asked for from the Folders view: the folder picker opens once the index is.
  useEffect(() => {
    if (!wantsFolder.current || handle === null) return;
    wantsFolder.current = false;
    addFolder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderAsks, handle]);

  /** One search, from the box and the filters as they stand. */
  const look = useCallback(
    async (text: string, state: FilterState, limit: number) => {
      if (handle === null) return;
      const wanted = text.trim();
      setAsked(wanted);
      if (wanted === '') {
        setHits(null);
        setTotal(0);
        return;
      }
      setSearching(true);
      setError(null);
      try {
        const found = await ops.current.search(handle, wanted, { limit, filters: toFilters(state) });
        setHits(found.hits);
        setTotal(found.total);
      } catch (problem) {
        trouble(problem);
        setHits([]);
        setTotal(0);
      } finally {
        setSearching(false);
      }
    },
    [handle, trouble],
  );

  /*
   * The results follow the typing. A search over fifty files answers in about
   * a millisecond (STATUS), so there is nothing to wait for but the person:
   * a beat's pause after the last letter, which also keeps a handful of
   * filter chips turned on in a row to one search. Enter still searches at
   * once, and so does the button, for anyone who would rather ask than be
   * answered while they think.
   */
  useEffect(() => {
    if (badRange(filters)) return undefined;
    if (query.trim() === '' && asked === '') return undefined;
    const timer = setTimeout(() => void look(query, filters, shown), 180);
    return () => clearTimeout(timer);
    // `asked` is what the last search asked for: reading it here would run
    // this again on its own answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filters, shown]);

  // One address per document on screen, made when the results change and
  // given back when they do: an object URL the page never releases is a leak
  // the tab pays for until it closes.
  const keysShown = hits ? [...new Set(hits.map((hit) => hit.key))].join('\u0000') : '';
  useEffect(() => {
    if (keysShown === '') return undefined;
    let alive = true;
    const made = new Map<string, string>();
    void (async () => {
      for (const key of keysShown.split('\u0000')) {
        const picture = await store.current.readThumb(key).catch(() => null);
        if (!picture || !alive) continue;
        made.set(key, URL.createObjectURL(new Blob([picture.image], { type: picture.mime })));
      }
      if (alive) setThumbs(made);
      else for (const url of made.values()) URL.revokeObjectURL(url);
    })();
    return () => {
      alive = false;
      for (const url of made.values()) URL.revokeObjectURL(url);
    };
  }, [keysShown]);

  /** Opens the document a hit came from, at its page. */
  const openHit = (hit: SearchHit) => {
    void (async () => {
      setMissing(null);
      try {
        const file = await fileForKey(meta, hit.key, held.current);
        if (!file) {
          setMissing(hit.key);
          return;
        }
        await services.openFile(file);
        requestPage(hit.page);
      } catch (problem) {
        trouble(problem);
      }
    })();
  };

  // The tags of a document chosen from a result are edited in their own
  // section further down the panel; bring it into view, or the press does
  // nothing that can be seen from where it was made.
  const tagEditor = useRef<HTMLElement>(null);
  useEffect(() => {
    if (chosen) tagEditor.current?.scrollIntoView({ block: 'nearest' });
  }, [chosen]);

  const chooseDocument = (key: string) => {
    if (handle === null) return;
    void ops.current
      .document(handle, key)
      .then(setChosen)
      .catch(trouble);
  };

  const changeTags = (key: string, change: { add?: string[]; remove?: string[] }) => {
    if (handle === null) return;
    void (async () => {
      try {
        const { tags } = await ops.current.tag(handle, key, change);
        setChosen((current) => (current && current.key === key ? { ...current, tags } : current));
        setHits((current) => current?.map((hit) => (hit.key === key ? { ...hit, tags } : hit)) ?? current);
        await keep(handle);
      } catch (problem) {
        trouble(problem);
      }
    })();
  };

  const writeRules = (next: TagRule[], apply: boolean) => {
    if (handle === null) return;
    void (async () => {
      try {
        const answer = await ops.current.rules(handle, { set: next, apply });
        setRules(answer.rules);
        setTagged(apply ? answer.tagged : null);
        await keep(handle);
        if (apply && asked) await look(asked, filters, shown);
      } catch (problem) {
        trouble(problem);
      }
    })();
  };

  const forgetFolder = (folder: FolderRecord) => {
    if (handle === null) return;
    void (async () => {
      try {
        const before = await store.current.readMeta().catch(emptyMeta);
        const keys = keysUnder(before, folder);
        if (keys.length > 0) await ops.current.forget(handle, keys);
        ledger.current.forget(keys);
        const files = { ...before.files };
        for (const key of keys) {
          delete files[key];
          held.current.delete(key);
        }
        await rememberMeta({ folders: before.folders.filter((one) => one.id !== folder.id), files });
        await keep(handle);
        setHits(null);
        setAsked('');
      } catch (problem) {
        trouble(problem);
      }
    })();
  };

  const forgetKeys = useCallback(
    async (keys: readonly string[]) => {
      if (handle === null || keys.length === 0) return;
      await ops.current.forget(handle, keys);
      ledger.current.forget(keys);
      await store.current.forgetThumbs(keys).catch(() => undefined);
      const before = await store.current.readMeta().catch(emptyMeta);
      const files = { ...before.files };
      for (const key of keys) {
        delete files[key];
        held.current.delete(key);
      }
      await rememberMeta({ ...before, files });
      await keep(handle);
      setMissing(null);
      setGone((left) => left.filter((key) => !keys.includes(key)));
      setHits((current) => current?.filter((hit) => !keys.includes(hit.key)) ?? current);
    },
    [handle, keep, rememberMeta],
  );

  const forgetFile = (key: string) => void forgetKeys([key]).catch(trouble);

  /**
   * The host's watcher: it re-checks the chosen folders every few seconds —
   * it is not the system telling us, and the panel says so — and may refuse a
   * set of folders that is too large to re-check. What it finds is read, and
   * a file that has gone is forgotten.
   */
  const watchFolders = (on: boolean) => {
    void (async () => {
      try {
        if (!on) {
          await stopNativeWatch();
          setWatching(null);
          return;
        }
        const paths = meta.folders.filter((one) => one.source === 'path' && one.path).map((one) => one.path!);
        if (paths.length === 0) return;
        setWatching(await watchNativeFolders(paths));
      } catch (problem) {
        trouble(problem);
      }
    })();
  };

  const runWatched = useRef(run);
  useEffect(() => {
    runWatched.current = run;
  });
  useEffect(() => {
    if (watching?.watching !== true) return undefined;
    const off = onNativeWatch((event) => {
      const fresh = watchedFiles([...event.added, ...event.changed]);
      if (fresh.length > 0) void runWatched.current(fresh);
      if (event.removed.length > 0) void forgetKeys(event.removed).catch(() => undefined);
      if (event.stopped) setWatching({ watching: false, files: 0, seconds: 0, reason: event.stopped });
    });
    return () => off();
  }, [forgetKeys, watching?.watching]);
  // The watcher is the host's, and outlives this panel unless it is stopped.
  useEffect(() => () => void stopNativeWatch().catch(() => undefined), []);

  const deleteIndex = () => {
    void (async () => {
      setConfirmDelete(false);
      try {
        if (handle !== null) await ops.current.close(handle).catch(() => undefined);
        await store.current.forgetEverything();
        ledger.current.clear();
        held.current.clear();
        const { handle: fresh } = await ops.current.open();
        setHandle(fresh);
        setMeta(emptyMeta());
        announceLibraryChanged();
        setStats(await ops.current.stats(fresh));
        setRules([]);
        setHits(null);
        setAsked('');
        setOutcome(null);
        setRemaining([]);
        dispatch({ type: 'TOAST', key: 'library.deleted' });
      } catch (problem) {
        trouble(problem);
      }
    })();
  };

  const kindName = (kind: LibraryKind) => t(`library.kind.${kind}` as TKey);
  const documents = stats?.documents ?? 0;
  const tagsKnown = Object.keys(stats?.tags ?? {}).sort();
  const unchanged = outcome?.files.filter((file) => file.skipped === 'unchanged').length ?? 0;
  const notRead = outcome ? outcome.files.filter((file) => file.skipped && file.skipped !== 'unchanged') : [];

  const skipReason = (file: IngestedFile): string => {
    const reason = t(skipMessage(file.skipped ?? 'unreadable'));
    return file.problem ? t('library.skip.problem', { reason, problem: file.problem }) : reason;
  };

  const progressLine = (): string => {
    if (!progress) return '';
    const place = t('library.progress', { done: progress.file, of: progress.of });
    const stage =
      progress.stage === 'recognizing' && progress.page
        ? t('library.stage.recognizingPage', { page: progress.page, pages: progress.pages ?? progress.page })
        : t(`library.stage.${progress.stage}` as TKey);
    return `${place} — ${progress.name} · ${stage}`;
  };

  if (opening) {
    return (
      <div className="tool-panel library-panel">
        <h3>
          <Icon of={Library} />
          {t('tool.library')}
        </h3>
        <p className="tool-panel-note" role="status">
          <Icon of={Loader} className="spin" /> {t('library.opening')}
        </p>
      </div>
    );
  }

  if (engine !== 'ready') {
    return (
      <div className="tool-panel library-panel">
        <h3>
          <Icon of={Library} />
          {t('tool.library')}
        </h3>
        <div className="banner banner-error" role="alert">
          <Icon of={CircleAlert} />
          <span>{engine === 'missing' ? t('library.engineMissing') : t('library.engineFailed', { detail: error ?? '' })}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="tool-panel library-panel">
      <h3>
        <Icon of={Library} />
        {t('tool.library')}
      </h3>
      <p className="tool-panel-note">{t('library.intro')}</p>

      <section className="library-section" aria-labelledby="library-search-heading">
        <h4 id="library-search-heading">{t('library.search')}</h4>
        <form
          role="search"
          className="library-search"
          onSubmit={(event) => {
            event.preventDefault();
            setShown(PAGE_SIZE);
            void look(query, filters, PAGE_SIZE);
          }}
        >
          <label className="field">
            <span>{t('library.searchLabel')}</span>
            <input
              type="search"
              className="text-input"
              dir="auto"
              value={query}
              placeholder={t('library.searchPlaceholder')}
              disabled={documents === 0}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="tool-actions">
            <IconButton
              label={t('library.searchButton')}
              icon={<Icon of={Search} />}
              showLabel
              variant="primary"
              disabled={documents === 0 || query.trim() === ''}
              type="submit"
            />
            <IconButton
              label={filterCount(filters) > 0 ? t('library.filtersOn', { n: filterCount(filters) }) : t('library.filters')}
              icon={<Icon of={SlidersHorizontal} />}
              showLabel
              pressed={showFilters}
              onClick={() => setShowFilters((on) => !on)}
            />
          </div>
        </form>

        {showFilters && (
          <div className="library-filters">
            <fieldset>
              <legend>{t('library.filter.kinds')}</legend>
              <div className="library-chips">
                {LIBRARY_KINDS.map((kind) => (
                  <label key={kind} className="library-chip">
                    <input
                      type="checkbox"
                      checked={filters.kinds.includes(kind)}
                      onChange={() => setFilters((one) => ({ ...one, kinds: toggle(one.kinds, kind) }))}
                    />
                    <span>{kindName(kind)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {meta.folders.length > 0 && (
              <fieldset>
                <legend>{t('library.filter.folders')}</legend>
                <div className="library-chips">
                  {meta.folders.map((folder) => (
                    <label key={folder.id} className="library-chip">
                      <input
                        type="checkbox"
                        checked={filters.folders.includes(folder.id)}
                        onChange={() => setFilters((one) => ({ ...one, folders: toggle(one.folders, folder.id) }))}
                      />
                      <span dir="auto">{folder.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {tagsKnown.length > 0 && (
              <fieldset>
                <legend>{t('library.filter.tags')}</legend>
                <div className="library-chips">
                  {tagsKnown.map((tag) => (
                    <label key={tag} className="library-chip">
                      <input
                        type="checkbox"
                        checked={filters.tags.includes(tag)}
                        onChange={() => setFilters((one) => ({ ...one, tags: toggle(one.tags, tag) }))}
                      />
                      <span dir="auto">{tag}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <fieldset>
              <legend>{t('library.filter.date')}</legend>
              <p className="tool-panel-note">{t('library.filter.dateNote')}</p>
              <div className="library-row">
                <label className="field">
                  <span>{t('library.filter.from')}</span>
                  <input
                    type="date"
                    className="text-input"
                    value={filters.from}
                    onChange={(event) => setFilters((one) => ({ ...one, from: event.target.value }))}
                  />
                </label>
                <label className="field">
                  <span>{t('library.filter.to')}</span>
                  <input
                    type="date"
                    className="text-input"
                    value={filters.to}
                    onChange={(event) => setFilters((one) => ({ ...one, to: event.target.value }))}
                  />
                </label>
              </div>
              {badRange(filters) && <p className="field-error">{t('library.badRange')}</p>}
            </fieldset>
            <label className="library-choice">
              <input
                type="checkbox"
                checked={filters.scannedOnly}
                onChange={(event) => setFilters((one) => ({ ...one, scannedOnly: event.target.checked }))}
              />
              <span>{t('library.filter.scannedOnly')}</span>
            </label>
            {filterCount(filters) > 0 && (
              <button type="button" className="link-btn" onClick={() => setFilters(noFilters())}>
                {t('library.filter.clear')}
              </button>
            )}
          </div>
        )}

        {documents === 0 && !running && <p className="tool-panel-note">{t('library.empty')}</p>}
        {searching && (
          <p className="tool-panel-note" role="status">
            <Icon of={Loader} className="spin" /> {t('library.searching')}
          </p>
        )}
        {hits !== null && !searching && (
          <>
            <p className="library-count" role="status">
              {total === 0 ? t('library.noResults', { query: asked }) : t('library.results', { n: total })}
            </p>
            <ol className="library-hits" aria-label={t('library.resultsLabel')}>
              {hits.map((hit, index) => {
                const cut = snippet(hit.text, hit.spans);
                return (
                  <li key={`${hit.key}:${hit.page}:${hit.line}:${index}`} className="library-hit">
                    <button
                      type="button"
                      className="library-hit-open"
                      onClick={() => openHit(hit)}
                      aria-label={t('library.openHit', { name: hit.name, page: hit.page })}
                    >
                      <span className="library-hit-head">
                        {thumbs.get(hit.key) ? (
                          <img className="library-thumb" src={thumbs.get(hit.key)} alt="" />
                        ) : (
                          <span className="library-thumb library-thumb-none" aria-hidden="true">
                            <Icon of={Library} size={14} />
                          </span>
                        )}
                        <span className="library-hit-name" dir="auto">
                          {hit.name}
                        </span>
                        <span className="library-hit-where">
                          {t('library.hitPage', { page: hit.page })} · {kindName(hit.kind)}
                          {hit.date ? <> · <bdi>{hit.date}</bdi></> : null}
                        </span>
                      </span>
                      <span className="library-snippet" dir="auto">
                        {cut.cutStart && <span className="library-cut">…</span>}
                        {cut.parts.map((part, place) =>
                          part.match ? <mark key={place}>{part.text}</mark> : <span key={place}>{part.text}</span>,
                        )}
                        {cut.cutEnd && <span className="library-cut">…</span>}
                      </span>
                    </button>
                    <div className="library-hit-foot">
                      {hit.tags.map((tag) => (
                        <span key={tag} className="badge" dir="auto">
                          {tag}
                        </span>
                      ))}
                      <IconButton
                        label={t('library.tagsOf', { name: hit.name })}
                        icon={<Icon of={Tag} />}
                        onClick={() => chooseDocument(hit.key)}
                      />
                      <IconButton
                        className={starOf(hit.key) ? 'library-star is-on' : 'library-star'}
                        label={t(starOf(hit.key) ? 'starred.remove' : 'starred.add', { name: hit.name })}
                        icon={<Icon of={Star} />}
                        pressed={starOf(hit.key)}
                        onClick={() => star(hit.key, hit.name)}
                      />
                    </div>
                    {missing === hit.key && (
                      <div className="library-missing" role="alert">
                        <span>{t('library.missing', { name: hit.name })}</span>
                        <button type="button" className="link-btn" onClick={() => forgetFile(hit.key)}>
                          {t('library.forgetFile')}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            {hits.length < total && (
              <div className="tool-actions">
                <IconButton label={t('library.more')} icon={<Icon of={Plus} />} showLabel onClick={() => setShown((many) => many + PAGE_SIZE)} />
              </div>
            )}
          </>
        )}
      </section>

      {chosen && (
        <section className="library-section" ref={tagEditor} aria-labelledby="library-tags-heading">
          <h4 id="library-tags-heading">{t('library.tagsOf', { name: chosen.name })}</h4>
          <div className="library-chips">
            {chosen.tags.length === 0 && <p className="tool-panel-note">{t('library.noTags')}</p>}
            {chosen.tags.map((tag) => (
              <span key={tag} className="badge library-tag" dir="auto">
                {tag}
                <IconButton label={t('library.removeTag', { tag })} icon={<Icon of={X} size={12} />} onClick={() => changeTags(chosen.key, { remove: [tag] })} />
              </span>
            ))}
          </div>
          <form
            className="library-row"
            onSubmit={(event) => {
              event.preventDefault();
              const add = parseTags(newTag);
              if (add.length === 0) return;
              changeTags(chosen.key, { add });
              setNewTag('');
            }}
          >
            <label className="field">
              <span>{t('library.addTag')}</span>
              <input className="text-input" dir="auto" maxLength={60} value={newTag} onChange={(event) => setNewTag(event.target.value)} />
            </label>
            <IconButton label={t('library.addTagButton')} icon={<Icon of={Plus} />} showLabel type="submit" disabled={parseTags(newTag).length === 0} />
          </form>
          <div className="tool-actions">
            <IconButton
              label={t(starOf(chosen.key) ? 'starred.remove' : 'starred.add', { name: chosen.name })}
              icon={<Icon of={Star} />}
              showLabel
              pressed={starOf(chosen.key)}
              onClick={() => star(chosen.key, chosen.name)}
            />
          </div>
          <button type="button" className="link-btn" onClick={() => setChosen(null)}>
            {t('library.closeTags')}
          </button>
        </section>
      )}

      <section className="library-section" aria-labelledby="library-files-heading">
        <h4 id="library-files-heading">{t('library.sources')}</h4>
        <div className="tool-actions">
          <IconButton label={t('library.addFiles')} icon={<Icon of={FilePlus2} />} showLabel disabled={running} onClick={() => filesInput.current?.click()} />
          <IconButton label={t('library.addFolder')} icon={<Icon of={FolderOpen} />} showLabel disabled={running} onClick={addFolder} />
        </div>
        <input ref={filesInput} type="file" accept={LIBRARY_ACCEPT} multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={onInput} />
        <input ref={folderInput} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={onInput} />
        <label className="library-choice">
          <input type="checkbox" checked={recognize} disabled={running} onChange={(event) => setRecognize(event.target.checked)} />
          <span>{t('library.recognize')}</span>
        </label>
        <p className="tool-panel-note">{t('library.recognizeNote')}</p>
        <label className="field">
          <span>{t('library.password')}</span>
          <input
            className="text-input"
            type="password"
            dir="auto"
            autoComplete="off"
            value={password}
            disabled={running}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <p className="tool-panel-note">{t('library.passwordNote')}</p>

        {meta.folders.length === 0 ? (
          <p className="tool-panel-note">{t('library.noSources')}</p>
        ) : (
          <ul className="library-folders" aria-label={t('library.sources')}>
            {meta.folders.map((folder) => (
              <li key={folder.id} className="library-folder">
                <span className="library-folder-text">
                  <span className="library-folder-name" dir="auto" title={folder.path ?? folder.label}>
                    {folder.label}
                  </span>
                  <span className="library-folder-count">{t('library.folderFiles', { n: keysUnder(meta, folder).length })}</span>
                </span>
                <IconButton
                  label={t('library.forgetFolder', { name: folder.label })}
                  icon={<Icon of={Trash2} />}
                  disabled={running}
                  onClick={() => forgetFolder(folder)}
                />
              </li>
            ))}
          </ul>
        )}

        {stats && documents > 0 && (
          <p className="tool-panel-note library-stats">{t('library.stats', { documents: stats.documents, pages: stats.pages, words: stats.words })}</p>
        )}

        {nativeFolders() && meta.folders.some((one) => one.source === 'path') && (
          <>
            <label className="library-choice">
              <input type="checkbox" checked={watching?.watching === true} disabled={running} onChange={(event) => watchFolders(event.target.checked)} />
              <span>{t('library.watch')}</span>
            </label>
            {watching?.watching === true && (
              <p className="tool-panel-note" role="status">
                {t('library.watching', { files: watching.files, seconds: watching.seconds })}
              </p>
            )}
            {watching && watching.watching === false && (
              <p className="field-error" role="status">
                {t(watching.reason === 'too-many' ? 'library.watchTooMany' : 'library.watchRefused')}
              </p>
            )}
          </>
        )}

        {walkTruncated && <p className="tool-panel-note">{t('library.walkTruncated')}</p>}

        {gone.length > 0 && (
          <div className="library-missing" role="status">
            <span>{t('library.goneFiles', { n: gone.length })}</span>
            <button type="button" className="link-btn" onClick={() => void forgetKeys(gone).catch(trouble)}>
              {t('library.forgetGone')}
            </button>
          </div>
        )}

        {passedOver.length > 0 && (
          <div className="library-skipped">
            <p className="library-count">{t('library.passedOver', { n: passedOver.length })}</p>
            <ul aria-label={t('library.passedOverLabel')}>
              {passedOver.slice(0, 50).map((one) => (
                <li key={one.path}>
                  <span className="library-skipped-name" dir="auto">
                    {one.path}
                  </span>
                  <span dir="auto">{t(`library.walk.${one.reason}` as TKey)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {finding && (
          <div className="library-progress" role="status">
            <span dir="auto">
              <Icon of={Loader} className="spin" /> {t('library.finding', { n: finding.found })}
              {finding.where ? ` — ${finding.where}` : ''}
            </span>
            <div className="tool-actions">
              <IconButton label={t('library.stop')} icon={<Icon of={Square} />} showLabel onClick={() => stopper.current?.abort()} />
            </div>
          </div>
        )}

        {running && (
          <div className="library-progress" role="status">
            <progress max={progress?.of ?? 1} value={progress?.file ?? 0} aria-label={t('library.progressLabel')} />
            <span dir="auto">{progressLine()}</span>
            <div className="tool-actions">
              <IconButton label={t('library.stop')} icon={<Icon of={Square} />} showLabel onClick={() => stopper.current?.abort()} />
            </div>
          </div>
        )}

        {outcome && !running && (
          <p className="library-count" role="status">
            {t('library.summary', { added: outcome.added, unchanged, skipped: notRead.length, failed: outcome.failed })}
            {outcome.recognized > 0 ? ` ${t('library.recognized', { n: outcome.recognized })}` : ''}
          </p>
        )}

        {outcome && !running && outcome.files.some((file) => file.truncated) && <p className="tool-panel-note">{t('library.truncated')}</p>}

        {remaining.length > 0 && !running && (
          <div className="tool-actions">
            <IconButton label={t('library.carryOn', { n: remaining.length })} icon={<Icon of={Plus} />} showLabel onClick={() => void run(remaining)} />
          </div>
        )}

        {notRead.length > 0 && !running && (
          <div className="library-skipped">
            <p className="library-count">{t('library.skippedTitle', { n: notRead.length })}</p>
            <ul aria-label={t('library.skippedLabel')}>
              {notRead.map((file) => (
                <li key={file.key}>
                  <span className="library-skipped-name" dir="auto">
                    {file.name}
                  </span>
                  <span dir="auto">{skipReason(file)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {documents > 0 && (
          <div className="tool-actions">
            <IconButton
              label={t('library.deleteIndex')}
              icon={<Icon of={Trash2} />}
              showLabel
              className="icon-btn-destructive"
              disabled={running}
              onClick={() => setConfirmDelete(true)}
            />
          </div>
        )}
        <p className="tool-panel-note">{t('library.privacy')}</p>
      </section>

      <section className="library-section" aria-labelledby="library-rules-heading">
        <h4 id="library-rules-heading">{t('library.rules')}</h4>
        <div className="tool-actions">
          <IconButton label={t('library.rulesToggle')} icon={<Icon of={Tag} />} showLabel pressed={showRules} onClick={() => setShowRules((on) => !on)} />
        </div>
        {showRules && (
          <>
            <p className="tool-panel-note">{t('library.rulesNote')}</p>
            {rules.length === 0 ? (
              <p className="tool-panel-note">{t('library.noRules')}</p>
            ) : (
              <ul className="library-rules" aria-label={t('library.rules')}>
                {rules.map((rule, index) => (
                  <li key={ruleKey(rule, index)}>
                    <span dir="auto">{t('library.ruleReads', { word: ruleWords(rule), tag: rule.tag })}</span>
                    <IconButton label={t('library.removeRule')} icon={<Icon of={Trash2} />} onClick={() => writeRules(removeRule(rules, index), false)} />
                  </li>
                ))}
              </ul>
            )}
            <form
              className="library-row"
              onSubmit={(event) => {
                event.preventDefault();
                writeRules(addRule(rules, ruleWord, ruleTag, alsoName), true);
                setRuleWord('');
                setRuleTag('');
              }}
            >
              <label className="field">
                <span>{t('library.ruleWord')}</span>
                <input className="text-input" dir="auto" maxLength={160} value={ruleWord} onChange={(event) => setRuleWord(event.target.value)} />
              </label>
              <label className="field">
                <span>{t('library.ruleTag')}</span>
                <input className="text-input" dir="auto" maxLength={60} value={ruleTag} onChange={(event) => setRuleTag(event.target.value)} />
              </label>
              <IconButton
                label={t('library.addRule')}
                icon={<Icon of={Plus} />}
                showLabel
                type="submit"
                disabled={parseTags(ruleWord).length === 0 || ruleTag.trim() === ''}
              />
            </form>
            <p className="tool-panel-note">{t('library.ruleWordsNote')}</p>
            <label className="library-choice">
              <input type="checkbox" checked={alsoName} onChange={(event) => setAlsoName(event.target.checked)} />
              <span>{t('library.ruleAlsoName')}</span>
            </label>
            {rules.length > 0 && (
              <div className="tool-actions">
                <IconButton
                  label={t('library.applyRules')}
                  icon={<Icon of={Tag} />}
                  showLabel
                  disabled={documents === 0}
                  onClick={() => writeRules(rules, true)}
                />
              </div>
            )}
            {tagged !== null && <p className="tool-panel-note">{t('library.rulesApplied', { n: tagged })}</p>}
          </>
        )}
      </section>

      {error && (
        <div className="banner banner-error" role="alert">
          <Icon of={CircleAlert} />
          <span dir="auto">{t('library.error', { detail: error })}</span>
          <IconButton label={t('error.dismiss')} icon={<Icon of={X} />} onClick={() => setError(null)} />
        </div>
      )}

      <Dialog open={confirmDelete} title={t('library.deleteIndexTitle')} onClose={() => setConfirmDelete(false)}>
        <p>{t('library.deleteIndexBody')}</p>
        <div className="dialog-actions">
          <IconButton label={t('library.cancel')} icon={<Icon of={X} />} showLabel onClick={() => setConfirmDelete(false)} />
          <IconButton label={t('library.deleteIndexConfirm')} icon={<Icon of={Trash2} />} showLabel variant="primary" onClick={deleteIndex} />
        </div>
      </Dialog>
    </div>
  );
}
