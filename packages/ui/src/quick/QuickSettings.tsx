import { useEffect } from 'react';
import { isTauriHost, setShellMenu, shellMenuState } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import { readJson, writeJson } from '../state/preferences';
import { getSettings } from '../state/settings';

/**
 * The right-click menu's switch (Settings › Quick tools), and keeping the
 * menu in step with it and with the tools chosen there. On Windows the app writes the menu itself
 * (`src-tauri/src/shell_menu.rs`): at every start, in the interface's
 * language and pointing at this copy of the app, unless the person turned
 * it off. On macOS the menu is a system service the person turns on or off
 * in System Settings; this only says where.
 */

const KEY = 'warraq.quickTools';

export interface QuickPreferences {
  /** The right-click menu (Windows). The ring's switches are the host's (`ring.rs`). */
  menu: boolean;
}

export function readQuickPreferences(): QuickPreferences {
  const raw = readJson<Record<string, unknown>>(KEY, {});
  return { menu: typeof raw.menu === 'boolean' ? raw.menu : true };
}

export function writeQuickPreferences(patch: Partial<QuickPreferences>): QuickPreferences {
  const next = { ...readQuickPreferences(), ...patch };
  writeJson(KEY, next);
  return next;
}

/** Puts the right-click menu in (or keeps it out) at start and when the language changes. */
export function useShellMenuSync(): void {
  const { lang } = useI18n();
  useEffect(() => {
    if (!isTauriHost()) return;
    const { menu } = readQuickPreferences();
    void shellMenuState()
      .then((state) => (state.kind === 'registry' ? setShellMenu(menu, lang, getSettings().shellMenuTools) : state))
      .catch(() => undefined);
  }, [lang]);
}
