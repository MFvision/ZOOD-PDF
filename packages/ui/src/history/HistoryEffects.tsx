import { useEffect, useRef, useState } from 'react';
import { History, X } from 'lucide-react';
import { currentWindowLabel, isTauriHost, keepNativePath, openRecentFile } from '../core/host-tauri';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import { hasUnsavedEdits } from '../state/appReducer';
import { useAppState, useServices } from '../state/AppContext';
import { readJson, writeJson } from '../state/preferences';
import { useSettings } from '../state/settings';
import { clearRecovery, dropRecovery, isSaved, keepRecovery, pendingRecoveries, recoveryKey, RUN } from './versions';
import type { Recovery } from './versions';

/**
 * Settings › History and Settings › General, while the app runs:
 *
 * - Autosave: every one or five minutes, a copy of each document with
 *   unsaved work is kept on this device (`versions.ts`), and taken away
 *   once it is saved or closed. After a crash the next start offers it back.
 * - "When the app opens: Last documents": the documents open when the app
 *   closed (the desktop knows where each is) open again.
 */

const SESSION_KEY = 'zood.session';

/** The main window's: a document window is one file, and not the session. */
const isMainWindow = () => (currentWindowLabel() ?? 'main') === 'main';

type Offer = Recovery & { tab: string; at: number };

export function HistoryEffects() {
  const state = useAppState();
  const services = useServices();
  const settings = useSettings();
  const { t } = useI18n();
  const [offers, setOffers] = useState<Offer[]>([]);
  const stateRef = useRef(state);
  const servicesRef = useRef(services);
  useEffect(() => {
    stateRef.current = state;
    servicesRef.current = services;
  });

  // What the last run left behind: offered once, at start.
  useEffect(() => {
    if (!isMainWindow()) return;
    void pendingRecoveries()
      .then((found) => setOffers(found.filter((offer) => !offer.tab.startsWith(`${RUN}:`))))
      .catch(() => undefined);
  }, []);

  // Autosave.
  useEffect(() => {
    if (!settings.autosave) return;
    const timer = setInterval(() => {
      const { document } = stateRef.current;
      const { activeTab, canUndo, bytesForSave } = servicesRef.current;
      if (!document || activeTab === null) return;
      const name = document.name;
      const path = servicesRef.current.tabs.find((tab) => tab.key === activeTab)?.path;
      const changed = hasUnsavedEdits(stateRef.current) || canUndo;
      void (async () => {
        if (!changed) return dropRecovery(recoveryKey(activeTab));
        const bytes = await bytesForSave();
        if (!bytes) return;
        if (await isSaved(activeTab, bytes)) return dropRecovery(recoveryKey(activeTab));
        await keepRecovery(recoveryKey(activeTab), { name, bytes: bytes.slice().buffer, path });
      })().catch(() => undefined);
    }, settings.autosaveMinutes * 60_000);
    return () => clearInterval(timer);
  }, [settings.autosave, settings.autosaveMinutes]);

  // A tab closed is work the person chose to leave: its copy goes.
  const tabKeys = services.tabs.map((tab) => tab.key).join(',');
  const previousKeys = useRef<number[]>([]);
  useEffect(() => {
    const now = services.tabs.map((tab) => tab.key);
    for (const gone of previousKeys.current.filter((key) => !now.includes(key))) void dropRecovery(recoveryKey(gone));
    previousKeys.current = now;
    // The session, for "Last documents": the files the desktop can find again.
    if (isMainWindow() && isTauriHost()) writeJson(SESSION_KEY, services.tabs.filter((tab) => tab.path).map((tab) => tab.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by the tabs' keys
  }, [tabKeys]);

  // Last documents, once, at start, unless a file was opened from outside.
  useEffect(() => {
    if (settings.startWith !== 'reopen' || !isTauriHost() || !isMainWindow()) return;
    const names = readJson<unknown>(SESSION_KEY, []);
    if (!Array.isArray(names) || names.length === 0) return;
    const timer = setTimeout(() => {
      if (servicesRef.current.tabs.length > 0) return;
      void (async () => {
        for (const name of names.filter((n): n is string => typeof n === 'string').slice(0, 8)) {
          const picked = await openRecentFile(name).catch(() => null);
          if (picked) await servicesRef.current.openFile(keepNativePath(new File([picked.bytes], picked.name, { type: 'application/pdf' }), picked.path ?? undefined));
        }
      })();
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- at start only
  }, []);

  if (offers.length === 0) return null;
  const first = offers[0]!;
  const restore = async () => {
    setOffers((list) => list.slice(1));
    await services.openFile(keepNativePath(new File([first.bytes], first.name, { type: 'application/pdf' }), first.path), undefined, { recent: false });
    await dropRecovery(first.tab);
  };
  const discard = async () => {
    setOffers([]);
    await clearRecovery();
  };
  return (
    <div className="banner banner-recovery" role="alert">
      <Icon of={History} />
      <span>{offers.length > 1 ? t('recovery.many', { name: first.name, n: offers.length - 1 }) : t('recovery.one', { name: first.name })}</span>
      <button type="button" className="prefs-button" onClick={() => void restore()}>
        {t('recovery.restore')}
      </button>
      <button type="button" className="prefs-link" onClick={() => void discard()}>
        {t('recovery.discard')}
      </button>
      <button type="button" className="icon-btn" aria-label={t('error.dismiss')} onClick={() => setOffers([])}>
        <Icon of={X} />
      </button>
    </div>
  );
}
