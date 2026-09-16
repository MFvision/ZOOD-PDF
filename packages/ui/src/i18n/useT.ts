import { useContext } from 'react';
import { I18nContext } from './I18nProvider';
import type { I18nContextValue } from './I18nProvider';

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside <I18nProvider>');
  return value;
}

/** Tiny translation hook: `const t = useT(); t('file.open')`. */
export function useT(): I18nContextValue['t'] {
  return useI18n().t;
}
