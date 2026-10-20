import { useSyncExternalStore } from 'react';
import { readJson, writeJson } from './preferences';

/**
 * The settings of the Settings window that are not the language, the
 * appearance (light/dark) or the look, which `preferences.ts` keeps for the
 * app state. One object, kept under one key, validated on every read so a
 * damaged entry can never break the interface; a value it does not know falls
 * back to its default. Readable outside React (`getSettings`) for the viewer
 * and the AI, and from React with `useSettings`, which re-renders on a change.
 */

export type IconStyle = 'color' | 'plain';
export type IconSize = 'small' | 'medium' | 'large';
export type Accent = 'look' | 'blue' | 'purple' | 'pink' | 'red' | 'orange' | 'green' | 'graphite';
export type Follow = 'system' | 'on';
export type StartWith = 'home' | 'reopen';
export type PageLayout = 'single' | 'continuous' | 'two' | 'book';
export type OpenZoom = 'fit-width' | 'fit-page' | 'actual' | 'remember';
export type OpenIn = 'tabs' | 'windows';
/** The menu bar in the window: drop-down menus, every command as a button, or chosen ones as buttons beside the menus. */
export type MenuBarStyle = 'menus' | 'all' | 'custom';
export type TabBar = 'always' | 'several';
export type TabPosition = 'top' | 'toolbar';
export type ReadingDirection = 'document' | 'rtl' | 'ltr';
export type NightReading = 'off' | 'on' | 'dark';
export type HomeSection = 'actions' | 'recent' | 'starred' | 'tools' | 'assistant' | 'clouds';
export type OutputPlace = 'beside' | 'folder' | 'ask';
export type RingSize = 'small' | 'medium' | 'large';
export type AiScope = 'document' | 'open' | 'library';
export type AnswerLanguage = 'question' | 'ar' | 'en';
export type AiPrompt = 'summarize' | 'keyPoints' | 'explain' | 'translate' | 'email' | 'quiz';
export type Versions = 0 | 5 | 20;

export interface AppSettings {
  /** General. */
  startWith: StartWith;
  /** Appearance. */
  icons: IconStyle;
  iconSize: IconSize;
  accent: Accent;
  reduceTransparency: Follow;
  reduceMotion: Follow;
  /** Viewing. */
  pageLayout: PageLayout;
  openZoom: OpenZoom;
  openIn: OpenIn;
  tabBar: TabBar;
  tabPosition: TabPosition;
  pagePanel: boolean;
  menuBar: MenuBarStyle;
  /** The commands shown as buttons when the menu is Custom, by their menu ids. */
  menuBarItems: string[];
  toolsPanel: boolean;
  readingDirection: ReadingDirection;
  nightReading: NightReading;
  /** Home screen: every section in the person's order, and the ones turned off. */
  greeting: boolean;
  userName: string;
  homeSections: HomeSection[];
  hiddenHomeSections: HomeSection[];
  recentLimit: 10 | 20 | 50;
  /** Quick tools outside the app (the switches themselves live with the host). */
  shellMenuTools: string[];
  ringTools: string[];
  ringShortcut: string;
  ringSize: RingSize;
  output: OutputPlace;
  outputFolder: string;
  outputPattern: string;
  /** AI (the provider and model stay in `ai/store.ts`). */
  aiScope: AiScope;
  keepChats: boolean;
  answerLanguage: AnswerLanguage;
  aiPrompts: AiPrompt[];
  hiddenAiPrompts: AiPrompt[];
  /** History and privacy. */
  keepRecent: boolean;
  undoSteps: 50 | 100 | 200;
  versions: Versions;
  autosave: boolean;
  autosaveMinutes: 1 | 5;
  /** Keyboard shortcuts the person changed, by menu item id. */
  shortcuts: Record<string, string>;
}

export const HOME_SECTIONS: readonly HomeSection[] = ['actions', 'recent', 'starred', 'tools', 'assistant', 'clouds'];
export const AI_PROMPTS: readonly AiPrompt[] = ['summarize', 'keyPoints', 'explain', 'translate', 'email', 'quiz'];
export const ACCENTS: readonly Accent[] = ['look', 'blue', 'purple', 'pink', 'red', 'orange', 'green', 'graphite'];

