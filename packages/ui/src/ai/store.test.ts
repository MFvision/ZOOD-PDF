import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, forgetKey, keepKey, loadKey, sanitizeSettings } from './store';

const KEY = 'sk-ant-api03-not-a-real-key-0123456789';
const STORED = 'warraq.ai.anthropicKey';

/** A `localStorage` for the node test environment; `broken` throws the way a blocked one does. */
function installStorage(broken = false): Map<string, string> {
  const items = new Map<string, string>();
  const fail = () => {
    throw new Error('SecurityError');
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (name: string) => (broken ? fail() : (items.get(name) ?? null)),
      setItem: (name: string, value: string) => (broken ? fail() : void items.set(name, value)),
      removeItem: (name: string) => (broken ? fail() : void items.delete(name)),
    },
  });
  return items;
}

describe('the API key', () => {
  let items: Map<string, string>;
  beforeEach(() => {
    items = installStorage();
    forgetKey();
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('is kept in memory only, unless the person asks for more', () => {
    expect(keepKey(KEY, false)).toBe(true);
    expect(loadKey()).toEqual({ key: KEY, remembered: false });
    expect(items.size).toBe(0);
  });

  it('is written to this device only when "Remember" is ticked, and removed when it is not', () => {
    expect(keepKey(KEY, true)).toBe(true);
    expect(items.get(STORED)).toBe(KEY);
    expect(loadKey()).toEqual({ key: KEY, remembered: true });
    keepKey(KEY, false);
    expect(items.has(STORED)).toBe(false);
    expect(loadKey()).toEqual({ key: KEY, remembered: false });
  });

  it('comes back from the device in a new session when it was remembered', () => {
    items.set(STORED, KEY);
    expect(loadKey()).toEqual({ key: KEY, remembered: true });
  });

  it('is forgotten everywhere by "Forget the key"', () => {
    keepKey(KEY, true);
    forgetKey();
    expect(items.size).toBe(0);
    expect(loadKey()).toEqual({ key: '', remembered: false });
  });

  it('survives storage that throws: kept in memory, and the panel is told it was not stored', () => {
    installStorage(true);
    expect(keepKey(KEY, true)).toBe(false);
    expect(loadKey()).toEqual({ key: KEY, remembered: false });
    expect(() => forgetKey()).not.toThrow();
  });

  it('is not stored where there is no storage at all', () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    expect(keepKey(KEY, true)).toBe(false);
    expect(keepKey(KEY, false)).toBe(true);
  });
});

describe('the panel settings', () => {
  it('come back checked, so a corrupted entry cannot break the panel', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(
      sanitizeSettings({ provider: 'openai', claudeModel: 'gpt-9', localApi: 'grpc', localUrl: 7 }),
    ).toEqual(DEFAULT_SETTINGS);
    const chosen = {
      provider: 'local',
      claudeModel: 'claude-opus-5',
      localUrl: 'http://127.0.0.1:11434',
      localApi: 'openai',
      localModel: 'qwen2.5:7b',
      deviceModel: 'qwen2.5-0.5b',
    };
    expect(sanitizeSettings(chosen)).toEqual(chosen);
    // The on-device model is the default provider, and a model this build does not know is not kept.
    expect(DEFAULT_SETTINGS.provider).toBe('device');
    expect(sanitizeSettings({ provider: 'device', deviceModel: 'gpt-4' }).deviceModel).toBeNull();
  });

  it('never include the key', () => {
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual([
      'claudeModel',
      'deviceModel',
      'localApi',
      'localModel',
      'localUrl',
      'provider',
    ]);
  });
});
