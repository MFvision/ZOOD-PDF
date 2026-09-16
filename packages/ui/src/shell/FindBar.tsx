import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useT } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';

/** Find bar (Ctrl/Cmd+F). Searching calls `Document.search` in the core worker. */
export function FindBar() {
  const { find } = useAppState();
  const { document } = useServices();
  const dispatch = useAppDispatch();
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const query = find.query.trim();
    if (!query || !document) return;
    setBusy(true);
    try {
      const matches = await document.search(query);
      dispatch({ type: 'FIND_RESULTS', matches });
    } catch {
      dispatch({ type: 'FIND_RESULTS', matches: [] });
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dispatch({ type: 'FIND_CLOSE' });
    }
  };

  const { matches, cursor, searched } = find;
  const status = !searched
    ? ''
    : matches.length === 0
      ? t('find.noResults')
      : t('find.result', { page: (matches[cursor] ?? 0) + 1, index: cursor + 1, count: matches.length });

  return (
    <form className="findbar" role="search" aria-label={t('find.label')} onSubmit={submit} onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        className="text-input findbar-input"
        type="search"
        placeholder={t('find.placeholder')}
        aria-label={t('find.placeholder')}
        value={find.query}
        onChange={(event) => dispatch({ type: 'FIND_QUERY', query: event.target.value })}
      />
      <IconButton type="submit" label={t('find.search')} icon={<Icon of={Search} />} showLabel disabled={busy || !find.query.trim()} />
      <IconButton label={t('find.prev')} icon={<Icon of={ChevronUp} />} disabled={matches.length === 0} onClick={() => dispatch({ type: 'FIND_STEP', delta: -1 })} />
      <IconButton label={t('find.next')} icon={<Icon of={ChevronDown} />} disabled={matches.length === 0} onClick={() => dispatch({ type: 'FIND_STEP', delta: 1 })} />
      <span className="findbar-status" role="status">
        {status}
      </span>
      <IconButton label={t('find.close')} icon={<Icon of={X} />} onClick={() => dispatch({ type: 'FIND_CLOSE' })} />
    </form>
  );
}
