import { invokeHost, isTauriHost } from '../core/host-tauri';
import { DEVICE_MODELS, deviceModel } from '../ai/device/models';
import type { DeviceModel } from '../ai/device/models';
import { toAccelerator } from '../shell/menuModel';
import { readJson, writeJson } from '../state/preferences';

/**
 * Ask ZOOD's choices: on or off, its keys, the model that decides — one
 * that also reads the screen, or the lighter text model the AI tool uses —
 * whether that model is shown the screen, the tap key (once listens — or
 * opens typing — twice drafts a reply), the glow while it listens, when it
 * talks back, and whether it may click inside ZOOD PDF. The host keeps what it needs to listen for
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
  /** What one tap does: listen until tapped again, open a box to type in, or nothing. */
  oneTap: OneTap;
  /** The edges of the screen glow while Ask ZOOD listens. */
  glow: boolean;
  /** When the answer is said aloud: after a spoken question, always, or never. */
  talkBack: TalkBack;
  /** Inside ZOOD PDF, Ask ZOOD may click the steps itself; elsewhere it only points. */
  doForMe: boolean;
  /** "Search the internet for…" looks it up on the web: only the search and the pages' addresses leave the computer. */
  web: boolean;
  /** The person's own words — names, companies, products — the ear is told and put right to. */
  words: string[];
  /** The microphone Ask ZOOD listens on, by the host's id; null for the system's own. */
  microphone: string | null;
}

export const TALK_BACKS = ['spoken', 'always', 'never'] as const;
export type TalkBack = (typeof TALK_BACKS)[number];

/** `speak` falls back to `type` until a model that hears is downloaded. */
export const ONE_TAPS = ['speak', 'type', 'off'] as const;
export type OneTap = (typeof ONE_TAPS)[number];

/** Right Ctrl (right Command on a Mac), right Alt (Option), right Shift. */
export const TAP_KEYS = ['right-main', 'right-alt', 'right-shift'] as const;
export type TapKey = (typeof TAP_KEYS)[number];

const KEY = 'warraq.ask';
/** As many of the person's words as the host tells the model (`ask/words.rs`). */
export const MAX_WORDS = 200;
const MAX_WORD_LENGTH = 60;

/** A microphone on this computer, as the host lists it (`ask/ear.rs`). */
export interface Microphone {
  id: string;
  name: string;
}

/** The microphones to choose from; none outside the desktop or when they cannot be read. */
export async function microphones(): Promise<Microphone[]> {
  try {
    const found = (await invokeHost('ask_microphones')) as Microphone[];
    return Array.isArray(found) ? found : [];
  } catch {
    return [];
  }
}

/** The person's words from what they typed: one a line (or between commas), each once. */
export function parseWords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of text.split(/[\n,،]/)) {
    const word = piece.trim();
    if (!word || word.length > MAX_WORD_LENGTH || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    out.push(word);
    if (out.length === MAX_WORDS) break;
  }
  return out;
}
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
  // Before one tap could listen it only typed, or did nothing when switched off.
  const legacy = raw as { tapToType?: unknown };
  const oneTap = ONE_TAPS.includes(raw.oneTap as OneTap)
    ? (raw.oneTap as OneTap)
    : legacy.tapToType === false
      ? 'off'
      : 'speak';
  return {
    enabled: raw.enabled !== false,
    brain,
    screen: raw.screen !== false,
    shortcut,
    taps: raw.taps !== false,
    tapKey,
    oneTap,
    glow: raw.glow !== false,
    talkBack: TALK_BACKS.includes(raw.talkBack as TalkBack) ? (raw.talkBack as TalkBack) : 'spoken',
    doForMe: raw.doForMe !== false,
    web: raw.web !== false,
    words: Array.isArray(raw.words)
      ? parseWords(raw.words.filter((word) => typeof word === 'string').join('\n'))
      : [],
    microphone:
      typeof raw.microphone === 'string' && raw.microphone.length > 0 && raw.microphone.length <= 512
        ? raw.microphone
        : null,
  };
}

export function writeAskPreferences(next: AskPreferences): void {
  writeJson(KEY, next);
}

/** The models that hear: Ask ZOOD's ear. */
export function earModels(): DeviceModel[] {
  return DEVICE_MODELS.filter((model) => model.hears);
}

/**
 * The ear for this machine: the larger one (four times fewer Arabic
 * mistakes) on a computer with the memory it asks for, the small one below
 * that or when the memory is not known.
 */
export function earFor(memoryGiB: number | null): DeviceModel | undefined {
  const ears = [...earModels()].sort((a, b) => b.bytes - a.bytes);
  return (
    ears.find((model) => memoryGiB !== null && memoryGiB + 0.5 >= model.ramGiB) ?? ears.at(-1)
  );
}

/**
 * The ear that listens now: this machine's own once downloaded, otherwise
 * one downloaded before it, so speaking keeps working while the better ear
 * comes down.
 */
