import { useEffect, useState } from 'react';
import { FileText, Library, StarOff } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { isTauriHost } from '../core/host-tauri';
import { useT } from '../i18n/useT';
import { chooseAgain, fileForKey, mustChooseAgain } from '../library/sources';
import { useServices } from '../state/AppContext';
import { readRecentThumbnails } from '../state/recent';
import { unstar, useStarred } from '../state/starred';
import type { StarredItem } from '../state/starred';
import type { LibraryIndex } from './useLibraryIndex';

/**
 * Starred: the documents flagged on this device. A recent file opens the
 * way a recent file does (directly on the desktop; in a browser its name is
 * all that is kept, so the file is asked for); a Library document is read from where the Library found it. A star
 * comes off here too.
 */
export function StarredView({ index }: { index: LibraryIndex }) {
  const t = useT();
  const services = useServices();
  const starred = useStarred();
  const thumbnails = readRecentThumbnails();
  const [pictures, setPictures] = useState<ReadonlyMap<string, string>>(new Map());
  const [problem, setProblem] = useState<{ id: string; note: string } | null>(null);

  // The Library's own pictures of its starred documents, as object URLs.
  const keys = starred
    .filter((item) => item.source === 'library')
    .map((item) => item.id.slice('library:'.length))
    .join('\n');
  const store = index.store;
  useEffect(() => {
    let alive = true;
    const made = new Map<string, string>();
    void (async () => {
      for (const key of keys.split('\n').filter(Boolean)) {
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
  }, [keys, store]);

  const open = (item: StarredItem) => {
    setProblem(null);
    if (item.source === 'recent') {
      services.openRecent(item.name);
      return;
    }
    const key = item.id.slice('library:'.length);
    void (async () => {
      if (mustChooseAgain(index.meta, key)) {
        setProblem({ id: item.id, note: t('starred.chooseAgain', { name: item.name }) });
        const chosen = await chooseAgain(key, item.name);
        if (!chosen) return;
        setProblem(null);
        await services.openFile(chosen);
        return;
      }
      const file = await fileForKey(index.meta, key).catch(() => null);
      if (!file) {
        setProblem({ id: item.id, note: t('starred.libraryMissing', { name: item.name }) });
        return;
      }
      await services.openFile(file);
    })();
  };

  return (
    <section className="home-section" aria-labelledby="home-starred">
      <div className="home-section-header">
        <h2 id="home-starred">{t('starred.title')}</h2>
      </div>
      {starred.length === 0 ? (
        <p className="home-note">{t('starred.empty')}</p>
      ) : (
        <ul className="recent-grid">
          {starred.map((item) => {
            const key = item.id.slice(item.source.length + 1);
            const picture = item.source === 'recent' ? thumbnails[item.name] : pictures.get(key);
            return (
              <li key={item.id} className="recent-card">
                <button type="button" className="recent-item" onClick={() => open(item)} title={t('home.recentOpen', { name: item.name })}>
                  <span className="recent-page">
                    {picture ? <img src={picture} alt="" /> : <Icon of={item.source === 'library' ? Library : FileText} size={28} />}
                  </span>
                  <span className="recent-name" dir="auto">
                    {item.name.replace(/\.pdf$/i, '')}
                  </span>
                  <span className="recent-date">{t(item.source === 'library' ? 'tool.library' : 'home.recent')}</span>
                </button>
                <IconButton className="recent-more" label={t('starred.remove', { name: item.name })} icon={<Icon of={StarOff} size={15} />} onClick={() => unstar(item.id)} />
                {problem?.id === item.id && (
                  <p className="field-error" role="alert">
                    {problem.note}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {starred.some((item) => item.source === 'recent') && <p className="home-note">{t(isTauriHost() ? 'starred.recentNoteDesktop' : 'starred.recentNote')}</p>}
    </section>
  );
}
