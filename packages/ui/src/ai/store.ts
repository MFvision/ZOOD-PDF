import { readJson, writeJson } from '../state/preferences';
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL, LOCAL_DEFAULT_MODEL, LOCAL_DEFAULT_URL } from './providers';
import type { LocalApi, ProviderId } from './providers';

/**
 * The Anthropic key. By default it lives in this module's memory only — it
 * outlasts switching tools, not closing the page. Only when the person ticks
 * "Remember this key on this device" is it written to `localStorage`, where
 * anyone with this browser profile can read it; the panel says so. It is
 * never logged, never put in a URL, and sent to Anthropic alone.
 */
const KEY_STORAGE = 'warraq.ai.anthropicKey';
let sessionKey = '';

function storage(): Storage | undefined {
  // Reading `localStorage` itself can throw (blocked storage, sandboxed frames).
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberedKey(): string | null {
  try {
    return storage()?.getItem(KEY_STORAGE) ?? null;
  } catch {
    return null;
  }
}

/** The key to start with, and whether it is the one remembered on this device. */
export function loadKey(): { key: string; remembered: boolean } {
  const remembered = rememberedKey();
  return { key: sessionKey || remembered || '', remembered: remembered !== null };
}

/**
 * Keeps `key` for this session and, if `remember`, on this device; otherwise
 * removes any copy on the device. False when the device would not store it.
 */
export function keepKey(key: string, remember: boolean): boolean {
  sessionKey = key;
  try {
    if (remember && key.length > 0) storage()?.setItem(KEY_STORAGE, key);
    else storage()?.removeItem(KEY_STORAGE);
    return !remember || key.length === 0 || storage()?.getItem(KEY_STORAGE) === key;
  } catch {
    return false;
  }
}

/** Forgets the key everywhere Warraq kept it. */
export function forgetKey(): void {
  sessionKey = '';
  try {
    storage()?.removeItem(KEY_STORAGE);
  } catch {
    /* nothing was stored, or storage is unavailable */
  }
}

/** The panel's choices, which are not secret and are remembered like the other preferences. */
export interface AiSettings {
  provider: ProviderId;
  claudeModel: string;
  localUrl: string;
  localApi: LocalApi;
  localModel: string;
}

const SETTINGS_STORAGE = 'warraq.ai.settings';

export const DEFAULT_SETTINGS: AiSettings = {
  provider: 'claude',
  claudeModel: DEFAULT_CLAUDE_MODEL,
  localUrl: LOCAL_DEFAULT_URL,
  localApi: 'ollama',
  localModel: LOCAL_DEFAULT_MODEL,
};

const text = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : fallback;

/** Stored settings, each one checked, so a corrupted entry can never break the panel. */
export function sanitizeSettings(raw: unknown): AiSettings {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    provider: stored.provider === 'local' ? 'local' : 'claude',
    claudeModel: (CLAUDE_MODELS as readonly unknown[]).includes(stored.claudeModel)
      ? (stored.claudeModel as string)
      : DEFAULT_SETTINGS.claudeModel,
    localUrl: text(stored.localUrl, DEFAULT_SETTINGS.localUrl),
    localApi: stored.localApi === 'openai' ? 'openai' : 'ollama',
    localModel: text(stored.localModel, DEFAULT_SETTINGS.localModel),
  };
}

export function readSettings(): AiSettings {
  return sanitizeSettings(readJson<unknown>(SETTINGS_STORAGE, {}));
}

export function writeSettings(settings: AiSettings): void {
  writeJson(SETTINGS_STORAGE, settings);
}
