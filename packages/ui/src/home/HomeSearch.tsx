import { useEffect, useId, useRef, useState } from 'react';
import { FileText, Library, Search, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useI18n } from '../i18n/useT';
import type { SearchHit } from '../library/ops';
import { fileForKey, folderOf } from '../library/sources';
import { snippet } from '../library/snippet';
import { useServices } from '../state/AppContext';
import type { LibraryIndex } from './useLibraryIndex';
import { requestPage } from './pendingPage';

const LIMIT = 6;

/**
 * The home screen's search field (⌘K). It searches two things this device
 * really has: the recent files, by name, and — when the Library holds an
 * index — the text of every document in it, through the same core search
 * the Library tool runs. A recent file is asked for again (only its name is
 * kept); a Library hit opens its document at the page of the match.
 */
export function HomeSearch({ index }: { index: LibraryIndex }) {
  const { t, lang } = useI18n();
  const services = useServices();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  // What the Library answered, and for which words: an answer to older words is not shown.
  const [found, setFound] = useState<{ query: string; hits: SearchHit[] }>({ query: '', hits: [] });
  const [missing, setMissing] = useState<{ key: string; note: string } | null>(null);
  const resultsId = useId();

  // ⌘K (Ctrl+K) puts the caret here from anywhere on the home screen.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The Library is asked a beat after the typing stops, and only while there is an index.
  const search = index.search;
  const ready = index.status === 'ready';
  useEffect(() => {
    const asked = query.trim();
    if (!ready || asked.length === 0) return undefined;
    let alive = true;
    const timer = setTimeout(() => {
      void search(asked, LIMIT)
        .then((hits) => {
          if (alive) setFound({ query: asked, hits });
        })
        .catch(() => {
          if (alive) setFound({ query: asked, hits: [] });
        });
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, ready, search]);

  const wanted = query.trim().toLocaleLowerCase(lang);
  const recents = wanted.length === 0 ? [] : services.recent.filter((name) => name.toLocaleLowerCase(lang).includes(wanted)).slice(0, LIMIT);
  const hits = ready && found.query === query.trim() ? found.hits : [];
  const open = wanted.length > 0;
  const nothing = open && recents.length === 0 && hits.length === 0;

  // A hit opens its document at its page. A document added to the Library
  // one file at a time cannot be read again by the app (a browser keeps no
  // way back to it): it is asked for, and opens at the page once chosen.
  const openHit = (hit: SearchHit) => {
    void (async () => {
      setMissing(null);
      if (folderOf(index.meta, hit.key)?.source === 'files') {
        setMissing({ key: hit.key, note: t('starred.chooseAgain', { name: hit.name }) });
        requestPage(hit.page);
        services.requestOpenFile();
        return;
      }
      const file = await fileForKey(index.meta, hit.key, new Map()).catch(() => null);
      if (!file) {
        setMissing({ key: hit.key, note: t('library.missing', { name: hit.name }) });
        return;
      }
      await services.openFile(file);
      requestPage(hit.page);
    })();
  };

  return (
    <div className="home-search" role="search">
      <div className="home-search-field">
        <Icon of={Search} size={16} className="home-search-icon" />
        <input
          ref={input}
          type="search"
          className="home-search-input"
          aria-label={t('home.searchLabel')}
          aria-describedby={`${resultsId}-hint`}
          aria-controls={open ? resultsId : undefined}
          aria-expanded={open}
          placeholder={t('home.search')}
          dir="auto"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault();
              setQuery('');
            }
          }}
        />
        <kbd className="home-search-key" aria-hidden="true">
          ⌘K
        </kbd>
        {query && <IconButton className="home-search-clear" label={t('home.searchClear')} icon={<Icon of={X} size={14} />} onClick={() => setQuery('')} />}
      </div>
      <span id={`${resultsId}-hint`} className="sr-only">
        {t('home.searchHint')}
      </span>
      {open && (
        <div id={resultsId} className="home-search-results glass" role="region" aria-label={t('home.searchResults')}>
          {recents.length > 0 && (
            <section>
              <h4>{t('home.searchRecents')}</h4>
              <ul>
                {recents.map((name) => (
                  <li key={name}>
                    <button type="button" className="home-search-hit" onClick={services.requestOpenFile} aria-label={t('home.recentOpen', { name })}>
                      <Icon of={FileText} size={16} />
                      <span dir="auto">{name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {hits.length > 0 && (
            <section>
              <h4>{t('home.searchLibrary')}</h4>
              <ul>
                {hits.map((hit, place) => {
                  const cut = snippet(hit.text, hit.spans);
                  return (
                    <li key={`${hit.key}:${hit.page}:${hit.line}:${place}`}>
                      <button
                        type="button"
                        className="home-search-hit"
                        aria-label={t('home.searchOpen', { name: hit.name, page: hit.page })}
                        onClick={() => openHit(hit)}
                      >
                        <Icon of={Library} size={16} />
                        <span className="home-search-hit-text">
                          <span dir="auto">
                            {hit.name} · {t('library.hitPage', { page: hit.page })}
                          </span>
                          <span className="home-search-snippet" dir="auto">
                            {cut.cutStart && '…'}
                            {cut.parts.map((part, at) => (part.match ? <mark key={at}>{part.text}</mark> : <span key={at}>{part.text}</span>))}
                            {cut.cutEnd && '…'}
                          </span>
                        </span>
                      </button>
                      {missing?.key === hit.key && (
                        <p className="field-error" role="alert">
                          {missing.note}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {nothing && <p className="home-note">{t('home.searchNone', { query: query.trim() })}</p>}
          {open && index.status === 'none' && <p className="home-note">{t('home.searchLibraryNone')}</p>}
          {open && index.status === 'opening' && (
            <p className="home-note" role="status">
              {t('home.libraryOpening')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
