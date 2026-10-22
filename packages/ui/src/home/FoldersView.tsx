import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowUpRight, ChevronLeft, Cloud, FileText, Folder, FolderSearch, Plus } from 'lucide-react';
import { useCloud } from '../cloud/CloudContext';
import { isolate } from '../cloud/CloudBrowser';
import { recentId } from '../cloud/store';
import type { ProviderId } from '../cloud/config';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import { postLibraryRequest } from '../library/request';
import { fileForKey, folderOf, keysUnder } from '../library/sources';
import type { FolderRecord, LibraryStore } from '../library/store';
import { useAppDispatch, useServices } from '../state/AppContext';
import { FolderCard, LOCAL_TONES } from './FolderCard';
import type { LibraryIndex } from './useLibraryIndex';

/**
 * Folders: the person's own folders, as the Library holds them, and the
 * cloud drives this build offers, in one place. A folder opens to its files,
 * which open with one click; "New folder" adds one through the Library (it
 * reads the folder so its files can be searched, and never moves or changes
 * them). A drive opens its own browser, signing in first when it has to.
 * Drives appear only in a build that has them (docs/cloud.md).
 */
export function FoldersView({ index }: { index: LibraryIndex }) {
  const { t, lang } = useI18n();
  const cloud = useCloud();
  const dispatch = useAppDispatch();
  const [openId, setOpenId] = useState<string | null>(null);
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

  if (opened) {
    return <FolderFiles index={index} folder={opened} keys={keysOf.get(opened.id) ?? []} onBack={() => setOpenId(null)} />;
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
        <li>
          <FolderCard
            name={t('folders.add')}
            detail={t('folders.addDetail')}
            tone="add"
            pages={[]}
            badge={<Icon of={Plus} size={15} />}
            onOpen={addFolder}
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
                <DriveFolder provider={provider} />
              </li>
            ))}
          </ul>
          <p className="home-note">{t(cloud.desktop ? 'cloud.home.noteDesktop' : 'cloud.home.noteWeb')}</p>
        </>
      )}
    </section>
  );
}

/** A cloud drive as a folder: its recent files stand in it; a click opens the drive. */
function DriveFolder({ provider }: { provider: ProviderId }) {
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
        badge={<Icon of={Cloud} size={14} />}
        label={t(provider === 'onedrive' ? 'cloud.menu.open.onedrive' : 'cloud.menu.open.gdrive')}
        onOpen={() => cloud.startOpen(provider)}
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
      if (folderOf(index.meta, key)?.source === 'files') {
        setProblem({ key, note: t('starred.chooseAgain', { name }) });
        services.requestOpenFile();
        return;
      }
      const file = await fileForKey(index.meta, key, new Map()).catch(() => null);
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
