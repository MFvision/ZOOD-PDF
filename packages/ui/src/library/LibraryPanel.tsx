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
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { Dialog } from '../components/Dialog';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { LIBRARY_ACCEPT } from './kinds';
import { badRange, filterCount, noFilters, toFilters, toggle } from './filters';
import type { FilterState } from './filters';
import { ingest } from './ingest';
import type { IngestSource } from './ingest';
import { LIBRARY_KINDS, coreLibrary, missingLibraryEngine } from './ops';
import type { IndexedDocument, LibraryKind, LibraryStats, SearchHit } from './ops';
import { addRule, applyRules, parseTags, removeRule } from './rules';
import { indexFiles } from './run';
import type { FileState } from './run';
import { snippet } from './snippet';
import {
  directoryPickerAvailable,
  fileForKey,
  keysUnder,
  nativeFolders,
  pickDirectory,
  pickNativeFolder,
  sourcesFromFiles,
} from './sources';
import { emptyMeta, libraryStore } from './store';
import type { FolderRecord, LibraryMeta } from './store';
import './library.css';

/**
 * The Library: one search across every document that was added, not only the
 * one on screen.
 *
 * Files and folders are read into an index kept on this device — IndexedDB in
 * a browser, which inside the desktop app is the app's own data directory —
 * and nothing about them ever leaves it: no file, no text, no thumbnail and
 * no search. A file already read is not read again while its size and date
 * are unchanged, so adding the same folder twice costs nothing. Stop leaves
 * what was read in place and the run picks up where it stopped.
 *
 * A hit names its file, its page and the line it matched with the words
 * marked, and opens the document there.
 */

const PAGE_SIZE = 25;

interface Progress {
  done: number;
  total: number;
  name: string;
}

