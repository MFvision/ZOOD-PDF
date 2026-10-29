import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, Cloud, FileText, Folder, FolderSearch, Loader, Plus } from 'lucide-react';
import { errorKey, useCloud } from '../cloud/CloudContext';
import { isolate } from '../cloud/CloudBrowser';
import { recentId } from '../cloud/store';
import type { ProviderId } from '../cloud/config';
import type { Entry } from '../cloud/drive';
import { kindOf } from '../cloud/errors';
import type { CloudErrorKind } from '../cloud/errors';
import { ContextMenu } from '../components/ContextMenu';
import type { ContextMenuItem } from '../components/ContextMenu';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import { LIBRARY_ACCEPT } from '../library/kinds';
import { postLibraryRequest } from '../library/request';
import { chooseAgain, fileForKey, keysUnder, mustChooseAgain } from '../library/sources';
import type { FolderRecord, LibraryStore } from '../library/store';
import { useAppDispatch, useServices } from '../state/AppContext';
import { FolderCard, LOCAL_TONES } from './FolderCard';
import type { LibraryIndex } from './useLibraryIndex';

/**
 * Folders: the person's own folders, as the Library holds them, and the
 * cloud drives this build offers, in one place. A folder opens to its files,
 * which open with one click; "New folder" adds a folder or files through the
 * Library (it reads them so they can be searched, and never moves or changes
 * them). A drive opens the same way, to the files already chosen in it, with
 * "choose more" as a card of its own and on the drive's badge; it signs in
 * first when it has to. Drives appear only in a build that has them
 * (docs/cloud.md).
 */
export function FoldersView({ index }: { index: LibraryIndex }) {
  const { t, lang, dir } = useI18n();
  const cloud = useCloud();
  const services = useServices();
  const dispatch = useAppDispatch();
  const [openId, setOpenId] = useState<string | null>(null);
  const [openDrive, setOpenDrive] = useState<ProviderId | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; from: HTMLElement; label: string; items: ContextMenuItem[] } | null>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLLIElement>(null);
  const folders = index.meta.folders;
  const opened = folders.find((folder) => folder.id === openId) ?? null;
  const number = (count: number) => new Intl.NumberFormat(lang === 'ar' ? 'ar-SA-u-nu-arab' : 'en-US').format(count);

  const keysOf = useMemo(() => {
    const byFolder = new Map<string, string[]>();
    for (const folder of folders) byFolder.set(folder.id, keysUnder(index.meta, folder).sort((a, b) => nameOf(index, a).localeCompare(nameOf(index, b))));
    return byFolder;
  }, [folders, index]);

  // The first three pages of each folder, for the pages standing in it.
  const fronts = useMemo(() => folders.flatMap((folder) => (keysOf.get(folder.id) ?? []).slice(0, 3)), [folders, keysOf]);
  const pictures = usePictures(index.store, fronts);

  const addFolder = () => {
    postLibraryRequest({ addFolder: true });
    dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'library' });
  };
  const addFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (files.length === 0) return;
    postLibraryRequest({ addFiles: files });
    dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'library' });
  };

  /** A menu under `from`, as the home screen's + opens its own. */
  const showMenu = (from: HTMLElement, label: string, items: ContextMenuItem[]) => {
    const box = from.getBoundingClientRect();
    setMenu({ at: { x: dir === 'rtl' ? box.right - 236 : box.left, y: box.bottom + 4 }, from, label, items });
  };
  const chooseMore = (provider: ProviderId, from: HTMLElement) =>
    showMenu(from, t('folders.choose'), [
      {
        id: 'cloud',
        label: t('folders.chooseIn', { drive: t(`cloud.name.${provider}`) }),
        icon: <Icon of={Cloud} />,
        onSelect: () => (provider === 'gdrive' ? cloud.pickWithGoogle('open') : cloud.startOpen(provider)),
      },
      { id: 'device', label: t('folders.chooseDevice'), icon: <Icon of={FileText} />, onSelect: services.requestOpenFile },
    ]);

  const menus = (
    <>
      <ContextMenu at={menu?.at ?? null} label={menu?.label ?? ''} items={menu?.items ?? []} returnTo={menu?.from} onClose={() => setMenu(null)} />
      <input ref={filesInput} type="file" accept={LIBRARY_ACCEPT} multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={addFiles} />
    </>
  );

  if (opened) {
    return <FolderFiles index={index} folder={opened} keys={keysOf.get(opened.id) ?? []} onBack={() => setOpenId(null)} />;
  }

  if (openDrive) {
    return (
      <>
        <DriveFiles provider={openDrive} onBack={() => setOpenDrive(null)} onChoose={(from) => chooseMore(openDrive, from)} />
        {menus}
      </>
    );
  }

  return (
    <section className="home-section folders" aria-labelledby="home-folders">
      <div className="home-section-header">
        <h2 id="home-folders">{t('folders.title')}</h2>
      </div>
      <p className="home-note">{t('folders.hint')}</p>
      <h3 className="folders-group">{t('folders.local')}</h3>
      {index.status === 'opening' && (
        <p className="home-note" role="status">
          {t('home.libraryOpening')}
        </p>
      )}
      <ul className="folders-grid">
        {folders.map((folder, at) => {
          const keys = keysOf.get(folder.id) ?? [];
          return (
            <li key={folder.id}>
              <FolderCard
                name={folder.label}
                detail={t('folders.count', { count: number(keys.length) })}
                tone={LOCAL_TONES[at % LOCAL_TONES.length]!}
                pages={keys.slice(0, 3).map((key) => pictures.get(key) ?? null)}
                badge={<Icon of={ArrowUpRight} size={14} mirror />}
                label={t('folders.open', { name: folder.label })}
                onOpen={() => setOpenId(folder.id)}
              />
            </li>
          );
        })}
        <li ref={addRef}>
          <FolderCard
            name={t('folders.add')}
            detail={t('folders.addDetail')}
            tone="add"
            pages={[]}
            badge={<Icon of={Plus} size={15} />}
            onOpen={() =>
              addRef.current &&
              showMenu(addRef.current, t('folders.add'), [
                { id: 'folder', label: t('library.addFolder'), icon: <Icon of={Folder} />, onSelect: addFolder },
                { id: 'files', label: t('library.addFiles'), icon: <Icon of={FileText} />, onSelect: () => filesInput.current?.click() },
              ])
            }
          />
        </li>
      </ul>
      {folders.length === 0 && index.status !== 'opening' && <p className="home-note">{t('folders.empty')}</p>}
      {cloud.providers.length > 0 && (
        <>
          <h3 className="folders-group">{t('cloud.home.title')}</h3>
          <ul className="folders-grid">
            {cloud.providers.map((provider) => (
              <li key={provider}>
                <DriveFolder provider={provider} onOpen={() => setOpenDrive(provider)} onChoose={(from) => chooseMore(provider, from)} />
              </li>
            ))}
          </ul>
          <p className="home-note">{t(cloud.desktop ? 'cloud.home.noteDesktop' : 'cloud.home.noteWeb')}</p>
        </>
      )}
      {menus}
    </section>
  );
}

