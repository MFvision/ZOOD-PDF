import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { firstPagePicture } from '../home/recentPicture';
import type { TKey } from '../i18n/messages';
import { useT } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import type { SaveTarget } from '../state/AppContext';
import type { BrowserBroker } from './brokers';
import { builtConfig } from './config';
import type { ProviderId } from './config';
import type { Account, Entry, Saved } from './drive';
import { kindOf } from './errors';
import type { CloudErrorKind } from './errors';
import { MAX_TABS } from '../state/tabs';
import { PDF_SNIFF_BYTES, looksLikePdf, typeForName } from '../state/pdfFile';
import { pickedIds } from './gdrive';
import { currentHost } from './host';
import { googlePicker, oneDriveAccountHint } from './oauth';
import { CloudService } from './service';
import type { CloudDrive } from './service';
import { openSignInWindow } from './signin';
import {
  addCloudRecent,
  clearCloudRecent,
  keepAccount,
  readAccounts,
  readCloudRecent,
  readCloudThumbnails,
  readKeptSession,
  recentId,
  saveCloudThumbnail,
} from './store';
import type { CloudRecent } from './store';

/**
 * The cloud drives in the interface: who is signed in, the sheet on screen
 * (sign in, browse, a conflict, a taken name), and which drive file the open
 * document is — so that Save writes a new revision of it, checked against
 * the version it was opened at.
 *
 * Nothing here reaches the network by itself: every request follows a click
 * (open, save, sign in, sign out, browse), and what the home screen shows
 * about the drives comes from this device.
 */

/** What to do once signed in. */
export type Next =
  /** The drive's own list: what was chosen or saved before (no Google picker). */
  | { kind: 'browse' }
  /** Nothing more: the Folders view shows the drive itself. */
  | { kind: 'stay' }
  /** Choosing files to open: Google's picker, or OneDrive's list. */
  | { kind: 'open' }
  | { kind: 'saveAs' }
  | { kind: 'recent'; entry: CloudRecent }
  | { kind: 'save' }
  | { kind: 'pickFolder'; name: string };

export type Sheet =
  | { kind: 'signIn'; provider: ProviderId; next: Next }
  | {
      kind: 'browse';
      provider: ProviderId;
      mode: 'open' | 'saveAs';
      /** Save As starts here (a copy of a file beside it); its name when the drive said. */
      folder?: { key: string; name: string | null };
      name?: string;
    }
  | { kind: 'conflict'; provider: ProviderId; name: string }
  | { kind: 'nameTaken'; provider: ProviderId; name: string };

export type Activity = { kind: 'signIn' | 'opening' | 'saving'; provider: ProviderId; name?: string };

/** The drive file the open document is. */
export interface Binding extends Saved {
  provider: ProviderId;
  /** The `File` it was opened as (`services.openedFile`), by identity. */
  file: File;
}

export interface CloudApi {
  /** The drives this build offers on this host; empty: no cloud control anywhere. */
  providers: readonly ProviderId[];
  desktop: boolean;
  accounts: Partial<Record<ProviderId, Account>>;
  recent: CloudRecent[];
  thumbnails: Record<string, string>;
  binding: Binding | null;
  sheet: Sheet | null;
  activity: Activity | null;
  /** What went wrong, said in the sheet on screen. */
  error: CloudErrorKind | null;
  startOpen: (provider: ProviderId) => void;
  /** Signs in and stays where the person is (the Folders view lists the drive itself). */
  startSignIn: (provider: ProviderId) => void;
  startSaveAs: (provider: ProviderId) => void;
  openRecent: (entry: CloudRecent) => void;
  clearRecent: () => void;
  /** In the click: a browser opens its sign-in window before anything else. */
  signIn: (provider: ProviderId, stay: boolean, kind?: 'business' | 'personal') => void;
  /** Google's picker, in the consent screen (desktop): a PDF to open, or a folder to save `name` in. */
  pickWithGoogle: (purpose: 'open' | 'folder', name?: string) => void;
  signOut: (provider: ProviderId) => Promise<void>;
  openEntry: (provider: ProviderId, entry: Pick<Entry, 'key' | 'name'>) => Promise<void>;
  /** Each PDF among `entries` (and in each folder among them) in a tab of its own; other files to Create PDF. */
  openEntries: (provider: ProviderId, entries: readonly Pick<Entry, 'key' | 'name' | 'kind'>[]) => Promise<void>;
  saveInto: (provider: ProviderId, folderKey: string | null, name: string) => Promise<void>;
  resolveConflict: (choice: 'copy' | 'replace' | 'cancel') => void;
  resolveNameTaken: (choice: 'replace' | 'rename' | 'cancel') => void;
  /** The sign-in is over (a drive said so): ask for it again, then carry on with `next`. */
  signInAgain: (provider: ProviderId, next: Next) => void;
  /** Closes the sheet, cancelling a sign-in under way. */
  cancel: () => void;
  drive: (provider: ProviderId) => CloudDrive;
  /** In a browser: whether the sign-in is kept in this browser (the person chose to stay signed in). */
  staying: (provider: ProviderId) => boolean;
}