export function LibraryPanel() {
  const { t } = useI18n();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();

  const store = useRef(libraryStore());
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
  const [progress, setProgress] = useState<Progress | null>(null);
  const [states, setStates] = useState<ReadonlyMap<string, FileState>>(new Map());
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [summary, setSummary] = useState<{ added: number; unchanged: number; skipped: number; failed: number } | null>(null);
  const [password, setPassword] = useState('');

  const [query, setQuery] = useState('');
  const [asked, setAsked] = useState('');
  const [filters, setFilters] = useState<FilterState>(noFilters);
  const [showFilters, setShowFilters] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [total, setTotal] = useState(0);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [searching, setSearching] = useState(false);
  const [missing, setMissing] = useState<string | null>(null);
  const [pendingPage, setPendingPage] = useState<number | null>(null);

  const [chosen, setChosen] = useState<IndexedDocument | null>(null);
  const [newTag, setNewTag] = useState('');
  const [showRules, setShowRules] = useState(false);
  const [ruleWord, setRuleWord] = useState('');
  const [ruleTag, setRuleTag] = useState('');
  const [ruleOutcome, setRuleOutcome] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const say = (message: string) => setError(message);
  const trouble = useCallback((problem: unknown) => {
    setError(problem instanceof Error ? problem.message : String(problem));
  }, []);

  // A folder picker in a browser: an attribute React does not know.
  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '');
  }, []);

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
        const [kind, count] = await Promise.all([store.current.readMeta().catch(emptyMeta), library.stats(id)]);
        if (!alive) return;
        setHandle(id);
        setMeta(kind);
        setStats(count);
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
  }, []);

  const rememberMeta = useCallback(async (next: LibraryMeta) => {
    setMeta(next);
    await store.current.writeMeta(next).catch(() => undefined);
  }, []);

  /** Reads a list of files into the index, showing how far it has come. */
  const run = useCallback(
    async (sources: readonly IngestSource[], folder?: FolderRecord) => {
      if (handle === null || sources.length === 0) return;
      setError(null);
      setSummary(null);
      setRunning(true);
      setProgress({ done: 0, total: sources.length, name: '' });
      setNames(new Map(sources.map((source) => [source.key, source.name])));
      setStates(new Map(sources.map((source) => [source.key, { state: 'waiting' } as FileState])));
      const controller = new AbortController();
      stopper.current = controller;
      try {
        const before = await store.current.readMeta().catch(emptyMeta);
        const outcome = await indexFiles({
          ops: ops.current,
          handle,
          ingest,
          sources,
          known: before.files,
          password: password || undefined,
          signal: controller.signal,
          onState: (key, next) => setStates((current) => new Map(current).set(key, next)),
          onProgress: (done, of, name) => setProgress({ done, total: of, name }),
        });
        const files = { ...before.files };
        for (const record of outcome.records) files[record.key] = record;
        const folders = folder && !before.folders.some((one) => one.id === folder.id) ? [...before.folders, folder] : before.folders;
        await rememberMeta({ ...before, folders, files });
        await keep(handle);
        setSummary({ added: outcome.added, unchanged: outcome.unchanged, skipped: outcome.skipped, failed: outcome.failed });
        if (before.rules.length > 0 && outcome.addedKeys.length > 0) {
          const tagged = await applyRules(ops.current, handle, before.rules, outcome.addedKeys);
          if (tagged.tagged > 0) {
            await keep(handle);
            setRuleOutcome(tagged.tagged);
          }
        }
      } catch (problem) {
        trouble(problem);
      } finally {
        stopper.current = null;
        setRunning(false);
      }
    },
    [handle, keep, password, rememberMeta, trouble],
  );

  const takeFiles = useCallback(
    (files: readonly File[]) => {
      // A browser folder taken by `webkitdirectory` keeps its own name, so
      // the list shows the folder rather than "Files" for every one of them.
      const inFolder = files.find((file) => (file as File & { webkitRelativePath?: string }).webkitRelativePath);
      const label = inFolder
        ? ((inFolder as File & { webkitRelativePath?: string }).webkitRelativePath ?? '').split('/')[0] || t('library.chosenFiles')
        : t('library.chosenFiles');
      const folder: FolderRecord = { id: `files-${Date.now().toString(36)}`, label, source: 'files' };
      const { sources, held: taken } = sourcesFromFiles(files, folder.id);
      if (sources.length === 0) {
        say(t('library.error.noneReadable'));
        return;
      }
      for (const [key, file] of taken) held.current.set(key, file);
      void run(sources, folder);
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
          const picked = await pickNativeFolder();
          if (picked) await run(picked.sources, picked.record);
          return;
        }
        if (directoryPickerAvailable()) {
          const picked = await pickDirectory();
          if (!picked) return;
          if (picked.sources.length === 0) {
            say(t('library.error.emptyFolder'));
            return;
          }
          // No files are held: the folder's own handle is kept instead, so a
          // hit still opens after a reload, once the browser has been asked.
          await run(picked.sources, picked.record);
          return;
        }
        folderInput.current?.click();
      } catch (problem) {
        trouble(problem);
      }
    })();
  };

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

  // The filters act on the search already asked for, without retyping it.
  // A beat's wait keeps a handful of chips turned on in a row to one search.
  useEffect(() => {
    if (asked === '' || badRange(filters)) return undefined;
    const timer = setTimeout(() => void look(asked, filters, shown), 120);
    return () => clearTimeout(timer);
    // Re-run when a filter or the page size changes, not when the box is typed in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, shown]);

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
        setPendingPage(hit.page);
      } catch (problem) {
        trouble(problem);
      }
    })();
  };

  // EmbedPDF draws the file a moment after it is opened, and a page asked
  // for before it has drawn is dropped. The page is asked for again until
  // the view is really showing it, and then let go of.
  const at = useRef(state.currentPage);
  useEffect(() => {
    at.current = state.currentPage;
  }, [state.currentPage]);
  const goToPage = services.goToPage;
  const pages = state.document?.pageCount ?? 0;
  useEffect(() => {
    if (pendingPage === null || pages < pendingPage) return undefined;
    let left = 24;
    const timer = setInterval(() => {
      left -= 1;
      if (at.current === pendingPage || left <= 0) {
        clearInterval(timer);
        setPendingPage(null);
        return;
      }
      goToPage(pendingPage);
    }, 250);
    return () => clearInterval(timer);
  }, [goToPage, pages, pendingPage]);

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
      .then((document) => setChosen(document))
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

  const forgetFolder = (folder: FolderRecord) => {
    if (handle === null) return;
    void (async () => {
      try {
        const before = await store.current.readMeta().catch(emptyMeta);
        const keys = keysUnder(before, folder);
        if (keys.length > 0) await ops.current.forget(handle, keys);
        const files = { ...before.files };
        for (const key of keys) {
          delete files[key];
          held.current.delete(key);
        }
        await rememberMeta({ ...before, folders: before.folders.filter((one) => one.id !== folder.id), files });
        await keep(handle);
        setHits(null);
        setAsked('');
      } catch (problem) {
        trouble(problem);
      }
    })();
  };

  const forgetFile = (key: string) => {
    if (handle === null) return;
    void (async () => {
      try {
        await ops.current.forget(handle, [key]);
        const before = await store.current.readMeta().catch(emptyMeta);
        const files = { ...before.files };
        delete files[key];
        held.current.delete(key);
        await rememberMeta({ ...before, files });
        await keep(handle);
        setMissing(null);
        setHits((current) => current?.filter((hit) => hit.key !== key) ?? current);
      } catch (problem) {
        trouble(problem);
      }
    })();
  };

  const deleteIndex = () => {
    void (async () => {
      setConfirmDelete(false);
      try {
        if (handle !== null) await ops.current.close(handle).catch(() => undefined);
        await store.current.forgetEverything();
        held.current.clear();
        const { handle: fresh } = await ops.current.open();
        setHandle(fresh);
        setMeta(emptyMeta());
        setStats(await ops.current.stats(fresh));
        setHits(null);
        setAsked('');
        setStates(new Map());
        setSummary(null);
        dispatch({ type: 'TOAST', key: 'library.deleted' });
      } catch (problem) {
        trouble(problem);
      }
    })();
  };

  const runRules = () => {
    if (handle === null) return;
    void (async () => {
      try {
        const outcome = await applyRules(ops.current, handle, meta.rules);
        await keep(handle);
        setRuleOutcome(outcome.tagged);
        if (asked) await look(asked, filters, shown);
      } catch (problem) {
        trouble(problem);
      }
    })();
  };

  const kindName = (kind: LibraryKind) => t(`library.kind.${kind}` as TKey);
  const documents = stats?.documents ?? 0;
  const tagsKnown = Object.keys(stats?.tags ?? {}).sort();
  const skipped = [...states].filter(([, one]) => one.state === 'skipped' || one.state === 'failed');

  const skipReason = (one: FileState): string => {
    if (one.state === 'failed') return t('library.skip.failed', { detail: one.detail });
    if (one.state !== 'skipped') return '';
    if (one.reason === 'kind') return t('library.skip.kind');
    if (one.reason === 'reader') return t('library.skip.reader');
    return one.detail ? t('library.skip.core', { detail: one.detail }) : t('library.skip.unknown');
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
                        {cut.parts.map((part, at) =>
                          part.match ? <mark key={at}>{part.text}</mark> : <span key={at}>{part.text}</span>,
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
                <IconButton
                  label={t('library.more')}
                  icon={<Icon of={Plus} />}
                  showLabel
                  onClick={() => setShown((many) => many + PAGE_SIZE)}
                />
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
                <IconButton
                  label={t('library.removeTag', { tag })}
                  icon={<Icon of={X} size={12} />}
                  onClick={() => changeTags(chosen.key, { remove: [tag] })}
                />
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
            {meta.folders.map((folder) => {
              const count = keysUnder(meta, folder).length;
              return (
                <li key={folder.id} className="library-folder">
                  <span className="library-folder-text">
                    <span className="library-folder-name" dir="auto" title={folder.path ?? folder.label}>
                      {folder.label}
                    </span>
                    <span className="library-folder-count">{t('library.folderFiles', { n: count })}</span>
                  </span>
                  <IconButton
                    label={t('library.forgetFolder', { name: folder.label })}
                    icon={<Icon of={Trash2} />}
                    disabled={running}
                    onClick={() => forgetFolder(folder)}
                  />
                </li>
              );
            })}
          </ul>
        )}

        {stats && documents > 0 && (
          <p className="tool-panel-note library-stats">{t('library.stats', { documents: stats.documents, pages: stats.pages, words: stats.words })}</p>
        )}

        {running && progress && (
          <div className="library-progress" role="status">
            <progress max={progress.total} value={progress.done} aria-label={t('library.progressLabel')} />
            <span>
              {t('library.progress', { done: progress.done, of: progress.total })}
              {progress.name ? ` — ${progress.name}` : ''}
            </span>
            <div className="tool-actions">
              <IconButton label={t('library.stop')} icon={<Icon of={Square} />} showLabel onClick={() => stopper.current?.abort()} />
            </div>
          </div>
        )}

        {summary && !running && (
          <p className="library-count" role="status">
            {t('library.summary', summary)}
          </p>
        )}

        {skipped.length > 0 && !running && (
          <div className="library-skipped">
            <p className="library-count">{t('library.skippedTitle', { n: skipped.length })}</p>
            <ul aria-label={t('library.skippedLabel')}>
              {skipped.map(([key, one]) => (
                <li key={key}>
                  <span className="library-skipped-name" dir="auto">
                    {names.get(key) ?? key}
                  </span>
                  <span dir="auto">{skipReason(one)}</span>
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
          <IconButton
            label={t('library.rulesToggle')}
            icon={<Icon of={Tag} />}
            showLabel
            pressed={showRules}
            onClick={() => setShowRules((on) => !on)}
          />
        </div>
        {showRules && (
          <>
            <p className="tool-panel-note">{t('library.rulesNote')}</p>
            {meta.rules.length === 0 ? (
              <p className="tool-panel-note">{t('library.noRules')}</p>
            ) : (
              <ul className="library-rules" aria-label={t('library.rules')}>
                {meta.rules.map((rule) => (
                  <li key={rule.id}>
                    <span dir="auto">{t('library.ruleReads', { word: rule.word, tag: rule.tag })}</span>
                    <IconButton
                      label={t('library.removeRule')}
                      icon={<Icon of={Trash2} />}
                      onClick={() => void rememberMeta({ ...meta, rules: removeRule(meta.rules, rule.id) })}
                    />
                  </li>
                ))}
              </ul>
            )}
            <form
              className="library-row"
              onSubmit={(event) => {
                event.preventDefault();
                const rules = addRule(meta.rules, ruleWord, ruleTag);
                void rememberMeta({ ...meta, rules });
                setRuleWord('');
                setRuleTag('');
              }}
            >
              <label className="field">
                <span>{t('library.ruleWord')}</span>
                <input className="text-input" dir="auto" maxLength={80} value={ruleWord} onChange={(event) => setRuleWord(event.target.value)} />
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
                disabled={ruleWord.trim() === '' || ruleTag.trim() === ''}
              />
            </form>
            {meta.rules.length > 0 && (
              <div className="tool-actions">
                <IconButton label={t('library.applyRules')} icon={<Icon of={Tag} />} showLabel disabled={documents === 0} onClick={runRules} />
              </div>
            )}
            {ruleOutcome !== null && <p className="tool-panel-note">{t('library.rulesApplied', { n: ruleOutcome })}</p>}
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
