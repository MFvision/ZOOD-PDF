import { FolderOpen, ShieldCheck } from 'lucide-react';
import { APP_ICON } from '../components/appIcon';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import { useServices } from '../state/AppContext';
import { ToolCards } from '../tools/ToolCards';
import { RecentList } from './RecentList';

/**
 * The document chooser the app opens on, after the system's document apps: a
 * large title, the files you had open as pages in a grid — the first tile
 * opens a new one or takes a drop — and every tool below as a gallery.
 */
export function HomeScreen() {
  const t = useT();
  const { requestOpenFile } = useServices();
  return (
    <div className="home">
      <div className="home-inner">
        <header className="home-hero">
          <img className="home-icon" src={APP_ICON} alt="" width={64} height={64} />
          <div className="home-hero-text">
            <h1>{t('app.name')}</h1>
            <p>{t('app.tagline')}</p>
          </div>
          <button type="button" className="icon-btn icon-btn-primary home-open" onClick={requestOpenFile}>
            <Icon of={FolderOpen} />
            <span>{t('file.open')}</span>
          </button>
        </header>
        <RecentList />
        <section className="home-section" aria-labelledby="home-tools">
          <div className="home-section-header">
            <h2 id="home-tools">{t('home.tools')}</h2>
          </div>
          <ToolCards layout="grid" />
        </section>
        <p className="home-privacy">
          <Icon of={ShieldCheck} size={14} />
          <span>{t('home.privacy')}</span>
        </p>
      </div>
    </div>
  );
}
