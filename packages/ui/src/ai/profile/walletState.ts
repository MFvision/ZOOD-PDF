import { useEffect, useSyncExternalStore } from 'react';
import { profileStore } from './store';
import { memoryText, readWallet } from './wallet';
import type { Wallet } from './wallet';

/**
 * The Wallet, loaded once and shared: Settings edits it, Fill & sign and the
 * AI read it, and each sees a change the moment it is saved. `null` until it
 * has been read (or when it could not be). The first profile's name, before
 * the person renames it, is the interface's word for "Me".
 */
let current: Wallet | null = null;
let loading: Promise<Wallet> | null = null;
const listeners = new Set<() => void>();

function publish(next: Wallet | null) {
  current = next;
  for (const listener of listeners) listener();
}

export function loadWallet(firstName: string): Promise<Wallet> {
  if (current) return Promise.resolve(current);
  loading ??= profileStore()
    .load()
    .catch(() => null)
    .then((raw) => {
      const wallet = readWallet(raw, firstName);
      publish(wallet);
      return wallet;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Shows `next` everywhere at once (a switch moves when pressed) and saves it encrypted; back as it was if it cannot be. */
export async function saveWallet(next: Wallet): Promise<void> {
  const before = current;
  publish(next);
  try {
    await profileStore().save(next);
  } catch (error) {
    publish(before);
    throw error;
  }
}

/** Takes everything out: every profile, the Memory and what it learnt of labels. */
export async function forgetWallet(firstName: string): Promise<void> {
  await profileStore().clear();
  publish(readWallet(null, firstName));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const read = () => current;

export function useWallet(firstName: string): Wallet | null {
  const wallet = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    void loadWallet(firstName);
  }, [firstName]);
  return wallet;
}

/** At most this many characters of the Memory go with a question. */
const MEMORY_ROOM = 2000;

/** The Memory as the chat gives it to a model, or '' when it may not. */
export async function memoryFor(provider: 'device' | 'local' | 'claude'): Promise<string> {
  // Read without being kept: the chat has no name for a first profile to give.
  const wallet = current ?? readWallet(await profileStore().load().catch(() => null), '');
  if (!wallet || (provider === 'claude' && !wallet.memoryToCloud)) return '';
  const text = memoryText(wallet);
  // The newest notes first, within room a small model can spare.
  return text.length <= MEMORY_ROOM ? text : text.slice(text.length - MEMORY_ROOM).replace(/^[^\n]*\n/, '');
}
