import { invokeHost, isTauriHost } from '../core/host-tauri';
import { DEVICE_MODELS, deviceModel } from '../ai/device/models';
import type { DeviceModel } from '../ai/device/models';
import { toAccelerator } from '../shell/menuModel';
import { readJson, writeJson } from '../state/preferences';

/**
 * Ask ZOOD's choices: on or off, its keys, the model that decides — one
 * that also reads the screen, or the lighter text model the AI tool uses —
 * whether that model is shown the screen, and the tap key (twice drafts a
 * reply, once opens typing). The host keeps what it needs to listen for
 * the keys (`src-tauri/src/ask/`); the rest is kept here.
 */

export interface AskPreferences {
  enabled: boolean;
  /** The model that decides; null for the one this machine's memory calls for. */
  brain: string | null;
  /** A model that reads pictures is shown the screen. */
  screen: boolean;
  /** The keys to hold, as the settings write them (`Mod+Shift+Space`). */
  shortcut: string;
  /** The tap key is watched: twice drafts a reply where the cursor is. */
  taps: boolean;
  tapKey: TapKey;
  /** One tap opens a box to type a request in. */
  tapToType: boolean;
}

/** Right Ctrl (right Command on a Mac), right Alt (Option), right Shift. */
export const TAP_KEYS = ['right-main', 'right-alt', 'right-shift'] as const;
export type TapKey = (typeof TAP_KEYS)[number];

const KEY = 'warraq.ask';
export const DEFAULT_SHORTCUT = 'Mod+Shift+Space';

export function readAskPreferences(): AskPreferences {
  const raw = readJson<Partial<AskPreferences>>(KEY, {});
  const brain =
    typeof raw.brain === 'string' && brainChoices().some((model) => model.id === raw.brain)
      ? raw.brain
      : null;
  const shortcut =
    typeof raw.shortcut === 'string' && raw.shortcut.length > 0 && raw.shortcut.length < 60
      ? raw.shortcut
      : DEFAULT_SHORTCUT;
  const tapKey = TAP_KEYS.includes(raw.tapKey as TapKey) ? (raw.tapKey as TapKey) : 'right-main';
  return {
    enabled: raw.enabled !== false,
    brain,
    screen: raw.screen !== false,
    shortcut,
    taps: raw.taps !== false,
    tapKey,
    tapToType: raw.tapToType !== false,
  };
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
  return [
    ...DEVICE_MODELS.filter((model) => model.sees && !model.hears),
    ...DEVICE_MODELS.filter((model) => !model.sees && !model.hears),
  ];
}

/** Ask ZOOD is in this build: the desktop, on Windows or a Mac. Typing and the taps need only the model that decides. */
export function askAvailable(): boolean {
  if (!isTauriHost()) return false;
  const platform = (
    globalThis.navigator?.platform ||
    globalThis.navigator?.userAgent ||
    ''
  ).toLowerCase();
  return platform.includes('win') || platform.includes('mac');
}

/** Speaking to Ask ZOOD is in this build: a model that hears is in the catalogue. */
export function voiceAvailable(): boolean {
  return askAvailable() && earModels().length > 0;
}

/** The tap key's name on this computer, as the settings and the tour say it. */
export function tapKeyLabel(key: TapKey, mac: boolean, lang: 'ar' | 'en'): string {
  const names: Record<TapKey, [string, string, string, string]> = {
    // Windows en, Mac en, Windows ar, Mac ar.
    'right-main': ['Right Ctrl', 'Right Command ⌘', 'Ctrl الأيمن', 'Command ⌘ الأيمن'],
    'right-alt': ['Right Alt', 'Right Option ⌥', 'Alt الأيمن', 'Option ⌥ الأيمن'],
    'right-shift': ['Right Shift', 'Right Shift ⇧', 'Shift الأيمن', 'Shift ⇧ الأيمن'],
  };
  const [winEn, macEn, winAr, macAr] = names[key];
  return lang === 'ar' ? (mac ? macAr : winAr) : mac ? macEn : winEn;
}

export function onMac(): boolean {
  return (globalThis.navigator?.platform || globalThis.navigator?.userAgent || '')
    .toLowerCase()
    .includes('mac');
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
  return (
    (prefs.brain && DEVICE_MODELS.find((model) => model.id === prefs.brain)) ||
    defaultBrainFor(memoryGiB)
  );
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
  taps: boolean;
  tapKey: string;
  tapToType: boolean;
}

export async function hostAskSettings(): Promise<HostAskSettings | null> {
  try {
    return (await invokeHost('ask_settings')) as HostAskSettings;
  } catch {
    return null;
  }
}

/** What a Mac allows ZOOD PDF (src/ask/access.rs); on Windows nothing applies. */
export interface AskAccess {
  applies: boolean;
  accessibility: boolean;
  screen: boolean;
}

export async function askAccess(): Promise<AskAccess | null> {
  try {
    return (await invokeHost('ask_access')) as AskAccess;
  } catch {
    return null;
  }
}

/** Asks the system for one permission and opens its list in System Settings. */
export async function askAllow(kind: 'accessibility' | 'screen' | 'microphone'): Promise<void> {
  try {
    await invokeHost('ask_allow', { kind });
  } catch {
    // Not a desktop host: nothing to allow.
  }
}

export interface AskReadiness {
  /** Holding the keys to speak works: both models are here. */
  voice: boolean;
  /** The tap key works: the model that decides is here. */
  taps: boolean;
}

/** What answers now, from the downloads and the choices: the host is told nothing. */
export async function askReadiness(
  prefs: AskPreferences,
  memoryGiB: number | null,
): Promise<AskReadiness> {
  const ear = earModels()[0];
  const brainReady = prefs.enabled && (await modelReady(chosenBrain(prefs, memoryGiB)));
  const voice = brainReady && ear !== undefined && (await modelReady(ear));
  return { voice, taps: brainReady && prefs.taps };
}

/**
 * Tells the host what to listen for — the keys to hold only when both
 * models are here, the tap key once the model that decides is — so neither
 * ever opens an island that cannot answer.
 */
export async function configureAsk(
  prefs: AskPreferences,
  memoryGiB: number | null,
): Promise<AskReadiness> {
  const brain = chosenBrain(prefs, memoryGiB);
  const { voice, taps } = await askReadiness(prefs, memoryGiB);
  await invokeHost('ask_configure', {
    enabled: voice,
    shortcut: toAccelerator(prefs.shortcut),
    sees: Boolean(brain.sees && prefs.screen),
    taps: { on: taps, key: prefs.tapKey, toType: prefs.tapToType },
  });
  return { voice, taps };
}
