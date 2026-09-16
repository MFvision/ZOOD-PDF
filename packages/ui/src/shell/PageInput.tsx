import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useAppDispatch, useAppState } from '../state/AppContext';
import { useT } from '../i18n/useT';

/** Editable current-page box; commits on Enter or blur and re-syncs when the page changes. */
export function PageInput() {
  const { currentPage, document } = useAppState();
  const dispatch = useAppDispatch();
  const t = useT();
  const [value, setValue] = useState(String(currentPage));
  const [syncedPage, setSyncedPage] = useState(currentPage);
  if (syncedPage !== currentPage) {
    setSyncedPage(currentPage);
    setValue(String(currentPage));
  }
  const total = document?.pageCount ?? 0;

  const commit = () => {
    const page = Number(value);
    if (Number.isInteger(page) && page >= 1 && page <= total) dispatch({ type: 'SCROLL_TO_PAGE', page });
    else setValue(String(currentPage));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      setValue(String(currentPage));
    }
  };

  return (
    <span className="page-input-wrap">
      <input
        className="text-input page-input"
        type="number"
        inputMode="numeric"
        min={1}
        max={total}
        aria-label={t('nav.pageInput')}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      <span className="page-total" aria-hidden="true">
        / {total}
      </span>
    </span>
  );
}
