import { useT } from '../i18n/useT';
import { ToolCards } from '../tools/ToolCards';
import { CloudButtons } from './CloudButtons';
import { DropZone } from './DropZone';
import { RecentList } from './RecentList';

export function HomeScreen() {
  const t = useT();
  return (
    <div className="home">
      <div className="home-inner">
        <header className="home-hero">
          <h1>{t('app.name')}</h1>
          <p>{t('app.tagline')}</p>
        </header>
        <section className="home-section" aria-labelledby="home-open">
          <h2 id="home-open">{t('home.open')}</h2>
          <DropZone />
          <CloudButtons />
          <p className="home-note">{t('home.privacy')}</p>
        </section>
        <RecentList />
        <section className="home-section" aria-labelledby="home-tools">
          <h2 id="home-tools">{t('home.tools')}</h2>
          <ToolCards layout="grid" />
        </section>
      </div>
    </div>
  );
}
