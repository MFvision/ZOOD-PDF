import { readJson, writeJson } from '../state/preferences';
import { PROVIDERS } from './config';
import type { ProviderId } from './config';
import type { Account } from './drive';

/**
 * What the app remembers of the cloud on this device, besides tokens: who is
 * signed in to each drive (to say so on the home screen without asking the
 * drive) and the cloud files opened lately. No bytes, no tokens — those live
 * in memory, in the system keychain (desktop), or, only when the person
 * chose to stay signed in, in this browser's storage (`keptSession`).
 */

const ACCOUNTS_KEY = 'warraq.cloud.accounts';
const RECENT_KEY = 'warraq.cloud.recent';
const THUMBS_KEY = 'warraq.cloud.recentThumbs';
const SESSION_KEY = (provider: ProviderId) => `warraq.cloud.session.${provider}`;
export const CLOUD_RECENT_LIMIT = 8;

const isProvider = (value: unknown): value is ProviderId => PROVIDERS.includes(value as ProviderId);
const text = (value: unknown, max = 400): value is string => typeof value === 'string' && value.length <= max;

/** OneDrive's kind of account (personal, or work or school) is kept too, so "Signed in as" still says it after a restart. */
function withKind(account: Account, kind: unknown): Account {
  return kind === 'personal' || kind === 'business' ? { ...account, kind } : account;
}

export function readAccounts(): Partial<Record<ProviderId, Account>> {
  const raw = readJson<unknown>(ACCOUNTS_KEY, {});
  const accounts: Partial<Record<ProviderId, Account>> = {};
  if (!raw || typeof raw !== 'object') return accounts;
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    const account = value as Partial<Account> | null;
    if (isProvider(provider) && account && text(account.name) && text(account.email)) {
      accounts[provider] = withKind({ name: account.name, email: account.email }, account.kind);
    }
  }
  return accounts;
}

export function keepAccount(provider: ProviderId, account: Account | null): void {
  const accounts = readAccounts();
  if (account) accounts[provider] = withKind({ name: account.name, email: account.email }, account.kind);
  else delete accounts[provider];
  writeJson(ACCOUNTS_KEY, accounts);
}

/** A cloud file opened lately: which drive, its item, its name. */
export interface CloudRecent {
  provider: ProviderId;
  key: string;
  name: string;
  /** Milliseconds since the epoch. */
  openedAt: number;
}

export function readCloudRecent(): CloudRecent[] {
  const raw = readJson<unknown>(RECENT_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is CloudRecent => {
      const e = entry as Partial<CloudRecent> | null;
      return Boolean(e) && isProvider(e?.provider) && text(e?.key, 1000) && text(e?.name) && typeof e?.openedAt === 'number';
    })
    .slice(0, CLOUD_RECENT_LIMIT);
}

export const recentId = (entry: Pick<CloudRecent, 'provider' | 'key'>) => `${entry.provider}:${entry.key}`;

export function addCloudRecent(entry: CloudRecent): CloudRecent[] {
  const next = [entry, ...readCloudRecent().filter((e) => recentId(e) !== recentId(entry))].slice(0, CLOUD_RECENT_LIMIT);
  writeJson(RECENT_KEY, next);
  return next;
}

/** Forgets one drive's recent files (on signing out of it), or all of them. */
export function clearCloudRecent(provider?: ProviderId): CloudRecent[] {
  const next = provider ? readCloudRecent().filter((e) => e.provider !== provider) : [];
  writeJson(RECENT_KEY, next);
  const keep = new Set(next.map(recentId));
  writeJson(
    THUMBS_KEY,
    Object.fromEntries(Object.entries(readCloudThumbnails()).filter(([id]) => keep.has(id))),
  );
  return next;
}

const isThumbnail = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('data:image/jpeg;base64,') && value.length < 200_000;

export function readCloudThumbnails(): Record<string, string> {
  const stored = readJson<unknown>(THUMBS_KEY, {});
  if (!stored || typeof stored !== 'object') return {};
  const ids = new Set(readCloudRecent().map(recentId));
  return Object.fromEntries(
    Object.entries(stored as Record<string, unknown>).filter(
      (entry): entry is [string, string] => ids.has(entry[0]) && isThumbnail(entry[1]),
    ),
  );
}

export function saveCloudThumbnail(id: string, dataUrl: string): void {
  if (isThumbnail(dataUrl)) writeJson(THUMBS_KEY, { ...readCloudThumbnails(), [id]: dataUrl });
}

/**
 * A refresh token kept in this browser because the person chose to stay
 * signed in. Microsoft ends a browser app's refresh tokens 24 hours after
 * the sign-in, whatever is refreshed in between, so one older than that is
 * not kept.
 */
export interface KeptSession {
  refreshToken: string;
  /** When the person signed in, in milliseconds since the epoch. */
  signedInAt: number;
}

export const BROWSER_SESSION_MS = 24 * 60 * 60 * 1000;

export function readKeptSession(provider: ProviderId, now = Date.now()): KeptSession | null {
  const raw = readJson<unknown>(SESSION_KEY(provider), null) as Partial<KeptSession> | null;
  if (!raw || !text(raw.refreshToken, 20_000) || typeof raw.signedInAt !== 'number') return null;
  if (now - raw.signedInAt >= BROWSER_SESSION_MS || raw.signedInAt > now + 60_000) {
    writeKeptSession(provider, null);
    return null;
  }
  return { refreshToken: raw.refreshToken, signedInAt: raw.signedInAt };
}

export function writeKeptSession(provider: ProviderId, session: KeptSession | null): void {
  if (session) writeJson(SESSION_KEY(provider), session);
  else {
    try {
      globalThis.localStorage?.removeItem(SESSION_KEY(provider));
    } catch {
      /* storage unavailable: nothing was kept */
    }
  }
}