export const errorKey = (kind: CloudErrorKind): TKey => `cloud.error.${kind}` as TKey;

/** "report.pdf" → "report (copy).pdf", in the interface's language. */
export function copyName(name: string, word: string): string {
  const base = name.replace(/\.pdf$/i, '');
  return `${base} (${word}).pdf`;
}

/** A view of `bytes` as the whole buffer a request body takes. */
function wholeBuffer(bytes: Uint8Array<ArrayBuffer>): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
}

const NO_CLOUD: CloudApi = {
  providers: [],
  desktop: false,
  accounts: {},
  recent: [],
  thumbnails: {},
  binding: null,
  sheet: null,
  activity: null,
  error: null,
  startOpen: () => undefined,
  startSignIn: () => undefined,
  startSaveAs: () => undefined,
  openRecent: () => undefined,
  clearRecent: () => undefined,
  signIn: () => undefined,
  pickWithGoogle: () => undefined,
  signOut: async () => undefined,
  openEntry: async () => undefined,
  openEntries: async () => undefined,
  saveInto: async () => undefined,
  resolveConflict: () => undefined,
  resolveNameTaken: () => undefined,
  signInAgain: () => undefined,
  cancel: () => undefined,
  drive: () => {
    throw new Error('no cloud drive is offered');
  },
  staying: () => false,
};

const CloudContext = createContext<CloudApi>(NO_CLOUD);

export function useCloud(): CloudApi {
  return useContext(CloudContext);
}

export function CloudProvider({ children }: { children: ReactNode }) {
  const service = useMemo(() => {
    const config = builtConfig();
    if (!config.onedrive && !config.gdrive) return null;
    const created = new CloudService(config, currentHost());
    return created.providers.length > 0 ? created : null;
  }, []);
  return service ? <CloudProviderFor service={service}>{children}</CloudProviderFor> : <>{children}</>;
}

/** The accounts this device knows to be signed in: in a browser, only while the kept sign-in lasts. */
function knownAccounts(service: CloudService): Partial<Record<ProviderId, Account>> {
  const kept = readAccounts();
  const known: Partial<Record<ProviderId, Account>> = {};
  for (const provider of service.providers) {
    const account = kept[provider];
    if (account && (service.host.desktop || readKeptSession(provider) !== null)) known[provider] = account;
  }
  return known;
}

