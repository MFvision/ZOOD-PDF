import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useAppState, useServices } from '../state/AppContext';
import { useT } from '../i18n/useT';

/**
 * Editable current-page box, "3 of 12": commits on Enter or blur and re-syncs
 * when the page changes. It moves whichever view is on screen.
 */
export function PageInput() {
  const { currentPage, document } = useAppState();
  const { goToPage } = useServices();
  const t = useT();
  const [value, setValue] = useState(String(currentPage));
  const [syncedPage, setSyncedPage] = useState(currentPage);
  if (syncedPage !== currentPage) {
    setSyncedPage(currentPage);
    setValue(String(currentPage));
  }
  const total = document?.pageCount ?? 0;

  const commit = () => {
    // Arabic-Indic and Persian digits type the same page as ASCII ones.
    const page = Number(
      value.trim().replace(/[٠-٩۰-۹]/g, (digit) => String((digit.charCodeAt(0) - 0x660) % 0x90)),
    );
    if (Number.isInteger(page) && page >= 1 && page <= total) goToPage(page);
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
        type="text"
        inputMode="numeric"
        size={Math.max(1, String(total).length)}
        aria-label={t('nav.pageInput')}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      <span className="page-total" aria-hidden="true">
        {t('shell.pageOf', { total })}
      </span>
    </span>
  );
}
