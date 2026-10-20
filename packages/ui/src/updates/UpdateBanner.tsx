import { useEffect } from 'react';
import { Download, Loader } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import { dismissUpdate, installUpdate, scheduleStartupCheck, useUpdateState } from './updates';

/**
 * "A new version is ready": shown when a check found one, until the person
 * installs it or says later. Nothing installs without their click.
 */
export function UpdateBanner() {
  const t = useT();
  const update = useUpdateState();
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
  if (update.phase !== 'available' || !update.info || update.dismissed) return null;
  return (
    <div className="banner update-banner" role="status">
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
        onClick={() => void installUpdate()}
      >
        {t('updates.install')}
      </button>
    </div>
  );
}