function CloudProviderFor({ service, children }: { service: CloudService; children: ReactNode }) {
  const services = useServices();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const t = useT();
  const offered = service.providers;
  const [accounts, setAccounts] = useState(() => knownAccounts(service));
  const [recent, setRecent] = useState(() => readCloudRecent().filter((entry) => offered.includes(entry.provider)));
  const [thumbnails, setThumbnails] = useState(readCloudThumbnails);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  // What each drive is doing: one drive signing in or opening never holds up another.
  const [activities, setActivities] = useState<Partial<Record<ProviderId, Activity>>>({});
  const setActivity = useCallback((provider: ProviderId, next: Activity | null) => {
    setActivities((current) => {
      const kept = { ...current };
      if (next) kept[provider] = next;
      else delete kept[provider];
      return kept;
    });
  }, []);
  // What is said: the drive on screen's, else (no sheet: saving) any.
  const activity = useMemo(
    () => (sheet ? (activities[sheet.provider] ?? null) : (Object.values(activities)[0] ?? null)),
    [sheet, activities],
  );
  const [error, setError] = useState<CloudErrorKind | null>(null);
  // Each drive file open has its own claim on Save, which its tab keeps
  // while another tab shows: the binding is the live tab's claim's file.
  const [claims] = useState(() => new WeakMap<SaveTarget, { current: Binding }>());
  const [claimed, setClaimed] = useState(0);
  const { saveClaim } = services;
  const binding = useMemo(() => {
    void claimed;
    return saveClaim ? (claims.get(saveClaim)?.current ?? null) : null;
  }, [saveClaim, claims, claimed]);
  // Async work reads the latest of these through refs, never a stale closure.
  const sheetRef = useRef<Sheet | null>(null);
  useEffect(() => {
    sheetRef.current = sheet;
  }, [sheet]);
  // Drive files being opened, by the `File` each is opened as: each claims Save once the app has it open.
  const pending = useRef(new WeakMap<File, Binding>());
  const abort = useRef<AbortController | null>(null);
  const signingIn = useRef<ProviderId | null>(null);
  const answer = useRef<((choice: string) => void) | null>(null);

  const drive = useCallback((provider: ProviderId) => service.drive(provider), [service]);

  const rememberAccount = useCallback(
    (provider: ProviderId, account: Account | null, keep: boolean) => {
      setAccounts((current) => {
        const next = { ...current };
        if (account) next[provider] = account;
        else delete next[provider];
        return next;
      });
      keepAccount(provider, account && keep ? account : null);
    },
    [],
  );

  /** The sign-in is over: forget the account and ask again, then carry on with `next`. */
  const signInAgain = useCallback(
    (provider: ProviderId, next: Next) => {
      rememberAccount(provider, null, false);
      setError('signedOut');
      setSheet({ kind: 'signIn', provider, next });
    },
    [rememberAccount],
  );

  /** An error where the person will see it: in the drive's sheet on screen, else in the window's banner. */
  const report = useCallback(
    (error: unknown, provider: ProviderId) => {
      const kind = kindOf(error);
      if (sheetRef.current?.provider === provider) setError(kind);
      else dispatch({ type: 'DOCUMENT_FAILED', error: errorKey(kind) });
    },
    [dispatch],
  );

  /** Shows `next` unless another drive's sheet is on screen: work on one drive never takes another's place. */
  const showFor = useCallback((provider: ProviderId, next: Sheet | null) => {
    setSheet((current) => (current && current.provider !== provider ? current : next));
  }, []);

  // The first page of a drive file, for its tile on the home screen (never a protected one).
  const { document: remote, documentPassword } = services;
  const info = state.document;
  const pictured = useRef<string | null>(null);
  useEffect(() => {
    if (!binding || !remote || !info || documentPassword !== undefined || info.metadata.encrypted) return;
    const id = recentId({ provider: binding.provider, key: binding.key });
    if (pictured.current === id) return;
    pictured.current = id;
    void firstPagePicture(remote)
      .then((picture) => {
        if (!picture) return;
        saveCloudThumbnail(id, picture);
        setThumbnails(readCloudThumbnails());
      })
      .catch(() => undefined);
  }, [binding, remote, info, documentPassword]);

  /** A drive file as the app takes it in: a PDF opens (and claims Save), any other kind goes to Create PDF. */
  const fetchEntry = useCallback(
    async (provider: ProviderId, entry: Pick<Entry, 'key' | 'name'>): Promise<File | null> => {
      if (sheetRef.current?.provider === provider) setError(null);
      setActivity(provider, { kind: 'opening', provider, name: entry.name });
      try {
        const opened = await drive(provider).open(entry.key);
        // A PDF by its name or its bytes: a Word file typed a PDF was taken for one.
        const pdf = typeForName(opened.name) !== '' || looksLikePdf(new Uint8Array(opened.bytes, 0, Math.min(opened.bytes.byteLength, PDF_SNIFF_BYTES)));
        const file = new File([opened.bytes], opened.name, { type: pdf ? 'application/pdf' : '' });
        const { bytes: _bytes, ...saved } = opened;
        if (file.type === 'application/pdf') {
          pending.current.set(file, { ...saved, provider, file });
          setRecent(addCloudRecent({ provider, key: opened.key, name: opened.name, openedAt: Date.now() }));
        }
        setActivity(provider, null);
        return file;
      } catch (error) {
        setActivity(provider, null);
        if (kindOf(error) === 'signedOut') signInAgain(provider, { kind: 'recent', entry: { provider, key: entry.key, name: entry.name, openedAt: Date.now() } });
        else report(error, provider);
        return null;
      }
    },
    [drive, signInAgain, report, setActivity],
  );

  const openEntry = useCallback(
    async (provider: ProviderId, entry: Pick<Entry, 'key' | 'name'>) => {
      const file = await fetchEntry(provider, entry);
      if (!file) return;
      showFor(provider, null);
      await services.openFile(file, undefined, { recent: false });
    },
    [fetchEntry, services, showFor],
  );

  /**
   * Several at once (picked, or ticked in the sheet): each PDF opens in a tab
   * of its own, one after another; a folder ticked brings what is in it (not
   * its folders); the files that are not PDFs go to Create PDF together.
   */
  const openEntries = useCallback(
    async (provider: ProviderId, entries: readonly Pick<Entry, 'key' | 'name' | 'kind'>[]) => {
      const files: Pick<Entry, 'key' | 'name' | 'kind'>[] = entries.filter((one) => one.kind !== 'folder');
      for (const folder of entries.filter((one) => one.kind === 'folder')) {
        setActivity(provider, { kind: 'opening', provider, name: folder.name });
        try {
          const listing = await drive(provider).list(folder.key);
          files.push(...listing.entries.filter((one) => one.kind !== 'folder'));
        } catch (error) {
          setActivity(provider, null);
          if (kindOf(error) === 'signedOut') return signInAgain(provider, { kind: 'browse' });
          report(error, provider);
          return;
        }
        setActivity(provider, null);
      }
      const seen = new Set<string>();
      const unique = files.filter((one) => !seen.has(one.key) && Boolean(seen.add(one.key)));
      const others: File[] = [];
      let opened = 0;
      for (const entry of unique.slice(0, MAX_TABS * 2)) {
        if (entry.kind === 'pdf' && opened >= MAX_TABS) continue;
        const file = await fetchEntry(provider, entry);
        if (!file) continue;
        if (file.type === 'application/pdf') {
          opened += 1;
          showFor(provider, null);
          await services.openFile(file, undefined, { recent: false });
        } else others.push(file);
      }
      if (others.length > 0) {
        showFor(provider, null);
        services.dropFiles(others);
      }
      if (unique.length === 0 && entries.some((one) => one.kind === 'folder')) dispatch({ type: 'TOAST', key: 'cloud.browse.folderNothing' });
    },
    [drive, fetchEntry, services, showFor, signInAgain, report, setActivity, dispatch],
  );

  /** Asks the person, in a sheet, and waits for the choice. */
  const ask = useCallback(<T extends string>(next: Sheet): Promise<T> => {
    setSheet(next);
    return new Promise<T>((resolve) => {
      answer.current = (choice) => resolve(choice as T);
    });
  }, []);

  // Save, for a file that came from a drive: a new revision, checked against
  // the version it was opened at; a conflict is the person's to decide. Each
  // file has a claim of its own, so a tab keeps saving to its own file.
  const { claimSave } = services;
  const claim = useCallback(
    (first: Binding) => {
      const held = { current: first };
      const target: SaveTarget = {
        save: async (bytes) => {
          const bound = held.current;
          const body = wholeBuffer(bytes);
          const done = (saved: Saved) => {
            held.current = { ...saved, provider: bound.provider, file: bound.file };
            setClaimed((count) => count + 1);
            return { saved: true as const, toast: `cloud.saved.${bound.provider}` as TKey };
          };
          setActivity(bound.provider, { kind: 'saving', provider: bound.provider, name: bound.name });
          try {
            try {
              return done(await drive(bound.provider).saveRevision(bound.key, body, bound.version));
            } catch (error) {
              if (kindOf(error) !== 'conflict') throw error;
            }
            setActivity(bound.provider, null);
            const choice = await ask<'copy' | 'replace' | 'cancel'>({ kind: 'conflict', provider: bound.provider, name: bound.name });
            if (choice === 'replace') {
              setSheet(null);
              setActivity(bound.provider, { kind: 'saving', provider: bound.provider, name: bound.name });
              return done(await drive(bound.provider).saveRevision(bound.key, body, null));
            }
            if (choice === 'copy') {
              setSheet({
                kind: 'browse',
                provider: bound.provider,
                mode: 'saveAs',
                folder: bound.parentKey ? { key: bound.parentKey, name: bound.parentName ?? null } : undefined,
                name: copyName(bound.name, t('cloud.copyWord')),
              });
            } else setSheet(null);
            return { saved: false };
          } catch (error) {
            if (kindOf(error) === 'signedOut') signInAgain(bound.provider, { kind: 'save' });
            else {
              setSheet(null);
              dispatch({ type: 'DOCUMENT_FAILED', error: errorKey(kindOf(error)) });
            }
            return { saved: false };
          } finally {
            setActivity(bound.provider, null);
          }
        },
      };
      claims.set(target, held);
      claimSave(target);
    },
    [claims, claimSave, drive, ask, t, signInAgain, dispatch, setActivity],
  );

  // A drive file, once open, claims Save; its tab keeps the claim while
  // parked, and gives it back when the tab is live again.
  const openedFile = services.openedFile;
  useEffect(() => {
    const waiting = openedFile ? pending.current.get(openedFile) : undefined;
    if (!openedFile || !waiting) return;
    pending.current.delete(openedFile);
    claim(waiting);
  }, [openedFile, claim]);

  /** The live document is the drive file `saved`: a save of it goes back there. */
  const adopt = useCallback(
    (provider: ProviderId, saved: Saved, file: File | null) => {
      if (file) claim({ ...saved, provider, file });
    },
    [claim],
  );

  const saveInto = useCallback(
    async (provider: ProviderId, folderKey: string | null, name: string) => {
      const file = services.openedFile;
      setError(null);
      let bytes: Uint8Array<ArrayBuffer> | null;
      try {
        bytes = await services.bytesForSave();
      } catch {
        dispatch({ type: 'DOCUMENT_FAILED', error: 'file.saveFailed' });
        return;
      }
      if (!bytes) return;
      const body = wholeBuffer(bytes);
      const back = sheetRef.current;
      setActivity(provider, { kind: 'saving', provider, name });
      try {
        let saved: Saved;
        try {
          saved = await drive(provider).saveNew(folderKey, name, body, 'fail');
        } catch (error) {
          if (kindOf(error) !== 'nameTaken') throw error;
          setActivity(provider, null);
          const choice = await ask<'replace' | 'rename' | 'cancel'>({ kind: 'nameTaken', provider, name });
          if (choice === 'cancel') {
            setSheet(back);
            return;
          }
          setActivity(provider, { kind: 'saving', provider, name });
          saved = await drive(provider).saveNew(folderKey, name, body, choice);
        }
        adopt(provider, saved, file);
        if (saved.name !== state.document?.name) dispatch({ type: 'DOCUMENT_RENAMED', name: saved.name });
        dispatch({ type: 'DOCUMENT_SAVED' });
        dispatch({ type: 'TOAST', key: `cloud.saved.${provider}` as TKey });
        setRecent(addCloudRecent({ provider, key: saved.key, name: saved.name, openedAt: Date.now() }));
        setSheet(null);
      } catch (error) {
        if (kindOf(error) === 'signedOut') signInAgain(provider, { kind: 'saveAs' });
        else {
          setSheet((current) => current ?? back);
          report(error, provider);
        }
      } finally {
        setActivity(provider, null);
      }
    },
    [services, drive, ask, adopt, state.document, dispatch, signInAgain, report, setActivity],
  );

  const openRecentNow = useCallback((entry: CloudRecent) => void openEntry(entry.provider, entry), [openEntry]);

  const carryOn = useCallback(
    async (provider: ProviderId, next: Next, params: Record<string, string>) => {
      switch (next.kind) {
        case 'open': {
          // Google's picker: every PDF picked opens, each in a tab; a folder
          // picked opens in the sheet, to open what is in it.
          const ids = provider === 'gdrive' ? pickedIds(params) : [];
          let picked: Entry[];
          try {
            picked = ids.length > 0 ? ((await drive(provider).picked?.(ids)) ?? []) : [];
          } catch (error) {
            if (kindOf(error) === 'signedOut') return signInAgain(provider, next);
            showFor(provider, { kind: 'browse', provider, mode: 'open' });
            report(error, provider);
            return;
          }
          // A folder picked opens in the sheet below, to choose from.
          await openEntries(provider, picked.filter((entry) => entry.kind !== 'folder'));
          const folder = picked.find((entry) => entry.kind === 'folder');
          if (folder) showFor(provider, { kind: 'browse', provider, mode: 'open', folder: { key: folder.key, name: folder.name } });
          else if (!picked.some((entry) => entry.kind === 'pdf')) showFor(provider, { kind: 'browse', provider, mode: 'open' });
          return;
        }
        case 'browse':
          showFor(provider, { kind: 'browse', provider, mode: 'open' });
          return;
        case 'stay':
          showFor(provider, null);
          return;
        case 'saveAs':
          showFor(provider, { kind: 'browse', provider, mode: 'saveAs' });
          return;
        case 'pickFolder': {
          const folder = pickedIds(params)[0];
          showFor(provider, { kind: 'browse', provider, mode: 'saveAs', name: next.name });
          if (folder) await saveInto(provider, folder, next.name);
          return;
        }
        case 'recent':
          openRecentNow(next.entry);
          return;
        case 'save':
          showFor(provider, null);
          await services.saveDocument();
          return;
      }
    },
    [drive, openEntries, saveInto, openRecentNow, services, signInAgain, report, showFor],
  );

  const begin = useCallback(
    (provider: ProviderId, next: Next, stay: boolean, kind?: 'business' | 'personal') => {
      let popup: Window | undefined;
      if (!service.host.desktop) {
        try {
          popup = openSignInWindow();
        } catch (error) {
          setError(kindOf(error));
          return;
        }
        (service.host.broker as BrowserBroker).staySignedIn(provider, stay);
      }
      // One sign-in at a time (one browser answer to wait for): a new one,
      // on either drive, ends the one under way rather than waiting on it.
      const earlier = abort.current;
      earlier?.abort();
      const controller = new AbortController();
      abort.current = controller;
      signingIn.current = provider;
      setError(null);
      setActivity(provider, { kind: 'signIn', provider });
      const extra =
        provider === 'gdrive' && (next.kind === 'open' || next.kind === 'pickFolder')
          ? googlePicker(next.kind === 'open' ? 'open' : 'folder')
          : provider === 'onedrive' && kind
            ? oneDriveAccountHint(kind)
            : undefined;
      void (async () => {
        try {
          if (earlier && service.host.desktop) await service.cancelSignIn();
          const { account, params } = await service.signIn(provider, { popup, extra, signal: controller.signal });
          rememberAccount(provider, account, service.host.desktop || stay);
          setActivity(provider, null);
          await carryOn(provider, next, params);
        } catch (error) {
          // A sign-in ended by a newer one on the same drive leaves that one's activity alone.
          if (abort.current === controller || signingIn.current !== provider) setActivity(provider, null);
          // Closing the sheet cancelled it: nothing to say.
          if (abort.current === controller && !controller.signal.aborted) setError(kindOf(error));
        } finally {
          if (abort.current === controller) abort.current = null;
        }
      })();
    },
    [service, rememberAccount, carryOn, setActivity],
  );

  const signIn = useCallback(
    (provider: ProviderId, stay: boolean, kind?: 'business' | 'personal') => {
      const current = sheetRef.current;
      begin(provider, current?.kind === 'signIn' ? current.next : { kind: 'browse' }, stay, kind);
    },
    [begin],
  );

  const pickWithGoogle = useCallback(
    (purpose: 'open' | 'folder', name?: string) =>
      begin('gdrive', purpose === 'open' ? { kind: 'open' } : { kind: 'pickFolder', name: name ?? '' }, true),
    [begin],
  );

  const startOpen = useCallback(
    (provider: ProviderId) => {
      setError(null);
      // Opening a drive shows what is in it; choosing more is its own action (pickWithGoogle).
      setSheet(accounts[provider] ? { kind: 'browse', provider, mode: 'open' } : { kind: 'signIn', provider, next: { kind: 'browse' } });
    },
    [accounts],
  );

  const startSignIn = useCallback((provider: ProviderId) => {
    setError(null);
    setSheet({ kind: 'signIn', provider, next: { kind: 'stay' } });
  }, []);

  const startSaveAs = useCallback(
    (provider: ProviderId) => {
      if (!state.document) return;
      setError(null);
      setSheet(accounts[provider] ? { kind: 'browse', provider, mode: 'saveAs' } : { kind: 'signIn', provider, next: { kind: 'saveAs' } });
    },
    [accounts, state.document],
  );

  const openRecent = useCallback(
    (entry: CloudRecent) => {
      setError(null);
      if (accounts[entry.provider]) openRecentNow(entry);
      else setSheet({ kind: 'signIn', provider: entry.provider, next: { kind: 'recent', entry } });
    },
    [accounts, openRecentNow],
  );

  const signOut = useCallback(
    async (provider: ProviderId) => {
      const revoked = await service.signOut(provider).catch(() => false);
      rememberAccount(provider, null, false);
      setRecent(clearCloudRecent(provider));
      setThumbnails(readCloudThumbnails());
      if (sheetRef.current?.provider === provider) setSheet(null);
      const key = provider === 'gdrive' ? (revoked ? 'cloud.signedOut.gdrive' : 'cloud.signedOut.gdriveLocal') : 'cloud.signedOut.onedrive';
      dispatch({ type: 'TOAST', key });
    },
    [service, rememberAccount, dispatch],
  );

  const cancel = useCallback(() => {
    // Closing a drive's sheet ends that drive's sign-in, not another's.
    const closing = sheetRef.current?.provider;
    if (!closing || signingIn.current === closing) {
      abort.current?.abort();
      abort.current = null;
      void service.cancelSignIn();
      setActivities((current) => Object.fromEntries(Object.entries(current).filter(([, doing]) => doing.kind !== 'signIn')));
    }
    answer.current?.('cancel');
    answer.current = null;
    setError(null);
    setSheet(null);
  }, [service]);

  const resolve = useCallback((choice: string) => {
    const pick = answer.current;
    answer.current = null;
    pick?.(choice);
  }, []);

  const clearRecent = useCallback(() => {
    setRecent(clearCloudRecent());
    setThumbnails({});
  }, []);

  const staying = useCallback(
    (provider: ProviderId) => !service.host.desktop && (service.host.broker as BrowserBroker).isStaying(provider),
    [service],
  );

  const api = useMemo<CloudApi>(
    () => ({
      providers: offered,
      desktop: service.host.desktop,
      accounts,
      recent,
      thumbnails,
      binding,
      sheet,
      activity,
      error,
      startOpen,
      startSignIn,
      startSaveAs,
      openRecent,
      clearRecent,
      signIn,
      pickWithGoogle,
      signOut,
      openEntry,
      openEntries,
      saveInto,
      resolveConflict: resolve,
      resolveNameTaken: resolve,
      signInAgain,
      cancel,
      drive,
      staying,
    }),
    [
      offered,
      service,
      accounts,
      recent,
      thumbnails,
      binding,
      sheet,
      activity,
      error,
      startOpen,
      startSignIn,
      startSaveAs,
      openRecent,
      clearRecent,
      signIn,
      pickWithGoogle,
      signOut,
      openEntry,
      openEntries,
      saveInto,
      resolve,
      signInAgain,
      cancel,
      drive,
      staying,
    ],
  );

  return <CloudContext.Provider value={api}>{children}</CloudContext.Provider>;
}
