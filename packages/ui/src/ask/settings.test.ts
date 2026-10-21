import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_MODELS } from '../ai/device/models';
import { brainChoices, chosenBrain, DEFAULT_SHORTCUT, defaultBrainFor, earModels, readAskPreferences, writeAskPreferences } from './settings';

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
    expect(readAskPreferences()).toEqual({ enabled: true, brain: null, screen: true, shortcut: DEFAULT_SHORTCUT });
  });

  it('keeps a choice, and forgets a model the catalogue no longer has', () => {
    writeAskPreferences({ enabled: false, brain: 'qwen2.5-0.5b', screen: false, shortcut: 'Mod+Alt+K' });
    expect(readAskPreferences()).toEqual({ enabled: false, brain: 'qwen2.5-0.5b', screen: false, shortcut: 'Mod+Alt+K' });
    writeAskPreferences({ enabled: true, brain: 'gone-model', screen: true, shortcut: '' });
    expect(readAskPreferences()).toMatchObject({ brain: null, shortcut: DEFAULT_SHORTCUT });
  });

  it('decides with a model that sees where the memory allows, the lighter ones otherwise', () => {
    const seeing = DEVICE_MODELS.find((model) => model.sees && !model.hears);
    if (seeing) expect(defaultBrainFor(seeing.ramGiB).id).toBe(seeing.id);
    expect(defaultBrainFor(8).sees ?? false).toBe(seeing ? seeing.ramGiB <= 8.5 : false);
    expect(defaultBrainFor(4).id).toBe('qwen2.5-0.5b');
    expect(chosenBrain({ enabled: true, brain: 'qwen2.5-0.5b', screen: true, shortcut: DEFAULT_SHORTCUT }, 64).id).toBe('qwen2.5-0.5b');
  });

  it('never offers a model that only hears as the one that decides', () => {
    const ears = new Set(earModels().map((model) => model.id));
    expect(brainChoices().some((model) => ears.has(model.id))).toBe(false);
    expect(brainChoices().map((model) => model.id)).toContain('qwen2.5-1.5b');
  });
});
