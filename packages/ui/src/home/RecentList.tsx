import { FileText } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import { useServices } from '../state/AppContext';
import { readRecentThumbnails } from '../state/recent';
import { DropZone } from './DropZone';

/**
 * Recent files as a grid of pages, the open-or-drop tile first. Only the name
 * and a small picture of the first page are kept, so choosing one asks for the
 * file again (a browser cannot reopen a file by itself).
 */
export function RecentList() {
  const t = useT();
  const { recent, requestOpenFile, clearRecent } = useServices();
  const thumbnails = readRecentThumbnails();
  return (
    <section className="home-section" aria-labelledby="home-recent">
      <div className="home-section-header">
        <h2 id="home-recent">{t('home.recent')}</h2>
        {recent.length > 0 && (
          <button type="button" className="link-btn" onClick={clearRecent}>
            {t('home.recentClear')}
          </button>
        )}
      </div>
      <ul className="recent-grid">
        <li>
          <DropZone />
        </li>
        {recent.map((name) => (
          <li key={name}>
            <button type="button" className="recent-item" onClick={requestOpenFile} title={t('home.recentOpen', { name })}>
              <span className="recent-page">
                {thumbnails[name] ? (
                  <img src={thumbnails[name]} alt="" />
                ) : (
                  <Icon of={FileText} size={28} />
                )}
              </span>
              <span className="recent-name" dir="auto">
                {name.replace(/\.pdf$/i, '')}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="home-note">{recent.length === 0 ? t('home.recentEmpty') : t('home.recentHint')}</p>
    </section>
  );
}