export async function readyEar(memoryGiB: number | null): Promise<DeviceModel | undefined> {
  const best = earFor(memoryGiB);
  const others = earModels()
    .filter((model) => model !== best)
    .sort((a, b) => b.bytes - a.bytes);
  for (const model of best ? [best, ...others] : others) if (await modelReady(model)) return model;
  return undefined;
}

/** The models that can decide, the one that sees first. */
export function brainChoices(): DeviceModel[] {
  return [
    ...DEVICE_MODELS.filter((model) => model.sees && !model.hears),
    ...DEVICE_MODELS.filter((model) => !model.sees && !model.hears && !model.decides),
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

/**
 * Whether this computer has the memory a model needs. Unknown memory counts
 * as enough: the host checks again before it loads anything (`ai::fits_memory`).
 */
export function fitsMemory(model: DeviceModel, memoryGiB: number | null): boolean {
  return memoryGiB === null || memoryGiB + 0.5 >= model.ramGiB;
}

/**
 * The model Ask ZOOD thinks with: the one chosen in Settings, unless this
 * computer is too small for it. The 4B model chosen on an 8 GB Mac took so
 * much memory that the whole Mac froze (2026-10-31), so a choice too big
 * for the machine is set aside for the one its memory calls for.
 */
export function chosenBrain(prefs: AskPreferences, memoryGiB: number | null): DeviceModel {
  const chosen = prefs.brain ? DEVICE_MODELS.find((model) => model.id === prefs.brain) : undefined;
  return chosen && fitsMemory(chosen, memoryGiB) ? chosen : defaultBrainFor(memoryGiB);
}

/**
 * The model that writes what is read or heard — a reply, a summary, advice,
 * an answer said aloud: the biggest one downloaded that this computer can
 * run, when it is bigger than the everyday one, so words never come from a
 * small model while a better one is there. The everyday model still decides
 * the quick things; with nothing bigger downloaded it writes too.
 */
export async function writerFor(brain: DeviceModel, memoryGiB: number | null): Promise<DeviceModel> {
  const bigger = DEVICE_MODELS.filter(
    (model) =>
      !model.hears &&
      !model.decides &&
      model.bytes > brain.bytes &&
      memoryGiB !== null &&
      memoryGiB + 0.5 >= model.ramGiB,
  ).sort((a, b) => b.bytes - a.bytes);
  for (const model of bigger) if (await modelReady(model)) return model;
  return brain;
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
  tapSpeaks: boolean;
  glow: boolean;
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
  /** `ask` until the system has asked; on Windows, `denied` when a Privacy switch is off. */
  microphone: 'allowed' | 'denied' | 'ask';
  /** Input Monitoring on a Mac: keys pressed with the tap key are seen, so ⌘C is not a tap. */
  input: boolean;
}

export async function askAccess(): Promise<AskAccess | null> {
  try {
    return (await invokeHost('ask_access')) as AskAccess;
  } catch {
    return null;
  }
}

/** Asks the system for one permission and opens its list in System Settings. */
export type AskPermission = 'microphone' | 'input' | 'accessibility' | 'screen';

export async function askAllow(kind: AskPermission): Promise<void> {
  try {
    await invokeHost('ask_allow', { kind });
  } catch {
    // Not a desktop host: nothing to allow.
  }
}

export interface AskReadiness {
  /** Speaking works, by one tap or the keys held: both models are here. */
  voice: boolean;
  /** The tap key works: the model that decides is here. */
  taps: boolean;
}

/** What one tap does now: listening needs the model that hears, else it types. */
export function oneTapDoes(prefs: AskPreferences, ready: AskReadiness): 'speak' | 'type' | null {
  if (!ready.taps || prefs.oneTap === 'off') return null;
  return prefs.oneTap === 'speak' && ready.voice ? 'speak' : 'type';
}

/**
 * The permissions still missing for what Ask ZOOD is set to do, in the
 * order the setup asks for them. An older host that cannot say asks none.
 */
export function missingAccess(
  access: AskAccess | null,
  prefs: AskPreferences,
  sees: boolean,
): AskPermission[] {
  if (!access) return [];
  const missing: AskPermission[] = [];
  if (voiceAvailable() && access.microphone !== 'allowed') missing.push('microphone');
  if (!access.applies) return missing;
  if (prefs.taps && !access.input) missing.push('input');
  if (!access.accessibility) missing.push('accessibility');
  if (sees && prefs.screen && !access.screen) missing.push('screen');
  return missing;
}

/** What answers now, from the downloads and the choices: the host is told nothing. */
export async function askReadiness(
  prefs: AskPreferences,
  memoryGiB: number | null,
): Promise<AskReadiness> {
  const brainReady = prefs.enabled && (await modelReady(chosenBrain(prefs, memoryGiB)));
  const voice = brainReady && (await readyEar(memoryGiB)) !== undefined;
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
    taps: {
      on: taps,
      key: prefs.tapKey,
      toType: prefs.oneTap !== 'off',
      speak: prefs.oneTap === 'speak',
    },
    glow: prefs.glow,
    microphone: prefs.microphone,
  });
  return { voice, taps };
}