export const DEFAULT_SETTINGS: AppSettings = {
  startWith: 'home',
  icons: 'color',
  iconSize: 'medium',
  accent: 'look',
  reduceTransparency: 'system',
  reduceMotion: 'system',
  pageLayout: 'continuous',
  openZoom: 'fit-width',
  openIn: 'tabs',
  tabBar: 'always',
  tabPosition: 'top',
  pagePanel: true,
  menuBar: 'menus',
  menuBarItems: ['open', 'save', 'print', 'undo', 'redo', 'find', 'settings'],
  toolsPanel: true,
  readingDirection: 'document',
  nightReading: 'off',
  greeting: true,
  userName: '',
  homeSections: [...HOME_SECTIONS],
  // The tools are in the sidebar and behind More (part 5 of the plan): the grid is there to turn back on.
  hiddenHomeSections: ['tools'],
  recentLimit: 20,
  shellMenuTools: [],
  ringTools: [],
  ringShortcut: 'Mod+Alt+Z',
  ringSize: 'medium',
  output: 'beside',
  outputFolder: '',
  outputPattern: '{name} ({tool})',
  aiScope: 'document',
  keepChats: false,
  answerLanguage: 'question',
  aiPrompts: [...AI_PROMPTS],
  hiddenAiPrompts: [],
  keepRecent: true,
  undoSteps: 100,
  versions: 0,
  autosave: true,
  autosaveMinutes: 1,
  shortcuts: {},
};

const KEY = 'zood.settings';

function oneOf<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function text(value: unknown, fallback: string, max = 200): string {
  return typeof value === 'string' && value.length <= max ? value : fallback;
}

/** Every entry once, in the person's order, then any the list lacks in the default order. */
function ordered<T extends string>(value: unknown, all: readonly T[]): T[] {
  const seen = Array.isArray(value) ? value.filter((one): one is T => all.includes(one as T)) : [];
  const unique = [...new Set(seen)];
  for (const one of all) if (!unique.includes(one)) unique.push(one);
  return unique;
}

function subset<T extends string>(value: unknown, all: readonly T[], fallback: readonly T[] = []): T[] {
  return Array.isArray(value) ? [...new Set(value.filter((one): one is T => all.includes(one as T)))] : [...fallback];
}

function names(value: unknown, max = 32): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((one): one is string => typeof one === 'string' && one.length <= 40))].slice(0, max) : [];
}

function shortcuts(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [id, keys] of Object.entries(value as Record<string, unknown>)) {
    if (typeof keys === 'string' && keys.length <= 40 && /^[\w-]{1,40}$/.test(id)) out[id] = keys;
  }
  return out;
}

