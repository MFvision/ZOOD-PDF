import { Cloud, FileText } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import { accountWho, isolate } from './CloudBrowser';
import { useCloud } from './CloudContext';
import { recentId } from './store';

/**
 * The home screen's cloud drives, beside the files on this device: each drive
 * this build offers, who is signed in to it (as this device remembers — the
 * drive is not asked), Open… and Sign out; then the drive files opened
 * lately, as pages, which reopen from the drive. Not drawn at all when the
 * build offers no drive.
 */
export function CloudHome() {
  const cloud = useCloud();
  const t = useT();
  if (cloud.providers.length === 0) return null;
  return (
    <section className="home-section" aria-labelledby="home-cloud">
      <div className="home-section-header">
        <h2 id="home-cloud">{t('cloud.home.title')}</h2>
        {cloud.recent.length > 0 && (
          <button type="button" className="link-btn" onClick={cloud.clearRecent}>
            {t('cloud.recent.clear')}
          </button>
        )}
      </div>
      <ul className="cloud-drives">
        {cloud.providers.map((provider) => {
          const account = cloud.accounts[provider];
          const drive = t(`cloud.name.${provider}`);
          return (
            <li key={provider} className="cloud-drive">
              <span className="cloud-drive-icon">
                <Icon of={Cloud} size={20} />
              </span>
              <span className="cloud-drive-text">
                <strong>{drive}</strong>
                <span>{account ? t('cloud.account.as', { who: accountWho(account, t) }) : t('cloud.account.none')}</span>
              </span>
              <span className="cloud-drive-actions">
                {account && (
                  <button
                    type="button"
                    className="link-btn"
                    aria-label={t('cloud.signOut.label', { drive })}
                    title={t(provider === 'onedrive' ? 'cloud.signOutNote.onedrive' : 'cloud.signOutNote.gdrive')}
                    onClick={() => void cloud.signOut(provider)}
                  >
                    {t('cloud.signOut')}
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn icon-btn-labeled"
                  aria-label={t(provider === 'onedrive' ? 'cloud.menu.open.onedrive' : 'cloud.menu.open.gdrive')}
                  onClick={() => cloud.startOpen(provider)}
                >
                  {t('cloud.open')}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {cloud.recent.length > 0 && (
        <ul className="recent-grid" aria-label={t('cloud.home.title')}>
          {cloud.recent.map((entry) => {
            const drive = t(`cloud.name.${entry.provider}`);
            const picture = cloud.thumbnails[recentId(entry)];
            return (
              <li key={recentId(entry)}>
                <button
                  type="button"
                  className="recent-item"
                  title={t('cloud.recent.open', { name: isolate(entry.name), drive })}
                  onClick={() => cloud.openRecent(entry)}
                >
                  <span className="recent-page">
                    {picture ? <img src={picture} alt="" /> : <Icon of={FileText} size={28} />}
                    <span className="cloud-badge" aria-hidden="true">
                      <Icon of={Cloud} size={12} />
                    </span>
                  </span>
                  <span className="recent-name" dir="auto">
                    {entry.name.replace(/\.pdf$/i, '')}
                  </span>
                  <span className="sr-only">{t('cloud.recent.in', { drive })}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="home-note">{t(cloud.desktop ? 'cloud.home.noteDesktop' : 'cloud.home.noteWeb')}</p>
    </section>
  );
}
