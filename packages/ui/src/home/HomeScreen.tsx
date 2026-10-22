import { useEffect, useRef, useState } from 'react';
import { FilePlus2, FolderOpen, Plus, ScanText, ShieldCheck } from 'lucide-react';
import { CloudHome } from '../cloud/CloudHome';
import { useCloud } from '../cloud/CloudContext';
import { ContextMenu } from '../components/ContextMenu';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { ToolCards } from '../tools/ToolCards';
import { ToolGallery } from '../tools/ToolGallery';
import { Popover } from '../components/Popover';
import { AiCard } from './AiCard';
import { TodayCard } from '../ask/TodayCard';
import { RemoteHomeButton } from '../remote/RemoteLayer';
import { HeroCards } from './HeroCards';
import { FoldersView } from './FoldersView';
import { onHomeView, takeHomeView } from './homeView';
import { HomeSearch } from './HomeSearch';
import { HomeSidebar } from './HomeSidebar';
import type { HomeView } from './HomeSidebar';
import { RecentList } from './RecentList';
import { StarredView } from './StarredView';
import { TagsView } from './TagsView';
import { useLibraryIndex } from './useLibraryIndex';
import { Greeting, TopGreeting } from './Greeting';
import { useSettings } from '../state/settings';
import { useStarred } from '../state/starred';
import { useWorkbench } from '../shell/workbench';

/**
 * The home screen: glass panels over a soft gradient. A sidebar of places
 * and tools at the leading edge; a top bar with the search field and the
 * "+" menu; the headline over six action cards; the recent files as a row
 * of pages; and the AI Assistant docked at the trailing edge. The other
 * places — Recents, Starred, Tags, Folders — take the middle when chosen.
 */
export function HomeScreen() {
  const { t, dir } = useI18n();
  const dispatch = useAppDispatch();
  const state = useAppState();
  const { requestOpenFile, requestCreateFiles } = useServices();
  const cloud = useCloud();
  const index = useLibraryIndex();
  const [view, setView] = useState<HomeView>(() => takeHomeView() ?? 'home');
  useEffect(
    () =>
      onHomeView((asked) => {
        takeHomeView();
        setView(asked);
      }),
    [],
  );
  const [addMenu, setAddMenu] = useState<{ at: { x: number; y: number }; from: HTMLElement } | null>(null);
  const question = useRef<HTMLTextAreaElement>(null);
  const tools = useRef<HTMLElement>(null);
  const [moreFrom, setMoreFrom] = useState<HTMLElement | null>(null);
  const settings = useSettings();
  const starred = useStarred();
  // The Workbench look's plain home: recent files as a table.
  const workbench = useWorkbench();

  // The AI side panel is showing beside the home screen (as Shell.tsx decides).
  const aiPanel =
    state.rightPane.open && state.rightPane.activeTool === 'ai' && !(state.view === 'viewer' && state.homeShown);
  const aiCard = !aiPanel && !settings.hiddenHomeSections.includes('assistant');

  const clouds = cloud.providers.length > 0;
  const shown: HomeView = view;

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
      <HomeSidebar view={shown} onView={setView} index={index} />
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
          <RemoteHomeButton />
          <TopGreeting />
          <ContextMenu at={addMenu?.at ?? null} label={t('home.add')} items={addItems} returnTo={addMenu?.from} onClose={() => setAddMenu(null)} />
        </div>
        <div className="home-body">
          <div className="home-content">
            {shown === 'home' && (
              <>
                <Greeting />
                {/* Deadlines found in the Library's documents; nothing when there are none. */}
                <TodayCard index={index} />
                {/* Settings › Home screen: the sections shown, in the person's order. */}
                {settings.homeSections
                  .filter((section) => !settings.hiddenHomeSections.includes(section))
                  .map((section) => {
                    switch (section) {
                      case 'actions':
                        return (
                          <HeroCards
                            key={section}
                            onAi={() => {
                              if (aiCard) question.current?.focus();
                              else if (aiPanel) document.querySelector<HTMLTextAreaElement>('.inspector textarea')?.focus();
                              else dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'ai' });
                            }}
                            onMore={(card) => setMoreFrom((open) => (open ? null : card))}
                          />
                        );
                      case 'recent':
                        return <RecentList key={section} layout={workbench ? 'table' : 'row'} onSeeAll={() => setView('recents')} />;
                      case 'starred':
                        return starred.length > 0 ? (
                          <section key={section} className="home-section" aria-labelledby="home-starred">
                            <div className="home-section-header">
                              <h2 id="home-starred">{t('home.starred')}</h2>
                            </div>
                            <StarredView index={index} />
                          </section>
                        ) : null;
                      case 'clouds':
                        return <CloudHome key={section} />;
                      case 'tools':
                        return (
                          <section key={section} ref={tools} className="home-section" aria-labelledby="home-tools">
                            <div className="home-section-header">
                              <h2 id="home-tools">{t('home.tools')}</h2>
                            </div>
                            <ToolCards layout="grid" />
                          </section>
                        );
                      default:
                        return null;
                    }
                  })}
              </>
            )}
            {shown === 'recents' && <RecentList layout="grid" />}
            {shown === 'starred' && <StarredView index={index} />}
            {shown === 'tags' && <TagsView index={index} />}
            {shown === 'folders' && <FoldersView index={index} />}
            <p className="home-privacy">
              <Icon of={ShieldCheck} size={14} />
              <span>{t(clouds ? 'home.privacyCloud' : 'home.privacy')}</span>
            </p>
          </div>
          {aiCard && <AiCard ref={question} />}
          {/* More: every tool, from the card. */}
          <Popover anchor={moreFrom} open={moreFrom !== null} onClose={() => setMoreFrom(null)} label={t('shell.allTools')} className="tool-gallery-popover">
            <ToolGallery
              onChoose={(tool) => {
                setMoreFrom(null);
                dispatch({ type: 'SET_ACTIVE_TOOL', tool });
              }}
            />
          </Popover>
        </div>
      </div>
    </div>
  );
}
