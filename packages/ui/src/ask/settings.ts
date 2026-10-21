import { invokeHost, isTauriHost } from '../core/host-tauri';
import { DEVICE_MODELS, deviceModel } from '../ai/device/models';
import type { DeviceModel } from '../ai/device/models';
import { toAccelerator } from '../shell/menuModel';
import { readJson, writeJson } from '../state/preferences';

/**
 * Ask ZOOD's choices: on or off, its keys, the model that decides — one
 * that also reads the screen, or the lighter text model the AI tool uses —
 * and whether that model is shown the screen. The host keeps what it needs
 * to listen for the keys (`src-tauri/src/ask/`); the rest is kept here.
 */

export interface AskPreferences {
  enabled: boolean;
  /** The model that decides; null for the one this machine's memory calls for. */
  brain: string | null;
  /** A model that reads pictures is shown the screen. */
  screen: boolean;
  /** The keys to hold, as the settings write them (`Mod+Shift+Space`). */
  shortcut: string;
}

const KEY = 'warraq.ask';
export const DEFAULT_SHORTCUT = 'Mod+Shift+Space';

export function readAskPreferences(): AskPreferences {
  const raw = readJson<Partial<AskPreferences>>(KEY, {});
  const brain = typeof raw.brain === 'string' && brainChoices().some((model) => model.id === raw.brain) ? raw.brain : null;
  const shortcut = typeof raw.shortcut === 'string' && raw.shortcut.length > 0 && raw.shortcut.length < 60 ? raw.shortcut : DEFAULT_SHORTCUT;
  return { enabled: raw.enabled !== false, brain, screen: raw.screen !== false, shortcut };
}

export function writeAskPreferences(next: AskPreferences): void {
  writeJson(KEY, next);
}

/** The models that hear: Ask ZOOD's ear. */
export function earModels(): DeviceModel[] {
  return DEVICE_MODELS.filter((model) => model.hears);
}

/** The models that can decide, the one that sees first. */
export function brainChoices(): DeviceModel[] {
  return [...DEVICE_MODELS.filter((model) => model.sees && !model.hears), ...DEVICE_MODELS.filter((model) => !model.sees && !model.hears)];
}

/** Ask ZOOD is in this build: the desktop, on Windows or a Mac, with a model that hears in the catalogue. */
export function askAvailable(): boolean {
  if (!isTauriHost() || earModels().length === 0) return false;
  const platform = (globalThis.navigator?.platform || globalThis.navigator?.userAgent || '').toLowerCase();
  return platform.includes('win') || platform.includes('mac');
}

/**
 * The model for this machine: one that sees on a computer with the memory
 * its card asks for (most of the company's have 16 GB or more), the larger
 * text model at 8 GB, the small one below that.
 */
export function defaultBrainFor(memoryGiB: number | null): DeviceModel {
  const seeing = DEVICE_MODELS.find((model) => model.sees && !model.hears);
  if (seeing && memoryGiB !== null && memoryGiB + 0.5 >= seeing.ramGiB) return seeing;
  if (memoryGiB !== null && memoryGiB < 7.5) return deviceModel('qwen2.5-0.5b');
  return deviceModel('qwen2.5-1.5b');
}

export function chosenBrain(prefs: AskPreferences, memoryGiB: number | null): DeviceModel {
  return (prefs.brain && DEVICE_MODELS.find((model) => model.id === prefs.brain)) || defaultBrainFor(memoryGiB);
}

/** Whether every file of a model is downloaded and checked. */
export async function modelReady(model: DeviceModel): Promise<boolean> {
  try {
    const status = (await invokeHost('ai_model_status', { id: model.id })) as { state: string };
    return status.state === 'ready';
  } catch {
    return false;
  }
}

export interface HostAskSettings {
  enabled: boolean;
  shortcut: string;
  sees: boolean;
}

export async function hostAskSettings(): Promise<HostAskSettings | null> {
  try {
    return (await invokeHost('ask_settings')) as HostAskSettings;
  } catch {
    return null;
  }
}

/**
 * Tells the host to listen for the keys — only when Ask ZOOD is on and both
 * its models are here, so the keys never open an island that cannot answer.
 */
export async function configureAsk(prefs: AskPreferences, memoryGiB: number | null): Promise<boolean> {
  const brain = chosenBrain(prefs, memoryGiB);
  const ear = earModels()[0];
  const ready = prefs.enabled && ear !== undefined && (await modelReady(ear)) && (await modelReady(brain));
  await invokeHost('ask_configure', { enabled: ready, shortcut: toAccelerator(prefs.shortcut), sees: Boolean(brain.sees && prefs.screen) });
  return ready;
}