/** A cloud drive as a folder: its recent files stand in it; a click opens the drive, its badge chooses more. */
function DriveFolder({ provider, onOpen, onChoose }: { provider: ProviderId; onOpen: () => void; onChoose: (from: HTMLElement) => void }) {
  const { t } = useI18n();
  const cloud = useCloud();
  const account = cloud.accounts[provider];
  const drive = t(`cloud.name.${provider}`);
  const pages = cloud.recent
    .filter((entry) => entry.provider === provider)
    .slice(0, 3)
    .map((entry) => cloud.thumbnails[recentId(entry)] ?? null);
  return (
    <div className="folders-drive">
      <FolderCard
        name={drive}
        detail={account ? t('cloud.account.as', { who: isolate(account.email || account.name) }) : t('folders.signIn')}
        tone={provider}
        pages={pages}
        badge={<Icon of={Plus} size={15} />}
        badgeLabel={t('folders.choose')}
        onBadge={onChoose}
        label={t('folders.open', { name: drive })}
        onOpen={onOpen}
      />
      {account && (
        <button
          type="button"
          className="link-btn"
          aria-label={t('cloud.signOut.label', { drive })}
          title={t(provider === 'onedrive' ? 'cloud.signOutNote.onedrive' : 'cloud.signOutNote.gdrive')}
          onClick={() => void cloud.signOut(provider)}
        >
          {t('cloud.signOut')}
        </button>
      )}
    </div>
  );
}

/**
 * An open drive, as an open folder: a card to choose more, then its folders
 * and PDFs as pages (the first page of each one opened before), each opening
 * with one click. Not signed in: a card to sign in, and nothing reaches the
 * drive until it is pressed.
 */
