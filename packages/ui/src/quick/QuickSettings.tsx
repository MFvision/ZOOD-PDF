import { useEffect, useState } from 'react';
import { isTauriHost, setShellMenu, shellMenuState } from '../core/host-tauri';
import type { ShellMenuState } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import { readJson, writeJson } from '../state/preferences';

/**
 * The quick tools' switches in Settings, and keeping the right-click menu
 * in step with them. On Windows the app writes the menu itself
 * (`src-tauri/src/shell_menu.rs`): at every start, in the interface's
 * language and pointing at this copy of the app, unless the person turned
 * it off. On macOS the menu is a system service the person turns on or off
 * in System Settings; this only says where.
 */

const KEY = 'warraq.quickTools';

export interface QuickPreferences {
  /** The right-click menu (Windows). */
  menu: boolean;
  /** The ring at the pointer when a file is dragged with Ctrl (Option on a Mac). */
  ring: boolean;
}

export function readQuickPreferences(): QuickPreferences {
  const raw = readJson<Record<string, unknown>>(KEY, {});
  return {
    menu: typeof raw.menu === 'boolean' ? raw.menu : true,
    ring: typeof raw.ring === 'boolean' ? raw.ring : true,
  };
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
      .then((state) => (state.kind === 'registry' ? setShellMenu(menu, lang) : state))
      .catch(() => undefined);
  }, [lang]);
}

export function QuickSettings() {
  const { t, lang } = useI18n();
  const [prefs, setPrefs] = useState(readQuickPreferences);
  const [menu, setMenu] = useState<ShellMenuState | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void shellMenuState()
      .then((state) => {
        if (live) setMenu(state);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!isTauriHost() || !menu || menu.kind === 'none') return null;

  const toggleMenu = (on: boolean) => {
    setPrefs(writeQuickPreferences({ menu: on }));
    setFailed(false);
    setShellMenu(on, lang)
      .then(setMenu)
      .catch(() => setFailed(true));
  };

  return (
    <section className="settings-section" aria-labelledby="settings-quick">
      <h3 id="settings-quick">{t('quick.settings.title')}</h3>
      {menu.kind === 'registry' ? (
        <>
          <label className="font-library-switch">
            <input type="checkbox" checked={prefs.menu && menu.on} onChange={(event) => toggleMenu(event.target.checked)} />
            <span>{t('quick.settings.menu')}</span>
          </label>
          <p className="tool-panel-note">{t('quick.settings.menuNoteWindows')}</p>
        </>
      ) : (
        <p className="tool-panel-note">{t('quick.settings.menuNoteMac')}</p>
      )}
      {failed ? (
        <p className="tool-panel-note" role="alert">
          {t('quick.settings.failed')}
        </p>
      ) : null}
    </section>
  );
}
