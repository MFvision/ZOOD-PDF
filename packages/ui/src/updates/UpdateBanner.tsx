import { useEffect } from 'react';
import { Download, Loader } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import {
  checkForUpdate,
  dismissUpdate,
  installUpdate,
  scheduleStartupCheck,
  useUpdateState,
} from './updates';

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

/** Help › About: the version check, one button and what it found. */
export function UpdateCheck() {
  const t = useT();
  const update = useUpdateState();
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
      {update.phase === 'available' ? (
        <button
          type="button"
          className="icon-btn icon-btn-labeled icon-btn-primary"
          onClick={() => void installUpdate()}
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
