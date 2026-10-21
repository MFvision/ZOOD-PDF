import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_MODELS } from '../ai/device/models';
import {
  brainChoices,
  chosenBrain,
  DEFAULT_SHORTCUT,
  defaultBrainFor,
  earModels,
  readAskPreferences,
  tapKeyLabel,
  writeAskPreferences,
} from './settings';

const TAPS = { taps: true, tapKey: 'right-main', tapToType: true } as const;

/** A `localStorage` for the node test environment. */
beforeEach(() => {
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (name: string) => items.get(name) ?? null,
      setItem: (name: string, value: string) => void items.set(name, value),
      removeItem: (name: string) => void items.delete(name),
    },
  });
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('Ask ZOOD settings', () => {
  it('starts on, with its default keys, the screen allowed and the model chosen by memory', () => {
    expect(readAskPreferences()).toEqual({
      enabled: true,
      brain: null,
      screen: true,
      shortcut: DEFAULT_SHORTCUT,
      ...TAPS,
    });
  });

  it('keeps a choice, and forgets a model the catalogue no longer has', () => {
    const mine = {
      enabled: false,
      brain: 'qwen2.5-0.5b',
      screen: false,
      shortcut: 'Mod+Alt+K',
      taps: false,
      tapKey: 'right-alt',
      tapToType: false,
    } as const;
    writeAskPreferences(mine);
    expect(readAskPreferences()).toEqual(mine);
    writeAskPreferences({
      ...mine,
      enabled: true,
      brain: 'gone-model',
      shortcut: '',
      tapKey: 'caps' as never,
    });
    expect(readAskPreferences()).toMatchObject({
      brain: null,
      shortcut: DEFAULT_SHORTCUT,
      tapKey: 'right-main',
    });
  });

  it('decides with a model that sees where the memory allows, the lighter ones otherwise', () => {
    const seeing = DEVICE_MODELS.find((model) => model.sees && !model.hears);
    if (seeing) expect(defaultBrainFor(seeing.ramGiB).id).toBe(seeing.id);
    expect(defaultBrainFor(8).sees ?? false).toBe(seeing ? seeing.ramGiB <= 8.5 : false);
    expect(defaultBrainFor(4).id).toBe('qwen2.5-0.5b');
    expect(
      chosenBrain(
        { enabled: true, brain: 'qwen2.5-0.5b', screen: true, shortcut: DEFAULT_SHORTCUT, ...TAPS },
        64,
      ).id,
    ).toBe('qwen2.5-0.5b');
  });

  it('never offers a model that only hears as the one that decides', () => {
    const ears = new Set(earModels().map((model) => model.id));
    expect(brainChoices().some((model) => ears.has(model.id))).toBe(false);
    expect(brainChoices().map((model) => model.id)).toContain('qwen2.5-1.5b');
  });

  it('names the tap key as each computer has it', () => {
    expect(tapKeyLabel('right-main', false, 'en')).toBe('Right Ctrl');
    expect(tapKeyLabel('right-main', true, 'en')).toBe('Right Command ⌘');
    expect(tapKeyLabel('right-alt', false, 'ar')).toBe('Alt الأيمن');
  });
});
