import { useEffect } from 'react';
import { getSettings, useSettings } from '../state/settings';
import type { AppSettings } from '../state/settings';

/**
 * Settings › Appearance on <html>, as data attributes that
 * `styles/appearance.css` reads. An attribute is left off when the setting is
 * the look's own (its accent, coloured icons, medium size, following the
 * system), so a look with nothing chosen over it is exactly the look.
 */
export function applyAppearance(root: HTMLElement, settings: AppSettings = getSettings()): void {
  const set = (name: string, value: string | null) => {
    if (value === null) delete root.dataset[name];
    else root.dataset[name] = value;
  };
  set('icons', settings.icons === 'plain' ? 'plain' : null);
  set('iconSize', settings.iconSize === 'medium' ? null : settings.iconSize);
  set('accent', settings.accent === 'look' ? null : settings.accent);
  set('reduceTransparency', settings.reduceTransparency === 'on' ? 'on' : null);
  set('reduceMotion', settings.reduceMotion === 'on' ? 'on' : null);
}

/** Keeps <html> in step with the settings, in the main window. */
export function SettingsEffects() {
  const settings = useSettings();
  useEffect(() => {
    applyAppearance(globalThis.document.documentElement, settings);
  }, [settings]);
  return null;
}
