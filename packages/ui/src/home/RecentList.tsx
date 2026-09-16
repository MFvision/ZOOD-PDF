import { FileText } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import { useServices } from '../state/AppContext';

export function RecentList() {
  const t = useT();
  const { recent, requestOpenFile, clearRecent } = useServices();
  return (
    <section className="home-section" aria-labelledby="home-recent">
      <h2>
        <span id="home-recent">{t('home.recent')}</span>
        {recent.length > 0 && (
          <button type="button" className="icon-btn icon-btn-labeled" onClick={clearRecent}>
            {t('home.recentClear')}
          </button>
        )}
      </h2>
      {recent.length === 0 ? (
        <p className="recent-empty">{t('home.recentEmpty')}</p>
      ) : (
        <ul className="recent-list">
          {recent.map((name) => (
            <li key={name}>
              <button type="button" className="recent-item" onClick={requestOpenFile} title={t('home.recentOpen', { name })}>
                <Icon of={FileText} />
                <span dir="auto">{name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="home-note">{t('home.recentHint')}</p>
    </section>
  );
}
