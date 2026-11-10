import { useEffect, useRef, useState } from 'react';
import { History, X } from 'lucide-react';
import { currentWindowLabel, keepNativePath } from '../core/host-tauri';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import { hasUnsavedEdits } from '../state/appReducer';
import { useAppState, useServices } from '../state/AppContext';
import { useSettings } from '../state/settings';
import { clearRecovery, dropRecovery, isSaved, keepRecovery, pendingRecoveries, recoveryKey, RUN } from './versions';
import type { Recovery } from './versions';

/**
 * Settings › History and Settings › General, while the app runs:
 *
 * - Autosave: every one or five minutes, a copy of each document with
 *   unsaved work is kept on this device (`versions.ts`), and taken away
 *   once it is saved or closed. After a crash the next start offers it back.
 * ("When the app opens: Last documents" is the session's: `state/AppContext.tsx`
 *   and `src-tauri/src/session.rs`.)
 */

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
      const tab = servicesRef.current.tabs.find((each) => each.key === activeTab);
      const path = tab?.path;
      // A tab can be unsaved with nothing to undo: work brought back from a
      // recovery copy, a combined or extracted file not saved anywhere yet.
      const changed = hasUnsavedEdits(stateRef.current) || canUndo || tab?.edited === true;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by the tabs' keys
  }, [tabKeys]);

  if (offers.length === 0) return null;
  const first = offers[0]!;
  const restore = async () => {
    setOffers((list) => list.slice(1));
    // Unsaved work, brought back: its tab says so and closing it asks first.
    // Opened as if saved, it closed without a word and the work was gone for
    // good, its copy already dropped below (break-zood, files-ui).
    await services.openFile(keepNativePath(new File([first.bytes], first.name, { type: 'application/pdf' }), first.path), undefined, {
      recent: false,
      unsaved: true,
    });
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
