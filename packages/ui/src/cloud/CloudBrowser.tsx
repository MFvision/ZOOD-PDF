import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { ChevronRight, FileText, Folder, Loader, Search } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import { useAppState } from '../state/AppContext';
import { errorKey, useCloud } from './CloudContext';
import type { ProviderId } from './config';
import type { Entry } from './drive';
import { kindOf } from './errors';
import type { CloudErrorKind } from './errors';
import { oneDriveName } from './onedrive';

/** A name set apart from the sentence around it, whatever its direction (FSI … PDI). */
export const isolate = (text: string) => `\u2068${text}\u2069`;

interface Place {
  key: string | null;
  name: string;
}

/**
 * A drive's folders and PDFs, to open one or to choose where to save. OneDrive
 * is walked folder by folder, with a search over the whole drive; Google
 * Drive, with drive.file, lists the PDFs the app may open, and its own picker
 * — part of Google's consent screen — is where the rest are chosen. Every
 * listing follows the person's click (opening this sheet, a folder, Search,
 * Show More).
 */
export function CloudBrowser({
  provider,
  mode,
  folder,
  initialName,
}: {
  provider: ProviderId;
  mode: 'open' | 'saveAs';
  folder?: { key: string; name: string | null };
  initialName?: string;
}) {
  const cloud = useCloud();
  const { t, lang } = useI18n();
  const { document } = useAppState();
  const drive = useMemo(() => cloud.drive(provider), [cloud, provider]);
  const walks = drive.folders;
  const driveName = t(`cloud.name.${provider}`);
  const [path, setPath] = useState<Place[]>(() => [
    { key: null, name: t('cloud.browse.top') },
    ...(folder && walks ? [{ key: folder.key, name: folder.name ?? '…' }] : []),
  ]);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState<string | null>(null);
  // What was asked (a folder or a search, and how many times) and what came
  // back for it: loading is the one not yet answering the other.
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ view: string; entries: Entry[]; next: string | null; failed: CloudErrorKind | null } | null>(null);
  const [more, setMore] = useState(false);
  const [name, setName] = useState(() => initialName ?? document?.name ?? 'document.pdf');
  const here = path[path.length - 1] ?? { key: null, name: '' };
  const view = JSON.stringify([searching, here.key, attempt]);
  const busy = cloud.activity !== null;
  const { signInAgain } = cloud;

  useEffect(() => {
    let cancelled = false;
    const request = searching !== null ? drive.search(searching) : drive.list(here.key);
    request.then(
      (listing) => {
        if (!cancelled) setResult({ view, entries: listing.entries, next: listing.next, failed: null });
      },
      (error: unknown) => {
        if (cancelled) return;
        const kind = kindOf(error);
        setResult({ view, entries: [], next: null, failed: kind });
        if (kind === 'signedOut') signInAgain(provider, mode === 'open' ? { kind: 'open' } : { kind: 'saveAs' });
      },
    );
    return () => {
      cancelled = true;
    };
    // Once per folder, search or retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const current = result?.view === view ? result : null;
  const loading = current === null || more;
  const entries = useMemo(() => current?.entries ?? [], [current]);
  const next = current?.next ?? null;
  const failed = current?.failed ?? null;

  /** The page after this one, on the person's click. */
  const showMore = (page: string) => {
    setMore(true);
    const request = searching !== null ? drive.search(searching, page) : drive.list(here.key, page);
    request
      .then((listing) =>
        setResult((shown) => (shown && shown.view === view ? { ...shown, entries: [...shown.entries, ...listing.entries], next: listing.next } : shown)),
      )
      .catch((error: unknown) => setResult((shown) => (shown && shown.view === view ? { ...shown, failed: kindOf(error) } : shown)))
      .finally(() => setMore(false));
  };

  const search = (event: FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    setSearching(text.length > 0 ? text : null);
  };

  const enter = (entry: Entry) => {
    setSearching(null);
    setQuery('');
    setPath((current) => [...current, { key: entry.key, name: entry.name }]);
  };

  const shown = useMemo(() => {
    if (!walks) return entries;
    const collator = new Intl.Collator(lang, { numeric: true, sensitivity: 'base' });
    return [...entries].sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'folder' ? -1 : 1));
  }, [entries, walks, lang]);

  const size = (bytes?: number) => {
    if (bytes === undefined) return '';
    const format = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 });
    if (bytes < 1024 * 1024) return `${format.format(Math.max(1, Math.round(bytes / 1024)))} KB`;
    return `${format.format(bytes / (1024 * 1024))} MB`;
  };
  const when = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(lang, { dateStyle: 'medium' }) : '');
  /** What is said under a name; each part reads in its own direction (bidi), with a dot between. */
  const detail = (entry: Entry): string[] =>
    entry.kind === 'folder'
      ? entry.children !== undefined
        ? [t('cloud.browse.items', { count: entry.children.toLocaleString(lang) })]
        : []
      : [
          searching !== null && entry.location ? t('cloud.browse.in', { path: isolate(entry.location) }) : '',
          size(entry.size),
          when(entry.modified),
        ].filter(Boolean);

  const safeName = provider === 'onedrive' ? oneDriveName(name) : /\.pdf$/i.test(name.trim()) ? name.trim() : `${name.trim() || 'document'}.pdf`;
  const account = cloud.accounts[provider];

  return (
    <div className="cloud-browser">
      {account && (
        <div className="cloud-account-line">
          <span>{t('cloud.account.as', { who: isolate(account.email || account.name) })}</span>
          <button type="button" className="link-btn" disabled={busy} onClick={() => void cloud.signOut(provider)}>
            {t('cloud.signOut')}
          </button>
        </div>
      )}

      {!walks && <p className="cloud-note">{t('cloud.browse.googleNote')}</p>}

      <form className="cloud-search" role="search" onSubmit={search}>
        <Icon of={Search} size={15} />
        <input
          type="search"
          className="text-input"
          dir="auto"
          value={query}
          placeholder={t('cloud.browse.search', { drive: driveName })}
          aria-label={t('cloud.browse.search', { drive: driveName })}
          onChange={(event) => setQuery(event.target.value)}
        />
      </form>

      {searching !== null ? (
        <div className="cloud-path-line">
          <span>{t('cloud.browse.results', { query: isolate(searching) })}</span>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setSearching(null);
              setQuery('');
            }}
          >
            {walks ? t('cloud.browse.back') : t('cloud.browse.googleList')}
          </button>
        </div>
      ) : walks ? (
        <nav aria-label={t('cloud.browse.path')}>
          <ol className="cloud-path">
            {path.map((place, index) => (
              <li key={`${place.key ?? 'top'}-${index}`}>
                {index > 0 && <Icon of={ChevronRight} size={13} mirror />}
                <button
                  type="button"
                  className="link-btn"
                  aria-current={index === path.length - 1 ? 'location' : undefined}
                  onClick={() => setPath((current) => current.slice(0, index + 1))}
                >
                  <bdi>{place.name}</bdi>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      ) : (
        <p className="cloud-path-line">{t('cloud.browse.googleList')}</p>
      )}

      <ul className="cloud-list" aria-label={t('cloud.browse.list')} aria-busy={loading || undefined}>
        {shown.map((entry) => {
          const disabled = busy || (mode === 'saveAs' && entry.kind === 'pdf');
          return (
            <li key={entry.key}>
              <button
                type="button"
                className="cloud-row"
                disabled={disabled}
                onClick={() => (entry.kind === 'folder' ? enter(entry) : void cloud.openEntry(provider, entry))}
              >
                <Icon of={entry.kind === 'folder' ? Folder : FileText} />
                <span className="cloud-row-text">
                  <span className="cloud-row-name">
                    {/* The name reads in its own direction, but starts where the row does. */}
                    <bdi>{entry.name}</bdi>
                  </span>
                  <span className="cloud-row-detail">
                    {detail(entry).map((part) => (
                      <bdi key={part}>{part}</bdi>
                    ))}
                  </span>
                </span>
                {entry.kind === 'folder' && <Icon of={ChevronRight} size={15} mirror />}
              </button>
            </li>
          );
        })}
      </ul>

      {loading && (
        <p className="cloud-status" role="status">
          <Icon of={Loader} className="spin" size={15} />
          <span>{t('cloud.browse.loading')}</span>
        </p>
      )}
      {!loading && !failed && entries.length === 0 && (
        <p className="cloud-status">
          {searching !== null ? t('cloud.browse.emptySearch') : walks ? t('cloud.browse.empty') : t('cloud.browse.googleEmpty')}
        </p>
      )}
      {failed && (
        <p className="field-error cloud-status" role="alert">
          <span>{t(errorKey(failed))}</span>
          <button type="button" className="link-btn" onClick={() => setAttempt((count) => count + 1)}>
            {t('cloud.retry')}
          </button>
        </p>
      )}
      {next && !loading && (
        <button type="button" className="link-btn cloud-more" onClick={() => showMore(next)}>
          {t('cloud.browse.more')}
        </button>
      )}

      {cloud.activity && cloud.activity.kind !== 'signIn' && (
        <p className="cloud-status" role="status">
          <Icon of={Loader} className="spin" size={15} />
          <span>
            {cloud.activity.kind === 'opening'
              ? cloud.activity.name
                ? t('cloud.browse.opening', { name: isolate(cloud.activity.name) })
                : t('cloud.browse.loading')
              : t('cloud.browse.saving', { name: isolate(cloud.activity.name ?? safeName) })}
          </span>
        </p>
      )}
      {cloud.error && (
        <p className="field-error" role="alert">
          {t(errorKey(cloud.error))}
        </p>
      )}

      {mode === 'saveAs' && (
        <label className="field">
          <span>{t('cloud.browse.name')}</span>
          <input className="text-input" dir="auto" value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
          {safeName !== name.trim() && <span className="cloud-note">{t('cloud.browse.nameNote', { name: isolate(safeName) })}</span>}
        </label>
      )}

      <div className="dialog-actions">
        <button type="button" className="icon-btn icon-btn-labeled" onClick={cloud.cancel}>
          {t('cloud.cancel')}
        </button>
        {mode === 'open' && !walks && (
          <button type="button" className="icon-btn icon-btn-labeled icon-btn-primary" disabled={busy} onClick={() => cloud.pickWithGoogle('open')}>
            {t('cloud.pick.open')}
          </button>
        )}
        {mode === 'saveAs' && !walks && (
          <>
            <button type="button" className="icon-btn icon-btn-labeled" disabled={busy} onClick={() => cloud.pickWithGoogle('folder', safeName)}>
              {t('cloud.pick.folder')}
            </button>
            {folder && (
              <button type="button" className="icon-btn icon-btn-labeled" disabled={busy} onClick={() => void cloud.saveInto(provider, folder.key, safeName)}>
                {t('cloud.browse.saveBeside')}
              </button>
            )}
            <button type="button" className="icon-btn icon-btn-labeled icon-btn-primary" disabled={busy} onClick={() => void cloud.saveInto(provider, null, safeName)}>
              {t('cloud.browse.saveMyDrive')}
            </button>
          </>
        )}
        {mode === 'saveAs' && walks && (
          <button
            type="button"
            className="icon-btn icon-btn-labeled icon-btn-primary"
            disabled={busy || searching !== null}
            onClick={() => void cloud.saveInto(provider, here.key, safeName)}
          >
            {t('cloud.browse.saveHere')}
          </button>
        )}
      </div>
    </div>
  );
}
