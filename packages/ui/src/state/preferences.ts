import type { Lang } from '../i18n/messages';

/** Everything remembered between sessions (names only, no document bytes). */
export type ThemeMode = 'system' | 'light' | 'dark';
/** The look over the light/dark appearance (`styles/looks.css`). */
export type UiLook = 'concept' | 'glass' | 'zood' | 'workbench' | 'mono';
export const LOOK_IDS: readonly UiLook[] = ['concept', 'glass', 'zood', 'workbench', 'mono'];
export type LeftTab = 'thumbnails' | 'bookmarks' | 'attachments' | 'layers' | 'comments';

export interface Preferences {
  lang?: Lang;
  theme?: ThemeMode;
  look?: UiLook;
  leftPaneOpen?: boolean;
  leftPaneWidth?: number;
  leftTab?: LeftTab;
  rightPaneOpen?: boolean;
  rightPaneWidth?: number;
}

const PREFERENCES_KEY = 'warraq.preferences';

/** Storage can throw (private mode, disabled, quota); every access is guarded. */
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: preferences simply are not remembered */
  }
}

const LANGS = new Set<string>(['ar', 'en']);
const THEMES = new Set<string>(['system', 'light', 'dark']);
const LOOKS = new Set<string>(LOOK_IDS);

/**
 * The look before the person chooses one: Liquid Glass on Apple's systems,
 * where it is at home, and the concept look everywhere else.
 */
export function defaultLook(): UiLook {
  return /Mac|iPhone|iPad|iPod/.test(globalThis.navigator?.platform ?? '') ? 'glass' : 'concept';
}
const TABS = new Set<string>(['thumbnails', 'bookmarks', 'attachments', 'layers', 'comments']);

function pickBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function pickWidth(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 120 && value <= 800
    ? value
    : undefined;
}

/** Validates stored values so a corrupted entry can never break the UI. */
export function sanitizePreferences(raw: unknown): Preferences {
  if (!raw || typeof raw !== 'object') return {};
  const p = raw as Record<string, unknown>;
  return {
    lang: typeof p.lang === 'string' && LANGS.has(p.lang) ? (p.lang as Lang) : undefined,
    theme: typeof p.theme === 'string' && THEMES.has(p.theme) ? (p.theme as ThemeMode) : undefined,
    look: typeof p.look === 'string' && LOOKS.has(p.look) ? (p.look as UiLook) : undefined,
    leftPaneOpen: pickBoolean(p.leftPaneOpen),
    leftPaneWidth: pickWidth(p.leftPaneWidth),
    leftTab: typeof p.leftTab === 'string' && TABS.has(p.leftTab) ? (p.leftTab as LeftTab) : undefined,
    rightPaneOpen: pickBoolean(p.rightPaneOpen),
    rightPaneWidth: pickWidth(p.rightPaneWidth),
  };
}

export function readPreferences(): Preferences {
  return sanitizePreferences(readJson<unknown>(PREFERENCES_KEY, {}));
}

export function writePreferences(patch: Partial<Preferences>): void {
  writeJson(PREFERENCES_KEY, { ...readPreferences(), ...patch });
}
