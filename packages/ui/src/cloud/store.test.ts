import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keepAccount, readAccounts } from './store';

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

describe('the accounts remembered on this device', () => {
  it('keep OneDrive’s kind of account, so "Signed in as" still says it after a restart', () => {
    keepAccount('onedrive', { name: 'Mohammed', email: 'm@zood.sa', kind: 'business' });
    keepAccount('gdrive', { name: 'Sara', email: 'sara@example.org' });
    expect(readAccounts()).toEqual({
      onedrive: { name: 'Mohammed', email: 'm@zood.sa', kind: 'business' },
      gdrive: { name: 'Sara', email: 'sara@example.org' },
    });
  });

  it('drop a kind that is not one of the two', () => {
    globalThis.localStorage.setItem('warraq.cloud.accounts', JSON.stringify({ onedrive: { name: 'M', email: 'm@zood.sa', kind: 'other' } }));
    expect(readAccounts().onedrive).toEqual({ name: 'M', email: 'm@zood.sa' });
  });
});