export function sanitizeSettings(raw: unknown): AppSettings {
  const d = DEFAULT_SETTINGS;
  if (!raw || typeof raw !== 'object') return { ...d, homeSections: [...d.homeSections], aiPrompts: [...d.aiPrompts] };
  const s = raw as Record<string, unknown>;
  return {
    startWith: oneOf(s.startWith, ['home', 'reopen'] as const, d.startWith),
    icons: oneOf(s.icons, ['color', 'plain'] as const, d.icons),
    iconSize: oneOf(s.iconSize, ['small', 'medium', 'large'] as const, d.iconSize),
    accent: oneOf(s.accent, ACCENTS, d.accent),
    reduceTransparency: oneOf(s.reduceTransparency, ['system', 'on'] as const, d.reduceTransparency),
    reduceMotion: oneOf(s.reduceMotion, ['system', 'on'] as const, d.reduceMotion),
    pageLayout: oneOf(s.pageLayout, ['single', 'continuous', 'two', 'book'] as const, d.pageLayout),
    openZoom: oneOf(s.openZoom, ['fit-width', 'fit-page', 'actual', 'remember'] as const, d.openZoom),
    openIn: oneOf(s.openIn, ['tabs', 'windows'] as const, d.openIn),
    tabBar: oneOf(s.tabBar, ['always', 'several'] as const, d.tabBar),
    tabPosition: oneOf(s.tabPosition, ['top', 'toolbar'] as const, d.tabPosition),
    pagePanel: bool(s.pagePanel, d.pagePanel),
    menuBar: oneOf(s.menuBar, ['menus', 'all', 'custom'] as const, d.menuBar),
    menuBarItems: Array.isArray(s.menuBarItems) ? names(s.menuBarItems, 40) : d.menuBarItems,
    toolsPanel: bool(s.toolsPanel, d.toolsPanel),
    readingDirection: oneOf(s.readingDirection, ['document', 'rtl', 'ltr'] as const, d.readingDirection),
    nightReading: oneOf(s.nightReading, ['off', 'on', 'dark'] as const, d.nightReading),
    greeting: bool(s.greeting, d.greeting),
    userName: text(s.userName, d.userName, 60),
    homeSections: ordered(s.homeSections, HOME_SECTIONS),
    hiddenHomeSections: subset(s.hiddenHomeSections, HOME_SECTIONS, d.hiddenHomeSections),
    recentLimit: oneOf(s.recentLimit, [10, 20, 50] as const, d.recentLimit),
    shellMenuTools: names(s.shellMenuTools),
    ringTools: names(s.ringTools, 8),
    ringShortcut: text(s.ringShortcut, d.ringShortcut, 40),
    ringSize: oneOf(s.ringSize, ['small', 'medium', 'large'] as const, d.ringSize),
    output: oneOf(s.output, ['beside', 'folder', 'ask'] as const, d.output),
    outputFolder: text(s.outputFolder, d.outputFolder, 1000),
    outputPattern: text(s.outputPattern, d.outputPattern, 120).includes('{name}') ? text(s.outputPattern, d.outputPattern, 120) : d.outputPattern,
    aiScope: oneOf(s.aiScope, ['document', 'open', 'library'] as const, d.aiScope),
    keepChats: bool(s.keepChats, d.keepChats),
    answerLanguage: oneOf(s.answerLanguage, ['question', 'ar', 'en'] as const, d.answerLanguage),
    aiPrompts: ordered(s.aiPrompts, AI_PROMPTS),
    hiddenAiPrompts: subset(s.hiddenAiPrompts, AI_PROMPTS),
    keepRecent: bool(s.keepRecent, d.keepRecent),
    undoSteps: oneOf(s.undoSteps, [50, 100, 200] as const, d.undoSteps),
    versions: oneOf(s.versions, [0, 5, 20] as const, d.versions),
    autosave: bool(s.autosave, d.autosave),
    autosaveMinutes: oneOf(s.autosaveMinutes, [1, 5] as const, d.autosaveMinutes),
    shortcuts: shortcuts(s.shortcuts),
  };
}

let current: AppSettings = sanitizeSettings(readJson<unknown>(KEY, {}));
const listeners = new Set<() => void>();

export function getSettings(): AppSettings {
  return current;
}

export function updateSettings(patch: Partial<AppSettings>): void {
  current = sanitizeSettings({ ...current, ...patch });
  writeJson(KEY, current);
  for (const listener of listeners) listener();
}

/** Back to the defaults, all of them or only the named ones. */
export function resetSettings(keys?: ReadonlyArray<keyof AppSettings>): void {
  if (!keys) updateSettings(sanitizeSettings({}));
  else updateSettings(Object.fromEntries(keys.map((key) => [key, DEFAULT_SETTINGS[key]])) as Partial<AppSettings>);
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads storage again: another window changed it, or a test did. */
export function reloadSettings(): void {
  current = sanitizeSettings(readJson<unknown>(KEY, {}));
  for (const listener of listeners) listener();
}

// The ring and the quick windows are other windows of the same app: a change
// made in Settings reaches them as a storage event.
globalThis.addEventListener?.('storage', (event: StorageEvent) => {
  if (event.key === KEY || event.key === null) reloadSettings();
});

export function useSettings(): AppSettings {
  return useSyncExternalStore(subscribeSettings, getSettings, getSettings);
}