function DriveFiles({ provider, onBack, onChoose }: { provider: ProviderId; onBack: () => void; onChoose: (from: HTMLElement) => void }) {
  const { t, lang } = useI18n();
  const cloud = useCloud();
  const account = cloud.accounts[provider];
  const drive = useMemo(() => cloud.drive(provider), [cloud, provider]);
  const name = t(`cloud.name.${provider}`);
  const [path, setPath] = useState<{ key: string; name: string }[]>([]);
  const here = path[path.length - 1]?.key ?? null;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ view: string; here: string | null; entries: Entry[]; next: string | null; failed: CloudErrorKind | null } | null>(null);
  const [more, setMore] = useState(false);
  // Listed again when the person comes back from choosing or opening (what the drive lets the app see grows).
  const view = JSON.stringify([provider, account?.email ?? null, here, attempt, cloud.recent.length, cloud.activity === null]);
  const { signInAgain } = cloud;

  useEffect(() => {
    if (!account || cloud.activity !== null) return;
    let alive = true;
    drive.list(here).then(
      (listing) => alive && setResult({ view, here, entries: listing.entries, next: listing.next, failed: null }),
      (error: unknown) => {
        if (!alive) return;
        const kind = kindOf(error);
        setResult({ view, here, entries: [], next: null, failed: kind });
        if (kind === 'signedOut') signInAgain(provider, { kind: 'stay' });
      },
    );
    return () => {
      alive = false;
    };
    // Once per drive, folder, account and retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // While it is listed again, what was there stays on screen (the same folder only).
  const current = result && result.here === here ? result : null;
  const loading = Boolean(account) && (result?.view !== view || more);
  // A drive walked by folder lists folders first, then by name, as its own sheet does.
  const entries = useMemo(() => {
    const listed = current?.entries ?? [];
    if (!drive.folders) return listed;
    const collator = new Intl.Collator(lang, { numeric: true, sensitivity: 'base' });
    return [...listed].sort((a, b) => ((a.kind === 'folder') === (b.kind === 'folder') ? collator.compare(a.name, b.name) : a.kind === 'folder' ? -1 : 1));
  }, [current, drive, lang]);
  const showMore = (page: string) => {
    setMore(true);
    drive
      .list(here, page)
      .then((listing) => setResult((shown) => (shown ? { ...shown, entries: [...shown.entries, ...listing.entries], next: listing.next } : shown)))
      .catch((error: unknown) => setResult((shown) => (shown ? { ...shown, failed: kindOf(error) } : shown)))
      .finally(() => setMore(false));
  };

  return (
    <section className="home-section folders folders-open" aria-labelledby="home-drive">
      <div className="home-section-header">
        <button type="button" className="icon-btn icon-btn-labeled folders-back" onClick={path.length > 0 ? () => setPath((now) => now.slice(0, -1)) : onBack}>
          <Icon of={ChevronLeft} size={15} mirror />
          {path.length > 0 ? (path[path.length - 2]?.name ?? name) : t('folders.back')}
        </button>
        <h2 id="home-drive" dir="auto">
          <Icon of={Cloud} size={18} /> {name}
          {path.map((place) => (
            <span key={place.key} className="folders-crumb">
              <Icon of={ChevronRight} size={14} mirror /> <bdi>{place.name}</bdi>
            </span>
          ))}
        </h2>
        {account && <span className="folders-open-count">{t('cloud.account.as', { who: isolate(account.email || account.name) })}</span>}
        {account && (
          <button type="button" className="link-btn" onClick={() => void cloud.signOut(provider).then(onBack)}>
            {t('cloud.signOut')}
          </button>
        )}
      </div>
      <ul className="recent-grid folders-files">
        <li className="recent-card">
          <button
            type="button"
            className="dropzone recent-item"
            aria-haspopup={account ? 'menu' : undefined}
            onClick={(event) => (account ? onChoose(event.currentTarget) : cloud.startSignIn(provider))}
          >
            <span className="recent-page dropzone-page">
              <Icon of={account ? Plus : Cloud} size={28} />
            </span>
            <span className="recent-name">
              <strong>{account ? t('folders.choose') : t('cloud.signIn.button')}</strong>
              <span className="dropzone-or">{account ? t('folders.chooseHint', { drive: name }) : t('folders.signInHint', { drive: name })}</span>
            </span>
          </button>
        </li>
        {account &&
          entries.map((entry, at) => {
            const picture = entry.kind === 'pdf' ? cloud.thumbnails[recentId({ provider, key: entry.key })] : undefined;
            return (
              <li key={entry.key} className="recent-card" style={{ '--at': Math.min(at + 1, 12) } as CSSProperties}>
                <button
                  type="button"
                  className="recent-item"
                  disabled={cloud.activity !== null}
                  onClick={() => (entry.kind === 'folder' ? setPath((now) => [...now, { key: entry.key, name: entry.name }]) : void cloud.openEntry(provider, entry))}
                  title={entry.kind === 'folder' ? entry.name : t('home.recentOpen', { name: entry.name })}
                >
                  <span className="recent-page">
                    {picture ? <img src={picture} alt="" /> : <Icon of={entry.kind === 'folder' ? Folder : FileText} size={28} />}
                  </span>
                  <span className="recent-name" dir="auto">
                    {entry.name.replace(/\.pdf$/i, '')}
                  </span>
                </button>
              </li>
            );
          })}
      </ul>
      {loading && (
        <p className="home-note" role="status">
          <Icon of={Loader} className="spin" size={15} /> {cloud.activity?.kind === 'opening' && cloud.activity.name ? t('cloud.browse.opening', { name: isolate(cloud.activity.name) }) : t('cloud.browse.loading')}
        </p>
      )}
      {account && !loading && current && !current.failed && entries.length === 0 && (
        <p className="home-note">{provider === 'gdrive' ? (here ? t('cloud.browse.googleFolderEmpty') : t('cloud.browse.googleEmpty')) : t('cloud.browse.empty')}</p>
      )}
      {current?.failed && (
        <p className="field-error" role="alert">
          {t(errorKey(current.failed))}{' '}
          <button type="button" className="link-btn" onClick={() => setAttempt((count) => count + 1)}>
            {t('cloud.retry')}
          </button>
        </p>
      )}
      {current?.next && !loading && (
        <button type="button" className="link-btn" onClick={() => showMore(current.next!)}>
          {t('folders.more')}
        </button>
      )}
    </section>
  );
}

/** An open folder: its files as pages, each opening with one click. */
function FolderFiles({ index, folder, keys, onBack }: { index: LibraryIndex; folder: FolderRecord; keys: readonly string[]; onBack: () => void }) {
  const { t, lang } = useI18n();
  const services = useServices();
  const dispatch = useAppDispatch();
  const [shown, setShown] = useState(60);
  const pictures = usePictures(index.store, keys.slice(0, shown));
  const [problem, setProblem] = useState<{ key: string; note: string } | null>(null);
  const number = new Intl.NumberFormat(lang === 'ar' ? 'ar-SA-u-nu-arab' : 'en-US').format(keys.length);

  const open = (key: string) => {
    setProblem(null);
    const name = nameOf(index, key);
    void (async () => {
      if (mustChooseAgain(index.meta, key)) {
        setProblem({ key, note: t('starred.chooseAgain', { name }) });
        const chosen = await chooseAgain(key, name);
        if (!chosen) return;
        setProblem(null);
        await services.openFile(chosen);
        return;
      }
      const file = await fileForKey(index.meta, key).catch(() => null);
      if (!file) {
        setProblem({ key, note: t('starred.libraryMissing', { name }) });
        return;
      }
      await services.openFile(file);
    })();
  };

  return (
    <section className="home-section folders folders-open" aria-labelledby="home-folder">
      <div className="home-section-header">
        <button type="button" className="icon-btn icon-btn-labeled folders-back" onClick={onBack}>
          <Icon of={ChevronLeft} size={15} mirror />
          {t('folders.back')}
        </button>
        <h2 id="home-folder" dir="auto">
          <Icon of={Folder} size={18} /> {folder.label}
        </h2>
        <span className="folders-open-count">{t('folders.count', { count: number })}</span>
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'library' });
          }}
        >
          <Icon of={FolderSearch} size={14} /> {t('folders.search')}
        </button>
      </div>
      {keys.length === 0 ? (
        <p className="home-note">{t('folders.nothing')}</p>
      ) : (
        <ul className="recent-grid folders-files">
          {keys.slice(0, shown).map((key, at) => {
            const name = nameOf(index, key);
            const picture = pictures.get(key);
            return (
              <li key={key} className="recent-card" style={{ '--at': Math.min(at, 12) } as CSSProperties}>
                <button type="button" className="recent-item" onClick={() => open(key)} title={t('home.recentOpen', { name })}>
                  <span className="recent-page">{picture ? <img src={picture} alt="" /> : <Icon of={FileText} size={28} />}</span>
                  <span className="recent-name" dir="auto">
                    {name.replace(/\.pdf$/i, '')}
                  </span>
                </button>
                {problem?.key === key && (
                  <p className="field-error" role="alert">
                    {problem.note}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {keys.length > shown && (
        <button type="button" className="link-btn" onClick={() => setShown((one) => one + 60)}>
          {t('folders.more')}
        </button>
      )}
    </section>
  );
}

function nameOf(index: LibraryIndex, key: string): string {
  return index.meta.files[key]?.name ?? key.split(/[\\/]/).pop() ?? key;
}

/** The Library's pictures of these files, as object URLs, freed when they change. */
function usePictures(store: LibraryStore, keys: readonly string[]): ReadonlyMap<string, string> {
  const [pictures, setPictures] = useState<ReadonlyMap<string, string>>(new Map());
  const joined = keys.join('\n');
  useEffect(() => {
    let alive = true;
    const made = new Map<string, string>();
    void (async () => {
      for (const key of joined.split('\n').filter(Boolean)) {
        const thumb = await store.readThumb(key).catch(() => null);
        if (!alive) return;
        if (thumb?.image) made.set(key, URL.createObjectURL(new Blob([thumb.image], { type: thumb.mime })));
      }
      if (alive) setPictures(new Map(made));
    })();
    return () => {
      alive = false;
      for (const url of made.values()) URL.revokeObjectURL(url);
    };
  }, [joined, store]);
  return pictures;
}
