import { useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import { Download, Loader } from 'lucide-react';
import { useConfirm } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import { hasUnsavedEdits } from '../state/appReducer';
import { useAppState, useServices } from '../state/AppContext';
import { reportOpen, reportUnsaved, unsavedEverywhere, unsavedHere } from './unsaved';
import {
  checkForUpdate,
  dismissUpdate,
  installUpdate,
  scheduleStartupCheck,
  useUpdateState,
} from './updates';

/**
 * "Update now", asking first when documents in any window have unsaved
 * changes: the update restarts the app, and they would be lost. Render the
 * returned `dialog` once beside the button.
 */
export function useInstallUpdate(): { install: () => void; dialog: ReactNode } {
  const t = useT();
  const { ask, dialog } = useConfirm();
  const install = useCallback(() => {
    void (async () => {
      const count = await unsavedEverywhere();
      if (count > 0) {
        const go = await ask({
          title: t('updates.unsavedTitle'),
          body: t(count === 1 ? 'updates.unsavedOne' : 'updates.unsavedMany', { count }),
          action: t('updates.installAnyway'),
          icon: Download,
        });
        if (!go) return;
      }
      await installUpdate();
    })();
  }, [ask, t]);
  return { install, dialog };
}

/** Tells the host how many of this window's documents are open, and how many have unsaved changes. */
function useReportUnsaved(): void {
  const state = useAppState();
  const { tabs, activeTab } = useServices();
  const count = unsavedHere(tabs, activeTab, state.document !== null && hasUnsavedEdits(state));
  useEffect(() => reportUnsaved(count), [count]);
  const open = Math.max(tabs.length, state.document !== null ? 1 : 0);
  useEffect(() => reportOpen(open), [open]);
}

/**
 * "A new version is ready": shown when a check found one, until the person
 * installs it or says later. Nothing installs without their click.
 */
export function UpdateBanner() {
  const t = useT();
  const update = useUpdateState();
  const { install, dialog } = useInstallUpdate();
  useReportUnsaved();
  useEffect(() => scheduleStartupCheck(), []);

  if (update.phase === 'installing') {
    return (
      <div className="banner" role="status">
        <Icon of={Loader} className="spin" />
        <span>
          {update.progress === null
            ? t('updates.installing')
            : t('updates.downloading', { percent: Math.round(update.progress * 100) })}
        </span>
      </div>
    );
  }
  if (update.phase !== 'available' || !update.info || update.dismissed) return <>{dialog}</>;
  return (
    <div className="banner update-banner" role="status">
      {dialog}
      <Icon of={Download} />
      <span>
        <strong>{t('updates.available', { version: update.info.version })}</strong>{' '}
        {t('updates.availableHint')}
      </span>
      <button type="button" className="icon-btn icon-btn-labeled" onClick={dismissUpdate}>
        {t('updates.later')}
      </button>
      <button
        type="button"
        className="icon-btn icon-btn-labeled icon-btn-primary"
        onClick={install}
      >
        {t('updates.install')}
      </button>
    </div>
  );
}

/** Help › About: the version check, one button and what it found. */
export function UpdateCheck() {
  const t = useT();
  const update = useUpdateState();
  const { install, dialog } = useInstallUpdate();
  const busy = update.phase === 'checking' || update.phase === 'installing';
  const said =
    update.phase === 'checking'
      ? t('updates.checking')
      : update.phase === 'latest'
        ? t('updates.latest')
        : update.phase === 'failed'
          ? t('updates.failed')
          : update.phase === 'available' && update.info
            ? t('updates.available', { version: update.info.version })
            : update.phase === 'installing'
              ? t('updates.installing')
              : null;
  return (
    <div className="about-update">
      {dialog}
      {update.phase === 'available' ? (
        <button
          type="button"
          className="icon-btn icon-btn-labeled icon-btn-primary"
          onClick={install}
        >
          {t('updates.install')}
        </button>
      ) : (
        <button
          type="button"
          className="icon-btn icon-btn-labeled"
          disabled={busy}
          onClick={() => void checkForUpdate()}
        >
          {t('updates.check')}
        </button>
      )}
      {said && <p role="status">{said}</p>}
    </div>
  );
}
