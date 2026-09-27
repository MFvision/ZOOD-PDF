import { useRef, useState } from 'react';
import { FilePlus2, FolderOpen, Plus, ScanText, ShieldCheck } from 'lucide-react';
import { CloudHome } from '../cloud/CloudHome';
import { useCloud } from '../cloud/CloudContext';
import { ContextMenu } from '../components/ContextMenu';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import { useAppDispatch, useServices } from '../state/AppContext';
import { ToolCards } from '../tools/ToolCards';
import { AiCard } from './AiCard';
import { HeroCards } from './HeroCards';
import { HomeSearch } from './HomeSearch';
import { HomeSidebar } from './HomeSidebar';
import type { HomeView } from './HomeSidebar';
import { RecentList } from './RecentList';
import { StarredView } from './StarredView';
import { TagsView } from './TagsView';
import { useLibraryIndex } from './useLibraryIndex';

/**
 * The home screen: glass panels over a soft gradient. A sidebar of places
 * and tools at the leading edge; a top bar with the search field and the
 * "+" menu; the headline over six action cards; the recent files as a row
 * of pages; and the AI Assistant docked at the trailing edge. The other
 * places — Recents, Starred, Tags, Clouds — take the middle when chosen.
 */
export function HomeScreen() {
  const { t, dir } = useI18n();
  const dispatch = useAppDispatch();
  const { requestOpenFile, requestCreateFiles } = useServices();
  const cloud = useCloud();
  const index = useLibraryIndex();
  const [view, setView] = useState<HomeView>('home');
  const [addMenu, setAddMenu] = useState<{ at: { x: number; y: number }; from: HTMLElement } | null>(null);
  const question = useRef<HTMLTextAreaElement>(null);
  const tools = useRef<HTMLElement>(null);

  const clouds = cloud.providers.length > 0;
  const shown: HomeView = view === 'clouds' && !clouds ? 'home' : view;

  const addItems = [
    { id: 'open', label: t('home.add.open'), icon: <Icon of={FolderOpen} size={14} />, onSelect: requestOpenFile },
    { id: 'create', label: t('home.add.create'), icon: <Icon of={FilePlus2} size={14} />, onSelect: requestCreateFiles },
    {
      id: 'scan',
      label: t('home.add.scan'),
      icon: <Icon of={ScanText} size={14} />,
      // A scanned PDF: opened with Scan & OCR ready to read it.
      onSelect: () => {
        dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'ocr' });
        requestOpenFile();
      },
    },
  ];

  return (
    <div className="home" data-view={shown}>
      <HomeSidebar view={shown} onView={setView} clouds={clouds} index={index} />
      <div className="home-main">
        <div className="home-topbar glass">
          <HomeSearch index={index} />
          <button
            type="button"
            className="icon-btn icon-btn-primary home-add"
            aria-label={t('home.add')}
            title={t('home.add')}
            aria-haspopup="menu"
            aria-expanded={addMenu !== null}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              setAddMenu({ at: { x: dir === 'rtl' ? box.right - 236 : box.left, y: box.bottom + 4 }, from: event.currentTarget });
            }}
          >
            <Icon of={Plus} size={18} />
          </button>
          <ContextMenu at={addMenu?.at ?? null} label={t('home.add')} items={addItems} returnTo={addMenu?.from} onClose={() => setAddMenu(null)} />
        </div>
        <div className="home-body">
          <div className="home-content">
            {shown === 'home' && (
              <>
                <header className="home-hero">
                  <h1>{t('home.headline')}</h1>
                  <p>{t('home.subline')}</p>
                </header>
                <HeroCards
                  onAi={() => question.current?.focus()}
                  onMore={() => {
                    tools.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    tools.current?.querySelector<HTMLElement>('.tool-card')?.focus({ preventScroll: true });
                  }}
                />
                <RecentList layout="row" onSeeAll={() => setView('recents')} />
                <CloudHome />
                <section ref={tools} className="home-section" aria-labelledby="home-tools">
                  <div className="home-section-header">
                    <h2 id="home-tools">{t('home.tools')}</h2>
                  </div>
                  <ToolCards layout="grid" />
                </section>
              </>
            )}
            {shown === 'recents' && <RecentList layout="grid" />}
            {shown === 'starred' && <StarredView index={index} />}
            {shown === 'tags' && <TagsView index={index} />}
            {shown === 'clouds' && <CloudHome />}
            <p className="home-privacy">
              <Icon of={ShieldCheck} size={14} />
              <span>{t(clouds ? 'home.privacyCloud' : 'home.privacy')}</span>
            </p>
          </div>
          <AiCard ref={question} />
        </div>
      </div>
    </div>
  );
}
