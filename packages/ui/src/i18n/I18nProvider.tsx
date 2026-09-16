import { createContext, useCallback, useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { detectLanguage, directionOf, translate } from './messages';
import type { Direction, Lang, TKey, TParams } from './messages';
import { readPreferences, writePreferences } from '../state/preferences';

export interface I18nContextValue {
  lang: Lang;
  dir: Direction;
  setLang: (lang: Lang) => void;
  t: (key: TKey, params?: TParams) => string;
}

export const I18nContext = createContext<I18nContextValue | null>(null);

interface I18nProviderProps {
  children: ReactNode;
  /** Overrides detection (used by hosts and tests). */
  initialLang?: Lang;
}

export function I18nProvider({ children, initialLang }: I18nProviderProps) {
  const [lang, setLangState] = useState<Lang>(() => {
    if (initialLang) return initialLang;
    const navigatorLanguage = typeof navigator === 'undefined' ? undefined : navigator.language;
    return detectLanguage(navigatorLanguage, readPreferences().lang ?? null);
  });

  // Switching the language flips <html dir> and lang without a reload.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.lang = lang;
    root.dir = directionOf(lang);
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    writePreferences({ lang: next });
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({
      lang,
      dir: directionOf(lang),
      setLang,
      t: (key, params) => translate(lang, key, params),
    }),
    [lang, setLang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
